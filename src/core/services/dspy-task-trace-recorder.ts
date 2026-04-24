import { Client } from "pg";
import type { AppSettings } from "../../config";
import type { HealthStatus } from "../../domain/ports";

export interface DspyTaskTraceRecord {
  taskName: string;
  endpoint: string;
  requestJson: string;
  responseJson: string | null;
  responseStatus: number | null;
  ok: boolean;
  errorText: string | null;
  startedAt: string;
  completedAt: string;
}

export interface DspyTaskTraceRecorder {
  record(entry: DspyTaskTraceRecord): Promise<void>;
  health(): Promise<HealthStatus>;
  close(timeoutMs?: number): Promise<void>;
}

type DspyTaskTraceSettings = AppSettings["dspy"]["taskTrace"];

function assertIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function tableNameForTask(taskName: string): string {
  return assertIdentifier(`${taskName}_calls`, "task trace table");
}

function summarizeConnectionTarget(connectionString: string): string {
  if (!connectionString.trim()) {
    return "missing_connection_string";
  }

  try {
    const parsed = new URL(connectionString);
    return `${parsed.hostname || "unknown_host"}:${parsed.port || "5432"}${parsed.pathname || ""}`;
  } catch {
    return "unparseable_connection_string";
  }
}

function writeTaskTraceConsoleLine(consoleEnabled: boolean, isError: boolean, message: string, details: Record<string, unknown> = {}): void {
  if (!consoleEnabled) {
    return;
  }

  const formattedDetails = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const line = formattedDetails ? `[DSPY_TASK_TRACE] ${message} ${formattedDetails}` : `[DSPY_TASK_TRACE] ${message}`;

  if (isError) {
    console.error(line);
    return;
  }

  console.info(line);
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function dspyTaskNameFromPath(path: string): string {
  const normalized = path
    .replace(/^\/+/, "")
    .replace(/^predict\//, "")
    .replace(/[^a-zA-Z0-9/_-]/g, "")
    .replace(/\//g, "_")
    .replace(/-/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  return assertIdentifier(normalized || "unknown_task", "task trace name");
}

export class NoopDspyTaskTraceRecorder implements DspyTaskTraceRecorder {
  constructor(
    private readonly consoleEnabled = true,
    private readonly reason = "disabled"
  ) {
    writeTaskTraceConsoleLine(this.consoleEnabled, false, "recorder=noop", {
      reason: this.reason
    });
  }

  async record(entry: DspyTaskTraceRecord): Promise<void> {
    writeTaskTraceConsoleLine(this.consoleEnabled, false, "skip_record", {
      recorder: "noop",
      reason: this.reason,
      task: entry.taskName,
      endpoint: entry.endpoint
    });
  }

  async health(): Promise<HealthStatus> {
    return {
      ok: true,
      details: {
        backend: "disabled",
        reason: this.reason
      }
    };
  }

  async close(_timeoutMs = 0): Promise<void> {}
}

export class PostgresDspyTaskTraceRecorder implements DspyTaskTraceRecorder {
  private readonly schema: string;
  private readonly ensuredTables = new Set<string>();
  private readonly ensuringTables = new Map<string, Promise<void>>();
  private queue = Promise.resolve();
  private closed = false;

  constructor(
    private readonly settings: DspyTaskTraceSettings,
    private readonly appName: string,
    private readonly consoleEnabled = true
  ) {
    this.schema = assertIdentifier(settings.postgres.schema, "task trace schema");
    this.log("recorder=postgres", {
      schema: this.schema,
      target: summarizeConnectionTarget(this.settings.postgres.connectionString)
    });
  }

  async record(entry: DspyTaskTraceRecord): Promise<void> {
    const tableName = tableNameForTask(entry.taskName);
    const tableRef = `${this.schema}.${tableName}`;

    if (this.closed) {
      this.log("skip_record", {
        reason: "recorder_closed",
        task: entry.taskName,
        table: tableRef
      });
      return;
    }

    if (!this.settings.postgres.connectionString) {
      this.log("skip_record", {
        reason: "missing_connection_string",
        task: entry.taskName,
        table: tableRef
      }, true);
      return;
    }

    this.log("record_requested", {
      task: entry.taskName,
      table: tableRef,
      endpoint: entry.endpoint,
      response_status: entry.responseStatus ?? "none",
      ok: entry.ok
    });

    try {
      await this.enqueue(async () => {
        await this.ensureTable(entry.taskName);
        const client = this.createClient(this.settings.postgres.queryTimeoutMs);
        const schema = quoteIdentifier(this.schema);
        const table = quoteIdentifier(tableName);

        await client.connect();
        try {
          await client.query(
            `insert into ${schema}.${table} (
              endpoint,
              request_json,
              response_json,
              response_status,
              ok,
              error_text,
              started_at,
              completed_at
            ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              entry.endpoint,
              entry.requestJson,
              entry.responseJson,
              entry.responseStatus,
              entry.ok,
              entry.errorText,
              entry.startedAt,
              entry.completedAt
            ]
          );
          this.log("record_persisted", {
            task: entry.taskName,
            table: tableRef,
            response_status: entry.responseStatus ?? "none",
            ok: entry.ok,
            error_text: entry.errorText ?? ""
          });
        } finally {
          await client.end();
        }
      });
    } catch (error) {
      this.log("record_failed", {
        task: entry.taskName,
        table: tableRef,
        error: error instanceof Error ? error.message : "unknown_dspy_task_trace_error"
      }, true);
    }
  }

  async health(): Promise<HealthStatus> {
    if (!this.settings.postgres.connectionString) {
      return {
        ok: false,
        details: {
          backend: "postgres",
          error: "DSPY_TASK_TRACE_POSTGRES_URL is required when DSPY_TASK_TRACE_BACKEND=postgres"
        }
      };
    }

    const client = this.createClient(this.settings.postgres.healthTimeoutMs);
    try {
      await raceWithTimeout(client.connect(), this.settings.postgres.healthTimeoutMs, "dspy task trace health connect timeout");
      await raceWithTimeout(client.query("select 1 as ok"), this.settings.postgres.healthTimeoutMs, "dspy task trace health query timeout");
      return {
        ok: true,
        details: {
          backend: "postgres",
          schema: this.schema
        }
      };
    } catch (error) {
      return {
        ok: false,
        details: {
          backend: "postgres",
          schema: this.schema,
          error: error instanceof Error ? error.message : "unknown_dspy_task_trace_health_error"
        }
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async close(timeoutMs = 0): Promise<void> {
    this.closed = true;
    if (timeoutMs <= 0) {
      await this.queue.catch(() => undefined);
      return;
    }

    await Promise.race([
      this.queue.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      })
    ]);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const queued = this.queue.then(task, task);
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  private createClient(queryTimeoutMs: number): Client {
    return new Client({
      connectionString: this.settings.postgres.connectionString,
      connectionTimeoutMillis: this.settings.postgres.connectTimeoutMs,
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
      keepAlive: false,
      application_name: `${this.appName}-dspy-task-trace`
    });
  }

  private async ensureTable(taskName: string): Promise<void> {
    const tableName = tableNameForTask(taskName);
    if (this.ensuredTables.has(tableName)) {
      return;
    }

    const existing = this.ensuringTables.get(tableName);
    if (existing) {
      await existing;
      return;
    }

    const task = (async () => {
      const client = this.createClient(this.settings.postgres.queryTimeoutMs);
      const schema = quoteIdentifier(this.schema);
      const table = quoteIdentifier(tableName);

      await client.connect();
      try {
        await client.query(`create schema if not exists ${schema}`);
        await client.query(
          `create table if not exists ${schema}.${table} (
            id bigserial primary key,
            endpoint text not null,
            request_json text not null,
            response_json text,
            response_status integer,
            ok boolean not null default false,
            error_text text,
            started_at timestamptz not null,
            completed_at timestamptz not null
          )`
        );
        await client.query(`create index if not exists ${quoteIdentifier(`${tableName}_started_at_idx`)} on ${schema}.${table} (started_at desc)`);
        this.log("table_ready", {
          task: taskName,
          table: `${this.schema}.${tableName}`
        });
      } finally {
        await client.end();
      }

      this.ensuredTables.add(tableName);
      this.ensuringTables.delete(tableName);
    })().catch((error) => {
      this.ensuringTables.delete(tableName);
      throw error;
    });

    this.ensuringTables.set(tableName, task);
    await task;
  }

  private log(message: string, details: Record<string, unknown> = {}, isError = false): void {
    writeTaskTraceConsoleLine(this.consoleEnabled, isError, message, details);
  }
}
