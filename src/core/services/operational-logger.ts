import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Client } from "pg";
import type { AppSettings } from "../../config";
import type { InboundMessage, RouteDecision } from "../../domain/contracts";

type TerminalPhase = "IN" | "MEM" | "ROUTE" | "FLOW" | "OUT" | "END";

interface LogError {
  owner: string;
  type: string;
  detail: string;
  stage: string;
  impact: string;
}

interface BlockPayload {
  title: string;
  data: Record<string, unknown>;
}

interface FileSlot {
  index: number;
  path: string;
  mtimeMs: number;
  lineCount: number;
}

interface PostgresClientLike {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

interface OperationalLoggerDependencies {
  createPostgresClient?: (queryTimeoutMs: number) => PostgresClientLike;
}

interface RunStartEntry {
  runId: string;
  correlationId: string;
  sessionId: string;
  parentRunId?: string;
  startedAt: string;
  colorCode: number;
  origin: Record<string, string>;
  input: Record<string, unknown>;
}

interface RunBlockEntry {
  runId: string;
  seq: number;
  title: string;
  createdAt: string;
  data: Record<string, unknown>;
  isError?: boolean;
}

interface RunEndEntry {
  runId: string;
  seq: number;
  createdAt: string;
  status: string;
  summary: string;
  result: string;
  elapsedMs: number;
  error?: LogError;
}

interface SystemEntry {
  phase: "system_event" | "system_error";
  title: string;
  timestamp: string;
  payload: Record<string, unknown>;
  isError: boolean;
}

const BRIGHT_SEPARATOR_COLORS = [92, 93, 94, 95, 96] as const;
const RED_COLOR = "\u001b[31m";
const RESET_COLOR = "\u001b[0m";
const NO_VALUE = "n/a";
const MAX_DEPTH = 12;
const POSTGRES_RUNS_TABLE = "operational_log_runs";
const POSTGRES_ENTRIES_TABLE = "operational_log_entries";

export class OperationalLogger {
  private readonly baseFilePath: string;
  private readonly maxFiles: number;
  private readonly maxLinesPerFile: number;
  private readonly postgresSchema: string | null;
  private readonly createPostgresClientFactory: (queryTimeoutMs: number) => PostgresClientLike;
  private initialized = false;
  private activeIndex = 0;
  private activePath: string;
  private activeLineCount = 0;
  private writeQueue = Promise.resolve();
  private postgresTablesReady = false;
  private postgresTablesTask: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly settings: AppSettings,
    deps: OperationalLoggerDependencies = {}
  ) {
    this.baseFilePath = resolve(this.settings.logging.directory, this.settings.logging.fileName);
    this.activePath = this.baseFilePath;
    this.maxFiles = Math.max(1, this.settings.logging.maxFiles);
    this.maxLinesPerFile = Math.max(50, this.settings.logging.maxLinesPerFile);
    this.postgresSchema = this.usesPostgresBackend()
      ? assertIdentifier(this.settings.trace.postgres.schema, "operational log schema")
      : null;
    this.createPostgresClientFactory = deps.createPostgresClient ?? ((queryTimeoutMs) => this.createPostgresClient(queryTimeoutMs));
  }

  async logStartup(extra: Record<string, unknown> = {}): Promise<void> {
    const payload = {
      event: "app_started",
      service_name: this.settings.app.name,
      environment: this.settings.app.env,
      host: this.settings.app.host,
      port: this.settings.app.port,
      log_backend: this.settings.logging.backend,
      log_to_console: this.settings.logging.consoleEnabled,
      log_to_file: this.settings.logging.fileEnabled,
      log_file_path: this.settings.logging.fileEnabled ? this.baseFilePath : "disabled",
      log_postgres_schema: this.usesPostgresBackend() ? this.postgresSchema : "disabled",
      ...extra
    };

    if (this.settings.logging.consoleEnabled) {
      console.info(JSON.stringify(payload));
    }

    await this.writeSystemEntry({
      phase: "system_event",
      title: "SYSTEM EVENT",
      timestamp: new Date().toISOString(),
      payload,
      isError: false
    });
  }

