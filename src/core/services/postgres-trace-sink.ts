import { Client } from "pg";
import type { AppSettings } from "../../config";
import type { InboundMessage, RouteDecision, TurnOutcome } from "../../domain/contracts";
import type { HealthStatus, TraceSink } from "../../domain/ports";
import {
  appendTraceEvent,
  cloneTraceRecord,
  createTraceRecord,
  markTraceEnded,
  markTraceFailed,
  projectReply,
  projectRouteDecision,
  serializeError,
  type TraceRecord
} from "./trace-record";

interface TraceFragmentRow {
  order: number;
  kind: string;
  label: string;
  createdAt: string;
  latencyMs: number | null;
  payload: Record<string, unknown>;
}

interface TraceExampleRow {
  taskName: string;
  createdAt: string;
  inputPayload: Record<string, unknown>;
  targetPayload: Record<string, unknown>;
  metadataPayload: Record<string, unknown>;
  eligibilityReason: string;
}

type PostgresTraceSettings = AppSettings["trace"] & {
  llmModel: string;
  llmFallbackProvider: string;
  dspyModel: string;
};

function assertSchemaName(schema: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid trace schema name: ${schema}`);
  }
  return schema;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function compactText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function pickLastEventPayload(record: TraceRecord, label: string): Record<string, unknown> | null {
  for (let index = record.events.length - 1; index >= 0; index -= 1) {
    const event = record.events[index];
    if (event?.event === label) {
      return toRecord(event.payload);
    }
  }
  return null;
}

function pickFirstEventPayload(record: TraceRecord, label: string): Record<string, unknown> | null {
  for (const event of record.events) {
    if (event.event === label) {
      return toRecord(event.payload);
    }
  }
  return null;
}

function pickFirstEventTimestamp(record: TraceRecord, label: string): string | null {
  for (const event of record.events) {
    if (event.event === label) {
      return event.timestamp;
    }
  }
  return null;
}

function pickBackend(record: TraceRecord, label: string): string | null {
  const meta = pickLastEventPayload(record, label);
  const provider = meta?.provider;
  return typeof provider === "string" ? provider : null;
}

function withRawInputMetadata(
  servedInput: Record<string, unknown>,
  rawInput: Record<string, unknown> | null,
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const effectiveRawInput = rawInput ?? servedInput;
  return {
    ...metadata,
    raw_input: effectiveRawInput,
    input_was_compacted: JSON.stringify(effectiveRawInput) !== JSON.stringify(servedInput)
  };
}

function buildConversationLikeRawInput(
  record: TraceRecord,
  nodeName: "conversation" | "rag",
  servedInput: Record<string, unknown>
): Record<string, unknown> | null {
  const state = pickLastEventPayload(record, `langgraph.node.${nodeName}.before`);
  if (!state) {
    return null;
  }
  const loadContext = pickLastEventPayload(record, "clinic.load_context.output");
  const rawMemories = Array.isArray(loadContext?.recalled_memories)
    ? loadContext.recalled_memories
    : Array.isArray(state.recalled_memories)
      ? state.recalled_memories
      : servedInput.memories;

  const rawInput: Record<string, unknown> = {
    user_message: state.last_user_message ?? servedInput.user_message ?? "",
    summary: state.summary ?? servedInput.summary ?? "",
    active_goal: state.active_goal ?? servedInput.active_goal ?? "",
    stage: state.stage ?? servedInput.stage ?? "",
    pending_question: state.pending_question ?? servedInput.pending_question ?? "",
    last_assistant_message: state.last_assistant_message ?? servedInput.last_assistant_message ?? "",
    recent_turns: state.recent_turns ?? servedInput.recent_turns ?? [],
    memories: rawMemories ?? servedInput.memories ?? []
  };

  if (nodeName === "rag" && servedInput.retrieved_context !== undefined) {
    rawInput.retrieved_context = servedInput.retrieved_context;
  }

  return rawInput;
}

function buildAppointmentExtractionRawInput(
  record: TraceRecord,
  servedInput: Record<string, unknown>
): Record<string, unknown> | null {
  const loadContext = pickLastEventPayload(record, "clinic.load_context.output");
  const rawMemories = Array.isArray(loadContext?.recalled_memories)
    ? loadContext.recalled_memories
    : servedInput.memories;

  return {
    ...servedInput,
    memories: rawMemories ?? servedInput.memories ?? []
  };
}

function buildAppointmentReplyRawInput(
  record: TraceRecord,
  servedInput: Record<string, unknown>
): Record<string, unknown> | null {
  const loadContext = pickLastEventPayload(record, "clinic.load_context.output");
  const rawMemories = Array.isArray(loadContext?.recalled_memories)
    ? loadContext.recalled_memories
    : servedInput.memories;

  return {
    ...servedInput,
    memories: rawMemories ?? servedInput.memories ?? []
  };
}

function buildRouteRawInput(record: TraceRecord, servedInput: Record<string, unknown>): Record<string, unknown> | null {
  const routeRaw = pickFirstEventPayload(record, "clinic.route.raw_input") ?? {};
  const loadContext = pickLastEventPayload(record, "clinic.load_context.output");
  const rawMemories = Array.isArray(loadContext?.recalled_memories)
    ? loadContext.recalled_memories
    : routeRaw.memories;

  return {
    ...servedInput,
    ...routeRaw,
    memories: rawMemories ?? routeRaw.memories ?? servedInput.memories ?? []
  };
}

function buildTurnInputPayload(inbound: InboundMessage): Record<string, unknown> {
  const raw = toRecord(inbound.rawPayload) ?? {};
  return {
    account_id: inbound.accountId ?? inbound.deliveryContext?.accountId ?? raw.account_id ?? null,
    channel: inbound.channel,
    contact_id: inbound.deliveryContext?.contactId ?? inbound.actorId ?? raw.contact_id ?? null,
    contact_name: inbound.contactName ?? raw.contact_name ?? null,
    conversation_id: inbound.deliveryContext?.conversationId ?? inbound.sessionId,
    event: raw.event ?? inbound.trigger ?? "message_created",
    message: inbound.text,
    message_type: raw.message_type ?? "incoming"
  };
}

function buildTurnOutputPayload(record: TraceRecord): Record<string, unknown> {
  const state = pickLastEventPayload(record, "workflow_result") ?? {};
  const outcome = record.outcome;

  return {
    active_goal: state.active_goal ?? outcome?.stateSnapshot.activeGoal ?? "",
    actor_id: state.actor_id ?? record.inbound.actorId,
    appointment_payload: state.appointment_payload ?? outcome?.artifacts.appointment_payload ?? {},
    appointment_slots: state.appointment_slots ?? outcome?.stateSnapshot.appointmentSlots ?? {},
    confidence: state.confidence ?? outcome?.confidence ?? 0,
    contact_name: state.contact_name ?? record.inbound.contactName ?? "",
    handoff_required: state.handoff_required ?? outcome?.handoffRequired ?? false,
    intent: state.intent ?? outcome?.intent ?? "conversation",
    last_assistant_message: state.last_assistant_message ?? outcome?.stateSnapshot.lastAssistantMessage ?? "",
    last_tool_result: state.last_tool_result ?? outcome?.stateSnapshot.lastToolResult ?? "",
    last_user_message: state.last_user_message ?? record.inbound.text,
    needs_retrieval: state.needs_retrieval ?? false,
    next_node: state.next_node ?? outcome?.capability ?? "conversation",
    pending_action: state.pending_action ?? outcome?.stateSnapshot.pendingAction ?? "",
    pending_question: state.pending_question ?? outcome?.stateSnapshot.pendingQuestion ?? "",
    recalled_memories: state.recalled_memories ?? [],
    recent_turns: state.recent_turns ?? outcome?.stateSnapshot.recentTurns ?? [],
    response_preview: compactText(String(state.response_text ?? outcome?.responseText ?? ""), 200),
    response_text: state.response_text ?? outcome?.responseText ?? "",
    routing_reason: state.routing_reason ?? outcome?.artifacts.routing_reason ?? "",
    session_id: state.session_id ?? record.inbound.sessionId,
    stage: state.stage ?? outcome?.stateSnapshot.stage ?? "",
    state_update: state.state_update ?? {},
    summary: state.summary ?? outcome?.stateSnapshot.summary ?? "",
    summary_refresh_requested: state.summary_refresh_requested ?? false,
    turn_count: state.turn_count ?? outcome?.stateSnapshot.turnCount ?? 0
  };
}

function toFragmentKind(event: string): string {
  const [kind] = event.split(".", 1);
  return kind || "trace";
}

function buildTraceFragments(record: TraceRecord): TraceFragmentRow[] {
  return record.events.map((event, index) => {
    const payload = toRecord(event.payload) ?? { value: event.payload };
    return {
      order: index,
      kind: toFragmentKind(event.event),
      label: event.event,
      createdAt: event.timestamp,
      latencyMs: typeof payload.latency_ms === "number" ? payload.latency_ms : null,
      payload
    };
  });
}

function buildTraceExamples(record: TraceRecord, projectorVersion: string): TraceExampleRow[] {
  const rows: TraceExampleRow[] = [];
  const maybePush = (
    taskName: string,
    inputLabel: string,
    outputLabel: string,
    metadata: Record<string, unknown>,
    rawInput?: (servedInput: Record<string, unknown>) => Record<string, unknown> | null
  ) => {
    const inputPayload = pickFirstEventPayload(record, inputLabel);
    const outputPayload = pickLastEventPayload(record, outputLabel);
    if (!inputPayload || !outputPayload) {
      return;
    }
    rows.push({
      taskName,
      createdAt: pickFirstEventTimestamp(record, outputLabel) ?? record.completedAt ?? record.startedAt,
      inputPayload,
      targetPayload: outputPayload,
      metadataPayload: withRawInputMetadata(
        inputPayload,
        rawInput?.(inputPayload) ?? null,
        {
          projector_version: projectorVersion,
          ...metadata
        }
      ),
      eligibilityReason: "captured"
    });
  };

  maybePush("route_decision", "clinic.route.input", "clinic.route.output", {
    node: "route",
    reply_mode: pickBackend(record, "clinic.route.meta") ?? "unknown"
  }, (servedInput) => buildRouteRawInput(record, servedInput));
  maybePush("conversation_reply", "clinic.conversation.input", "clinic.conversation.output", {
    node: "conversation",
    reply_mode: pickBackend(record, "clinic.conversation.meta") ?? "unknown"
  }, (servedInput) => buildConversationLikeRawInput(record, "conversation", servedInput));
  maybePush("rag_reply", "clinic.rag.input", "clinic.rag.output", {
    node: "rag",
    reply_mode: pickBackend(record, "clinic.rag.meta") ?? "unknown"
  }, (servedInput) => buildConversationLikeRawInput(record, "rag", servedInput));
  maybePush("appointment_extraction", "clinic.appointment_extraction.input", "clinic.appointment_extraction.output", {
    node: "appointment_extraction",
    reply_mode: "llm"
  }, (servedInput) => buildAppointmentExtractionRawInput(record, servedInput));
  maybePush("appointment_reply", "clinic.appointment_reply.input", "clinic.appointment_reply.output", {
    node: "appointment",
    reply_mode: pickBackend(record, "clinic.appointment_reply.meta") ?? "unknown"
  }, (servedInput) => buildAppointmentReplyRawInput(record, servedInput));
  maybePush("state_summary", "clinic.state_summary.input", "clinic.state_summary.output", {
    node: "state_summary",
    reply_mode: "llm"
  }, (servedInput) => servedInput);

  return rows;
}

function buildTraceTurnMetrics(record: TraceRecord, outputPayload: Record<string, unknown>): Record<string, unknown> {
  return {
    branch: outputPayload.next_node ?? "conversation",
    response_chars: String(outputPayload.response_text ?? "").length
  };
}

function buildTraceTurnTags(outputPayload: Record<string, unknown>): Record<string, unknown> {
  return {
    branch: outputPayload.next_node ?? "conversation",
    intent: outputPayload.intent ?? "conversation"
  };
}

function buildTraceTurnExtra(record: TraceRecord): Record<string, unknown> {
  const outbound = pickLastEventPayload(record, "outbound.emit.result");
  if (!outbound) {
    return {};
  }
  return { outbound };
}

function buildTraceTurnRow(record: TraceRecord, settings: PostgresTraceSettings) {
  const outputPayload = buildTurnOutputPayload(record);
  const examples = settings.projectorsEnabled ? buildTraceExamples(record, settings.projectorVersion) : [];
  const finalNode = String(outputPayload.next_node ?? "conversation");
  const replyBackend =
    pickBackend(record, `clinic.${finalNode}.meta`) ??
    pickBackend(record, "clinic.appointment_reply.meta") ??
    settings.llmFallbackProvider;

  return {
    traceId: record.traceId,
    parentTraceId: record.inbound.parentRunId ?? null,
    sessionKey: record.inbound.sessionId,
    actorKey: record.inbound.actorId,
    appKey: settings.appKey,
    flowKey: finalNode,
    dedupeKey: record.inbound.correlationId ? `${record.inbound.sessionId}:${record.inbound.correlationId}` : null,
    startedAt: record.startedAt,
    completedAt: record.completedAt ?? new Date().toISOString(),
    componentVersion: settings.projectorVersion,
    modelBackend: replyBackend,
    modelName: replyBackend === "dspy" ? settings.dspyModel : settings.llmModel,
    outcome: record.error ? "error" : outputPayload.handoff_required ? "handoff_required" : "completed",
    hasError: Boolean(record.error),
    projectorEligibilitySummary: {
      generated_examples: examples.length,
      tasks: examples.map((example) => example.taskName)
    },
    inputPayload: buildTurnInputPayload(record.inbound),
    outputPayload,
    errorPayload: toRecord(record.error) ?? {},
    metricsPayload: buildTraceTurnMetrics(record, outputPayload),
    tags: buildTraceTurnTags(outputPayload),
    extraPayload: buildTraceTurnExtra(record),
    examples
  };
}

async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export class PostgresTraceSink implements TraceSink {
  private readonly schema: string;
  private readonly traces = new Map<string, TraceRecord>();
  private readonly recent: TraceRecord[] = [];
  private readonly pending = new Map<string, Promise<void>>();
  private queue = Promise.resolve();
  private closed = false;

  constructor(
    private readonly settings: PostgresTraceSettings
  ) {
    this.schema = assertSchemaName(settings.postgres.schema);
  }

  async startTurn(inbound: InboundMessage): Promise<string> {
    const traceId = crypto.randomUUID();
    this.traces.set(traceId, createTraceRecord(traceId, inbound));
    return traceId;
  }

  async append(traceId: string, event: string, payload: unknown): Promise<void> {
    appendTraceEvent(this.requireTrace(traceId), event, payload);
  }

  async projectRouteDecision(traceId: string, decision: RouteDecision): Promise<void> {
    projectRouteDecision(this.requireTrace(traceId), traceId, decision);
  }

  async projectReply(traceId: string, outcome: TurnOutcome, inbound: InboundMessage): Promise<void> {
    projectReply(this.requireTrace(traceId), traceId, outcome, inbound);
  }

  async endTurn(traceId: string, outcome: TurnOutcome): Promise<void> {
    markTraceEnded(this.requireTrace(traceId), outcome);
  }

  async failTurn(traceId: string, error: unknown): Promise<void> {
    markTraceFailed(this.requireTrace(traceId), error);
  }

  async flush(traceId: string): Promise<void> {
    const existing = this.pending.get(traceId);
    if (existing) {
      return existing;
    }

    const liveRecord = this.requireTrace(traceId);
    if (liveRecord.persistStatus === "persisted") {
      return;
    }

    liveRecord.persistStatus = "queued";
    const snapshot = cloneTraceRecord(liveRecord);

    const task = this.enqueue(async () => {
      try {
        await raceWithTimeout(
          this.persistRecord(snapshot),
          this.settings.flushTimeoutMs,
          `Trace flush timed out after ${this.settings.flushTimeoutMs}ms`
        );
        liveRecord.persistStatus = "persisted";
        this.traces.delete(traceId);
        this.pushRecent({
          ...snapshot,
          persistStatus: "persisted",
          persistError: undefined
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown_trace_flush_error";
        liveRecord.persistStatus = "failed";
        liveRecord.persistError = detail;
        this.pushRecent({
          ...snapshot,
          persistStatus: "failed",
          persistError: detail,
          error: serializeError(error)
        });
        throw error;
      } finally {
        this.pending.delete(traceId);
      }
    });

    this.pending.set(traceId, task);
    return task;
  }

  async health(): Promise<HealthStatus> {
    if (!this.settings.postgres.connectionString) {
      return {
        ok: false,
        details: {
          backend: "postgres",
          reason: "missing_connection_string"
        }
      };
    }

    const client = this.createClient(this.settings.postgres.healthTimeoutMs);
    try {
      await raceWithTimeout(client.connect(), this.settings.postgres.healthTimeoutMs, "postgres trace health connect timeout");
      await raceWithTimeout(client.query("select 1 as ok"), this.settings.postgres.healthTimeoutMs, "postgres trace health query timeout");
      return {
        ok: true,
        details: {
          backend: "postgres",
          pending_flushes: this.pending.size
        }
      };
    } catch (error) {
      return {
        ok: false,
        details: {
          backend: "postgres",
          error: error instanceof Error ? error.message : "unknown_error",
          pending_flushes: this.pending.size
        }
      };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async close(timeoutMs = this.settings.flushTimeoutMs): Promise<void> {
    this.closed = true;
    await Promise.race([
      this.queue,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      })
    ]);
  }

  getSnapshot(): TraceRecord[] {
    return [...this.traces.values(), ...this.recent];
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const queued = this.queue.then(task, task);
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  private pushRecent(record: TraceRecord): void {
    this.recent.unshift(record);
    if (this.recent.length > this.settings.recentLimit) {
      this.recent.length = this.settings.recentLimit;
    }
  }

  private requireTrace(traceId: string): TraceRecord {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }
    return trace;
  }

  private createClient(queryTimeoutMs: number): Client {
    return new Client({
      connectionString: this.settings.postgres.connectionString,
      connectionTimeoutMillis: this.settings.postgres.connectTimeoutMs,
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
      keepAlive: false,
      application_name: `${this.settings.appKey}-trace`
    });
  }

  private async persistRecord(record: TraceRecord): Promise<void> {
    if (this.closed) {
      throw new Error("Trace sink is closing");
    }
    if (!this.settings.postgres.connectionString) {
      throw new Error("TRACE_POSTGRES_URL is required when TRACE_BACKEND=postgres");
    }

    const traceTurn = buildTraceTurnRow(record, this.settings);
    const fragments = buildTraceFragments(record);
    const client = this.createClient(this.settings.postgres.queryTimeoutMs);
    const schema = quoteIdentifier(this.schema);

    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `insert into ${schema}.trace_turns (
          trace_id,
          parent_trace_id,
          session_key,
          actor_key,
          app_key,
          flow_key,
          dedupe_key,
          started_at,
          completed_at,
          component_version,
          model_backend,
          model_name,
          outcome,
          has_error,
          projector_eligibility_summary,
          input_payload,
          output_payload,
          error_payload,
          metrics_payload,
          tags,
          extra_payload
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb
        )
        on conflict (trace_id) do update set
          parent_trace_id = excluded.parent_trace_id,
          session_key = excluded.session_key,
          actor_key = excluded.actor_key,
          app_key = excluded.app_key,
          flow_key = excluded.flow_key,
          dedupe_key = excluded.dedupe_key,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          component_version = excluded.component_version,
          model_backend = excluded.model_backend,
          model_name = excluded.model_name,
          outcome = excluded.outcome,
          has_error = excluded.has_error,
          projector_eligibility_summary = excluded.projector_eligibility_summary,
          input_payload = excluded.input_payload,
          output_payload = excluded.output_payload,
          error_payload = excluded.error_payload,
          metrics_payload = excluded.metrics_payload,
          tags = excluded.tags,
          extra_payload = excluded.extra_payload`,
        [
          traceTurn.traceId,
          traceTurn.parentTraceId,
          traceTurn.sessionKey,
          traceTurn.actorKey,
          traceTurn.appKey,
          traceTurn.flowKey,
          traceTurn.dedupeKey,
          traceTurn.startedAt,
          traceTurn.completedAt,
          traceTurn.componentVersion,
          traceTurn.modelBackend,
          traceTurn.modelName,
          traceTurn.outcome,
          traceTurn.hasError,
          JSON.stringify(traceTurn.projectorEligibilitySummary),
          JSON.stringify(traceTurn.inputPayload),
          JSON.stringify(traceTurn.outputPayload),
          JSON.stringify(traceTurn.errorPayload),
          JSON.stringify(traceTurn.metricsPayload),
          JSON.stringify(traceTurn.tags),
          JSON.stringify(traceTurn.extraPayload)
        ]
      );

      await client.query(`delete from ${schema}.trace_fragments where trace_id = $1`, [record.traceId]);
      await client.query(`delete from ${schema}.trace_examples where trace_id = $1`, [record.traceId]);

      for (const fragment of fragments) {
        await client.query(
          `insert into ${schema}.trace_fragments (
            trace_id,
            "order",
            kind,
            label,
            created_at,
            latency_ms,
            token_usage,
            payload
          ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
          [
            record.traceId,
            fragment.order,
            fragment.kind,
            fragment.label,
            fragment.createdAt,
            fragment.latencyMs,
            JSON.stringify({}),
            JSON.stringify(fragment.payload)
          ]
        );
      }

      for (const example of traceTurn.examples) {
        await client.query(
          `insert into ${schema}.trace_examples (
            trace_id,
            task_name,
            projector_version,
            created_at,
            split,
            quality_label,
            input_payload,
            target_payload,
            metadata_payload,
            eligibility_reason
          ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
          [
            record.traceId,
            example.taskName,
            this.settings.projectorVersion,
            example.createdAt,
            "train",
            null,
            JSON.stringify(example.inputPayload),
            JSON.stringify(example.targetPayload),
            JSON.stringify(example.metadataPayload),
            example.eligibilityReason
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
}
