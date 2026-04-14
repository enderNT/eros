import type { InboundMessage, RouteDecision, TurnOutcome } from "../../domain/contracts";

export interface TraceEventRecord {
  event: string;
  payload: unknown;
  timestamp: string;
}

export interface TraceProjectedRecord {
  route_decision: unknown[];
  conversation_reply: unknown[];
  knowledge_reply: unknown[];
  action_reply: unknown[];
  state_summary: unknown[];
}

export interface TraceRecord {
  traceId: string;
  startedAt: string;
  inbound: InboundMessage;
  events: TraceEventRecord[];
  projected: TraceProjectedRecord;
  outcome?: TurnOutcome;
  error?: unknown;
  completedAt?: string;
  persistStatus?: "open" | "queued" | "persisted" | "failed";
  persistError?: string;
}

export function createTraceRecord(traceId: string, inbound: InboundMessage): TraceRecord {
  return {
    traceId,
    startedAt: new Date().toISOString(),
    inbound,
    events: [],
    projected: {
      route_decision: [],
      conversation_reply: [],
      knowledge_reply: [],
      action_reply: [],
      state_summary: []
    },
    persistStatus: "open"
  };
}

export function appendTraceEvent(record: TraceRecord, event: string, payload: unknown): void {
  record.events.push({
    event,
    payload,
    timestamp: new Date().toISOString()
  });
}

export function projectRouteDecision(record: TraceRecord, traceId: string, decision: RouteDecision): void {
  record.projected.route_decision.push({
    traceId,
    capability: decision.capability,
    intent: decision.intent,
    confidence: decision.confidence,
    reason: decision.reason
  });
}

export function projectReply(record: TraceRecord, traceId: string, outcome: TurnOutcome, inbound: InboundMessage): void {
  record.projected[`${outcome.capability}_reply` as "conversation_reply"].push({
    traceId,
    capability: outcome.capability,
    inputText: inbound.text,
    responseText: outcome.responseText
  });
  record.projected.state_summary.push({
    traceId,
    summary: outcome.stateSnapshot.summary,
    turnCount: outcome.stateSnapshot.turnCount
  });
}

export function markTraceEnded(record: TraceRecord, outcome: TurnOutcome): void {
  record.outcome = outcome;
  record.completedAt = new Date().toISOString();
}

export function markTraceFailed(record: TraceRecord, error: unknown): void {
  record.error = serializeError(error);
  record.completedAt = new Date().toISOString();
}

export function cloneTraceRecord(record: TraceRecord): TraceRecord {
  return structuredClone(record);
}

export function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return error;
}