  async logSystemError(stage: string, owner: string, error: unknown, extra: Record<string, unknown> = {}): Promise<void> {
    const capturedError = toLogError(stage, owner, error, "request_failed");
    const sanitizedExtra = sanitizeForLog(extra) as Record<string, unknown>;
    const payload = {
      event: "captured_error",
      ...capturedError,
      ...sanitizedExtra
    };

    if (this.settings.logging.consoleEnabled) {
      console.error(`${RED_COLOR}[ERROR] ${capturedError.stage} ${capturedError.owner} ${capturedError.type}: ${capturedError.detail}${RESET_COLOR}`);
    }

    await this.writeSystemEntry({
      phase: "system_error",
      title: "SYSTEM ERROR",
      timestamp: new Date().toISOString(),
      payload,
      isError: true
    });
  }

  async startRun(inbound: InboundMessage): Promise<ExecutionLogger> {
    const runId = crypto.randomUUID();
    const colorCode = BRIGHT_SEPARATOR_COLORS[Math.floor(Math.random() * BRIGHT_SEPARATOR_COLORS.length)];
    const startedAt = new Date().toISOString();
    const correlationId = inbound.correlationId ?? inbound.sessionId;

    const execution = new ExecutionLogger({
      parent: this,
      runId,
      correlationId,
      sessionId: inbound.sessionId,
      parentRunId: inbound.parentRunId,
      startedAt,
      inbound,
      colorCode
    });

    await execution.open();
    return execution;
  }

  async close(timeoutMs = 0): Promise<void> {
    this.closed = true;
    if (timeoutMs <= 0) {
      await this.writeQueue.catch(() => undefined);
      return;
    }

    await Promise.race([
      this.writeQueue.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      })
    ]);
  }

  getOrigin(): Record<string, string> {
    return {
      service_name: this.settings.app.name,
      container_name: this.settings.logging.containerName || NO_VALUE,
      container_id: this.settings.logging.containerId || NO_VALUE,
      instance_id: this.settings.logging.instanceId || NO_VALUE,
      host_name: this.settings.logging.hostName || NO_VALUE,
      environment: this.settings.app.env
    };
  }

  writeConsoleLine(phase: TerminalPhase, message: string, isError = false): void {
    if (!this.settings.logging.consoleEnabled || !message.trim()) {
      return;
    }

    const formatted = `[${phase}]`.padEnd(8);
    if (isError) {
      console.error(`${RED_COLOR}${formatted}${message}${RESET_COLOR}`);
      return;
    }

    console.info(`${formatted}${message}`);
  }

  writeConsoleSeparator(colorCode: number, direction: "start" | "end"): void {
    if (!this.settings.logging.consoleEnabled) {
      return;
    }

    const bar = "═".repeat(60);
    const marker = direction === "start" ? "▼" : "▲";
    const line = direction === "start" ? `${bar}${marker}` : `${marker}${bar}`;
    console.info(`\u001b[${colorCode}m${line}${RESET_COLOR}`);
  }

  async writeExecutionStart(entry: RunStartEntry): Promise<void> {
    const lines = [
      "====> RUN START",
      `run_id: ${entry.runId}`,
      `correlation_id: ${entry.correlationId}`,
      `session_id: ${entry.sessionId}`,
      `parent_run_id: ${entry.parentRunId ?? NO_VALUE}`,
      `started_at: ${entry.startedAt}`,
      formatKeyValueLines({ origin: entry.origin }),
      ""
    ];

    if (this.usesFileBackend()) {
      await this.writeFileLines(lines);
    }

    if (this.usesPostgresBackend()) {
      await this.writePostgresRunStart(entry, lines);
    }
  }

  async writeExecutionBlock(entry: RunBlockEntry): Promise<void> {
    const lines = [`[${entry.title}]`, formatStructuredData(entry.data), ""];

    if (this.usesFileBackend()) {
      await this.writeFileLines(lines);
    }

    if (this.usesPostgresBackend()) {
      await this.writePostgresRunBlock(entry, lines);
    }
  }

  async writeExecutionEnd(entry: RunEndEntry): Promise<void> {
    const lines = ["<==== RUN END", ""];

    if (this.usesFileBackend()) {
      await this.writeFileLines(lines);
    }

    if (this.usesPostgresBackend()) {
      await this.writePostgresRunEnd(entry, lines);
    }
  }

  private usesFileBackend(): boolean {
    return this.settings.logging.backend === "file";
  }

  private usesPostgresBackend(): boolean {
    return this.settings.logging.backend === "postgres";
  }

  private async writeSystemEntry(entry: SystemEntry): Promise<void> {
    if (!this.usesFileBackend() && !this.usesPostgresBackend()) {
      return;
    }

    const lines = [
      `====> ${entry.title}`,
      `timestamp: ${entry.timestamp}`,
      formatKeyValueLines(entry.payload),
      `<==== ${entry.title}`,
      ""
    ];

    if (this.usesFileBackend()) {
      await this.writeFileLines(lines);
    }

    if (this.usesPostgresBackend()) {
      await this.writePostgresSystemEntry(entry, lines);
    }
  }

  private async writeFileLines(lines: string[]): Promise<void> {
    const payload = `${lines.join("\n")}\n`;
    await this.enqueueWrite("file_write", async () => {
      await this.ensureLogFile();
      const newLines = countLines(payload);
      if (this.activeLineCount + newLines > this.maxLinesPerFile) {
        await this.rotate();
      }
      await writeFile(this.activePath, payload, { encoding: "utf8", flag: "a" });
      this.activeLineCount += newLines;
    });
  }

  private async writePostgresSystemEntry(entry: SystemEntry, lines: string[]): Promise<void> {
    const sanitizedPayload = sanitizeForLog(entry.payload) as Record<string, unknown>;
    await this.enqueueWrite("postgres_write", async () => {
      await this.ensurePostgresTables();
      const client = this.createPostgresClientFactory(this.settings.trace.postgres.queryTimeoutMs);
      const schema = quoteIdentifier(this.requirePostgresSchema());

      await client.connect();
      try {
        await client.query(
          `insert into ${schema}.${quoteIdentifier(POSTGRES_ENTRIES_TABLE)} (
            run_id,
            seq,
            phase,
            title,
            created_at,
            line_count,
            is_error,
            rendered_text,
            payload
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            null,
            null,
            entry.phase,
            entry.title,
            entry.timestamp,
            countRenderedLines(lines),
            entry.isError,
            renderLines(lines),
            JSON.stringify(sanitizedPayload)
          ]
        );
      } finally {
        await client.end().catch(() => undefined);
      }
    });
  }

  private async writePostgresRunStart(entry: RunStartEntry, lines: string[]): Promise<void> {
    const sanitizedOrigin = sanitizeForLog(entry.origin) as Record<string, unknown>;
    const sanitizedInput = sanitizeForLog(entry.input) as Record<string, unknown>;
    await this.enqueueWrite("postgres_write", async () => {
      await this.ensurePostgresTables();
      const client = this.createPostgresClientFactory(this.settings.trace.postgres.queryTimeoutMs);
      const schema = quoteIdentifier(this.requirePostgresSchema());

      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `insert into ${schema}.${quoteIdentifier(POSTGRES_RUNS_TABLE)} (
            run_id,
            correlation_id,
            session_id,
            parent_run_id,
            started_at,
            completed_at,
            status,
            color_code,
            origin,
            input_payload,
            updated_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
          on conflict (run_id) do update set
            correlation_id = excluded.correlation_id,
            session_id = excluded.session_id,
            parent_run_id = excluded.parent_run_id,
            started_at = excluded.started_at,
            completed_at = excluded.completed_at,
            status = excluded.status,
            color_code = excluded.color_code,
            origin = excluded.origin,
            input_payload = excluded.input_payload,
            updated_at = excluded.updated_at`,
          [
            entry.runId,
            entry.correlationId,
            entry.sessionId,
            entry.parentRunId ?? null,
            entry.startedAt,
            null,
            "running",
            entry.colorCode,
            JSON.stringify(sanitizedOrigin),
            JSON.stringify(sanitizedInput),
            entry.startedAt
          ]
        );
        await client.query(
          `insert into ${schema}.${quoteIdentifier(POSTGRES_ENTRIES_TABLE)} (
            run_id,
            seq,
            phase,
            title,
            created_at,
            line_count,
            is_error,
            rendered_text,
            payload
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            entry.runId,
            0,
            "run_start",
            "RUN START",
            entry.startedAt,
            countRenderedLines(lines),
            false,
            renderLines(lines),
            JSON.stringify({
              correlation_id: entry.correlationId,
              session_id: entry.sessionId,
              parent_run_id: entry.parentRunId ?? null,
              origin: sanitizedOrigin
            })
          ]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
    });
  }

  private async writePostgresRunBlock(entry: RunBlockEntry, lines: string[]): Promise<void> {
    const sanitizedData = sanitizeForLog(entry.data) as Record<string, unknown>;
    await this.enqueueWrite("postgres_write", async () => {
      await this.ensurePostgresTables();
      const client = this.createPostgresClientFactory(this.settings.trace.postgres.queryTimeoutMs);
      const schema = quoteIdentifier(this.requirePostgresSchema());

      await client.connect();
      try {
        await client.query(
          `insert into ${schema}.${quoteIdentifier(POSTGRES_ENTRIES_TABLE)} (
            run_id,
            seq,
            phase,
            title,
            created_at,
            line_count,
            is_error,
            rendered_text,
            payload
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            entry.runId,
            entry.seq,
            "block",
            entry.title,
            entry.createdAt,
            countRenderedLines(lines),
            Boolean(entry.isError),
            renderLines(lines),
            JSON.stringify(sanitizedData)
          ]
        );
      } finally {
        await client.end().catch(() => undefined);
      }
    });
  }

  private async writePostgresRunEnd(entry: RunEndEntry, lines: string[]): Promise<void> {
    await this.enqueueWrite("postgres_write", async () => {
      await this.ensurePostgresTables();
      const client = this.createPostgresClientFactory(this.settings.trace.postgres.queryTimeoutMs);
      const schema = quoteIdentifier(this.requirePostgresSchema());
      const payload = sanitizeForLog({
        status: entry.status,
        elapsed_ms: entry.elapsedMs,
        summary: entry.summary,
        result: entry.result,
        error: entry.error ?? null
      }) as Record<string, unknown>;

      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `update ${schema}.${quoteIdentifier(POSTGRES_RUNS_TABLE)}
           set completed_at = $2,
               status = $3,
               updated_at = $4
           where run_id = $1`,
          [entry.runId, entry.createdAt, entry.status, entry.createdAt]
        );
        await client.query(
          `insert into ${schema}.${quoteIdentifier(POSTGRES_ENTRIES_TABLE)} (
            run_id,
            seq,
            phase,
            title,
            created_at,
            line_count,
            is_error,
            rendered_text,
            payload
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            entry.runId,
            entry.seq,
            "run_end",
            "RUN END",
            entry.createdAt,
            countRenderedLines(lines),
            Boolean(entry.error),
            renderLines(lines),
            JSON.stringify(payload)
          ]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
    });
  }

  private async enqueueWrite(context: string, task: () => Promise<void>): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      if (this.closed) {
        return;
      }
      await task();
    }).catch((error) => {
      if (this.settings.logging.consoleEnabled) {
        console.error(`${RED_COLOR}[ERROR] logging ${context} ${error instanceof Error ? error.message : "unknown_error"}${RESET_COLOR}`);
      }
    });

    await this.writeQueue;
  }

  private async ensureLogFile(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(this.settings.logging.directory, { recursive: true });
    await this.cleanupExtraneousFiles();

    const slots = await this.loadExistingSlots();
    if (slots.length === 0) {
      this.activeIndex = 0;
      this.activePath = this.pathForIndex(0);
      await writeFile(this.activePath, "", "utf8");
      this.activeLineCount = 0;
      this.initialized = true;
      return;
    }

    const active = slots.sort((left, right) => right.mtimeMs - left.mtimeMs)[0];
    this.activeIndex = active.index;
    this.activePath = active.path;
    this.activeLineCount = active.lineCount;
    this.initialized = true;
  }

  private async ensurePostgresTables(): Promise<void> {
    if (this.postgresTablesReady) {
      return;
    }

    if (this.postgresTablesTask) {
      await this.postgresTablesTask;
      return;
    }

    this.requirePostgresConnectionString();
    const task = (async () => {
      const client = this.createPostgresClientFactory(this.settings.trace.postgres.queryTimeoutMs);
      const schema = quoteIdentifier(this.requirePostgresSchema());
      const runsTable = quoteIdentifier(POSTGRES_RUNS_TABLE);
      const entriesTable = quoteIdentifier(POSTGRES_ENTRIES_TABLE);

      await client.connect();
      try {
        await client.query(`create schema if not exists ${schema}`);
        await client.query(
          `create table if not exists ${schema}.${runsTable} (
            run_id text primary key,
            correlation_id text not null,
            session_id text not null,
            parent_run_id text,
            started_at timestamptz not null,
            completed_at timestamptz,
            status text not null,
            color_code integer,
            origin jsonb not null default '{}'::jsonb,
            input_payload jsonb not null default '{}'::jsonb,
            updated_at timestamptz not null
          )`
        );
        await client.query(
          `create table if not exists ${schema}.${entriesTable} (
            id bigserial primary key,
            run_id text references ${schema}.${runsTable} (run_id) on delete cascade,
            seq integer,
            phase text not null,
            title text not null,
            created_at timestamptz not null,
            line_count integer not null,
            is_error boolean not null default false,
            rendered_text text not null,
            payload jsonb not null default '{}'::jsonb
          )`
        );
        await client.query(
          `create index if not exists ${quoteIdentifier(`${POSTGRES_RUNS_TABLE}_started_at_idx`)}
           on ${schema}.${runsTable} (started_at desc)`
        );
        await client.query(
          `create index if not exists ${quoteIdentifier(`${POSTGRES_RUNS_TABLE}_session_id_idx`)}
           on ${schema}.${runsTable} (session_id, started_at desc)`
        );
        await client.query(
          `create index if not exists ${quoteIdentifier(`${POSTGRES_ENTRIES_TABLE}_run_seq_idx`)}
           on ${schema}.${entriesTable} (run_id, seq)`
        );
        await client.query(
          `create index if not exists ${quoteIdentifier(`${POSTGRES_ENTRIES_TABLE}_created_at_idx`)}
           on ${schema}.${entriesTable} (created_at desc)`
        );
      } finally {
        await client.end().catch(() => undefined);
      }

      this.postgresTablesReady = true;
      this.postgresTablesTask = null;
    })().catch((error) => {
      this.postgresTablesTask = null;
      throw error;
    });

    this.postgresTablesTask = task;
    await task;
  }

  private requirePostgresSchema(): string {
    if (!this.postgresSchema) {
      throw new Error("APP_LOG_BACKEND=postgres requires a valid TRACE_POSTGRES_SCHEMA");
    }
    return this.postgresSchema;
  }

  private requirePostgresConnectionString(): string {
    if (!this.settings.trace.postgres.connectionString) {
      throw new Error("TRACE_POSTGRES_URL is required when APP_LOG_BACKEND=postgres");
    }
    return this.settings.trace.postgres.connectionString;
  }

  private createPostgresClient(queryTimeoutMs: number): PostgresClientLike {
    return new Client({
      connectionString: this.requirePostgresConnectionString(),
      connectionTimeoutMillis: this.settings.trace.postgres.connectTimeoutMs,
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
      keepAlive: false,
      application_name: `${this.settings.app.name}-operational-log`
    });
  }

  private async rotate(): Promise<void> {
    this.activeIndex = (this.activeIndex + 1) % this.maxFiles;
    this.activePath = this.pathForIndex(this.activeIndex);
    await writeFile(this.activePath, "", "utf8");
    this.activeLineCount = 0;
    await this.cleanupExtraneousFiles();
  }

  private pathForIndex(index: number): string {
    if (index === 0) {
      return this.baseFilePath;
    }

    const dir = dirname(this.baseFilePath);
    const ext = extname(this.baseFilePath);
    const name = basename(this.baseFilePath, ext);
    return join(dir, `${name}.${index}${ext}`);
  }

  private async loadExistingSlots(): Promise<FileSlot[]> {
    const slots: FileSlot[] = [];
    for (let index = 0; index < this.maxFiles; index += 1) {
      const filePath = this.pathForIndex(index);
      try {
        const [metadata, content] = await Promise.all([stat(filePath), readFile(filePath, "utf8")]);
        slots.push({
          index,
          path: filePath,
          mtimeMs: metadata.mtimeMs,
          lineCount: countLines(content)
        });
      } catch {
        // ignore missing files
      }
    }
    return slots;
  }

  private async cleanupExtraneousFiles(): Promise<void> {
    const dir = dirname(this.baseFilePath);
    const ext = extname(this.baseFilePath);
    const name = basename(this.baseFilePath, ext);
    const expected = new Set(Array.from({ length: this.maxFiles }, (_, index) => basename(this.pathForIndex(index))));

    const files = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      files
        .filter((file) => file === `${name}${ext}` || new RegExp(`^${escapeRegex(name)}\\.\\d+${escapeRegex(ext)}$`).test(file))
        .filter((file) => !expected.has(file))
        .map((file) => rm(join(dir, file), { force: true }))
    );
  }
}

interface ExecutionLoggerOptions {
  parent: OperationalLogger;
  runId: string;
  correlationId: string;
  sessionId: string;
  parentRunId?: string;
  startedAt: string;
  inbound: InboundMessage;
  colorCode: number;
}

export class ExecutionLogger {
  readonly runId: string;

  private readonly parent: OperationalLogger;
  private readonly correlationId: string;
  private readonly sessionId: string;
  private readonly parentRunId?: string;
  private readonly startedAt: string;
  private readonly inbound: InboundMessage;
  private readonly colorCode: number;
  private nextSeq = 1;

  constructor(options: ExecutionLoggerOptions) {
    this.parent = options.parent;
    this.runId = options.runId;
    this.correlationId = options.correlationId;
    this.sessionId = options.sessionId;
    this.parentRunId = options.parentRunId;
    this.startedAt = options.startedAt;
    this.inbound = options.inbound;
    this.colorCode = options.colorCode;
  }

  async open(): Promise<void> {
    this.parent.writeConsoleSeparator(this.colorCode, "start");
    this.parent.writeConsoleLine(
      "IN",
      `run=${shortId(this.runId)} session=${shortId(this.sessionId)} text="${this.inbound.text}"`
    );

    await this.parent.writeExecutionStart({
      runId: this.runId,
      correlationId: this.correlationId,
      sessionId: this.sessionId,
      parentRunId: this.parentRunId,
      startedAt: this.startedAt,
      colorCode: this.colorCode,
      origin: this.parent.getOrigin(),
      input: {
        visible_input: this.inbound.text,
        trigger: this.inbound.trigger ?? "http_message",
        channel: this.inbound.channel,
        actor_id: this.inbound.actorId,
        account_id: this.inbound.accountId ?? NO_VALUE,
        contact_name: this.inbound.contactName ?? NO_VALUE,
        identifiers: {
          run_id: this.runId,
          correlation_id: this.correlationId,
          session_id: this.sessionId
        },
        payload_summary: summarizePayload(this.inbound.rawPayload)
      }
    });

    await this.block("01.INPUT", {
      visible_input: this.inbound.text,
      trigger: this.inbound.trigger ?? "http_message",
      channel: this.inbound.channel,
      actor_id: this.inbound.actorId,
      account_id: this.inbound.accountId ?? NO_VALUE,
      contact_name: this.inbound.contactName ?? NO_VALUE,
      identifiers: {
        run_id: this.runId,
        correlation_id: this.correlationId,
        session_id: this.sessionId
      },
      payload_summary: summarizePayload(this.inbound.rawPayload)
    });
  }

  async memoryRead(name: string, data: {
    scope: "short_term" | "long_term";
    component: string;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
    status: string;
    error?: unknown;
    summary: string;
  }): Promise<void> {
    const capturedError = data.error ? toLogError("memory_read", data.component, data.error, "memory_read_degraded") : undefined;
    this.parent.writeConsoleLine("MEM", data.summary, Boolean(capturedError));
    await this.block(`02.MEMORY.READ.${name}`, {
      scope: data.scope,
      component: data.component,
      request: data.request,
      response: data.response,
      status: data.status,
      error: capturedError ?? NO_VALUE
    }, Boolean(capturedError));
  }

  async context(data: {
    shortTermState: unknown;
    memory: {
      provider: string;
      enabled: boolean;
      topK: number;
      scoreThreshold: number;
      rawRecallCount: number;
      promptDigest: string;
    };
  }): Promise<void> {
    await this.block("02.CONTEXT", data);
  }

  async route(data: {
    resolver: string;
    input: Record<string, unknown>;
    decision?: RouteDecision;
    error?: unknown;
    fallback?: string;
  }): Promise<void> {
    const capturedError = data.error ? toLogError("route", data.resolver, data.error, "routing_degraded") : undefined;
    const summary = capturedError
      ? `${capturedError.owner} ${capturedError.type}: ${capturedError.detail}`
      : `${data.resolver} -> ${data.decision?.capability ?? "unknown"} (${data.decision?.reason ?? "sin razon"})`;

    this.parent.writeConsoleLine("ROUTE", summary, Boolean(capturedError));
    await this.block("03.ROUTE", {
      resolver: data.resolver,
      input: data.input,
      decision: data.decision ?? NO_VALUE,
      fallback: data.fallback ?? NO_VALUE,
      error: capturedError ?? NO_VALUE
    }, Boolean(capturedError));
  }

  async tool(name: string, data: Record<string, unknown>): Promise<void> {
    await this.block(`04.TOOL.${name}`, data);
  }

  async model(name: string, data: Record<string, unknown>): Promise<void> {
    await this.block(`05.MODEL.${name}`, data);
  }

  async flow(data: {
    selectedFlow: string;
    capability: string;
    result: unknown;
    usedDspy: boolean;
    knowledgeCount: number;
    consoleSummary?: string;
  }): Promise<void> {
    this.parent.writeConsoleLine(
      "FLOW",
      `${data.consoleSummary ?? data.capability} -> ${extractConsoleResult(data.result)}`
    );
    await this.block("06.FLOW", data);
  }

  async memoryWrite(name: string, data: {
    scope: "short_term" | "long_term";
    component: string;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
    status: string;
    error?: unknown;
    summary: string;
  }): Promise<void> {
    const capturedError = data.error ? toLogError("memory_write", data.component, data.error, "memory_write_degraded") : undefined;
    this.parent.writeConsoleLine("MEM", data.summary, Boolean(capturedError));
    await this.block(`07.MEMORY.WRITE.${name}`, {
      scope: data.scope,
      component: data.component,
      request: data.request,
      response: data.response,
      status: data.status,
      error: capturedError ?? NO_VALUE
    }, Boolean(capturedError));
  }

  async output(data: {
    destination: string;
    request: Record<string, unknown>;
    response: Record<string, unknown>;
    finalOutput: string;
  }): Promise<void> {
    this.parent.writeConsoleLine("OUT", data.finalOutput);
    await this.block("07.OUTPUT", data);
  }

  async end(data: { status: string; summary: string; result: string }): Promise<void> {
    const elapsedMs = Date.now() - Date.parse(this.startedAt);
    this.parent.writeConsoleLine("END", `${data.status} elapsed=${elapsedMs}ms`);
    this.parent.writeConsoleSeparator(this.colorCode, "end");

    await this.block("08.END", {
      status: data.status,
      elapsed_ms: elapsedMs,
      summary: data.summary,
      result: data.result
    });

    await this.parent.writeExecutionEnd({
      runId: this.runId,
      seq: this.allocateSeq(),
      createdAt: new Date().toISOString(),
      status: data.status,
      summary: data.summary,
      result: data.result,
      elapsedMs
    });
  }

  async fail(error: unknown): Promise<void> {
    const elapsedMs = Date.now() - Date.parse(this.startedAt);
    const capturedError = toLogError("execution", "orchestrator", error, "turn_failed");
    this.parent.writeConsoleLine("FLOW", `${capturedError.owner} ${capturedError.type}: ${capturedError.detail}`, true);
    this.parent.writeConsoleLine("END", `error elapsed=${elapsedMs}ms`, true);
    this.parent.writeConsoleSeparator(this.colorCode, "end");

    await this.block("08.END", {
      status: "error",
      elapsed_ms: elapsedMs,
      summary: "captured_error",
      result: "execution_failed",
      error: capturedError
    }, true);

    await this.parent.writeExecutionEnd({
      runId: this.runId,
      seq: this.allocateSeq(),
      createdAt: new Date().toISOString(),
      status: "error",
      summary: "captured_error",
      result: "execution_failed",
      elapsedMs,
      error: capturedError
    });
  }

  private async block(title: string, data: Record<string, unknown>, isError = false): Promise<void> {
    await this.parent.writeExecutionBlock({
      runId: this.runId,
      seq: this.allocateSeq(),
      title,
      createdAt: new Date().toISOString(),
      data,
      isError
    });
  }

  private allocateSeq(): number {
    const current = this.nextSeq;
    this.nextSeq += 1;
    return current;
  }
}

function summarizePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      type: Array.isArray(payload) ? "array" : typeof payload,
      preview: sanitizeForLog(payload)
    };
  }

  const record = payload as Record<string, unknown>;
  return {
    type: "object",
    keys: Object.keys(record)
  };
}

function extractConsoleResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }

  const candidate = (result as Record<string, unknown>).responseText;
  return typeof candidate === "string" ? candidate : JSON.stringify(sanitizeForLog(result));
}

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated_depth]";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      sanitized[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeForLog(entry, depth + 1);
    }
    return sanitized;
  }

  return String(value);
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|key|password|authorization|cookie|credential|apikey|bearer/i.test(key);
}

function formatStructuredData(data: Record<string, unknown>): string {
  const serialized = JSON.stringify(sanitizeForLog(data), null, 2) ?? "";
  return serialized;
}

function formatKeyValueLines(data: Record<string, unknown>): string {
  return Object.entries(sanitizeForLog(data) as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function toLogError(stage: string, owner: string, error: unknown, impact: string): LogError {
  if (error instanceof Error) {
    return {
      owner,
      type: error.name || "Error",
      detail: error.message,
      stage,
      impact
    };
  }

  return {
    owner,
    type: typeof error,
    detail: String(error),
    stage,
    impact
  };
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function countLines(value: string): number {
  return value.split("\n").length - 1;
}

function countRenderedLines(lines: string[]): number {
  return countLines(`${renderLines(lines)}\n`);
}

function renderLines(lines: string[]): string {
  return lines.join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}
