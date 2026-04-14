import type { InboundMessage, RouteDecision, TurnOutcome } from "../../domain/contracts";
import type { TraceSink } from "../../domain/ports";

interface TraceRecord {
  traceId: string;
  startedAt: string;
  inbound: InboundMessage;
  events: Array<{ event: string; payload: unknown; timestamp: string }>;
  projected: {
    route_decision: unknown[];
    conversation_reply: unknown[];
    knowledge_reply: unknown[];
    action_reply: unknown[];
    state_summary: unknown[];
  };
  outcome?: TurnOutcome;
  error?: unknown;
}

export class InMemoryTraceSink implements TraceSink {
  private readonly traces = new Map<string, TraceRecord>();

  async startTurn(inbound: InboundMessage): Promise<string> {
    const traceId = crypto.randomUUID();
    this.traces.set(traceId, {
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
      }
    });
    return traceId;
  }

  async append(traceId: string, event: string, payload: unknown): Promise<void> {
    const trace = this.requireTrace(traceId);
    trace.events.push({ event, payload, timestamp: new Date().toISOString() });
  }

  async projectRouteDecision(traceId: string, decision: RouteDecision): Promise<void> {
    const trace = this.requireTrace(traceId);
    trace.projected.route_decision.push({
      traceId,
      capability: decision.capability,
      intent: decision.intent,
      confidence: decision.confidence,
      reason: decision.reason
    });
  }

  async projectReply(traceId: string, outcome: TurnOutcome, inbound: InboundMessage): Promise<void> {
    const trace = this.requireTrace(traceId);
    trace.projected[`${outcome.capability}_reply` as "conversation_reply"].push({
      traceId,
      capability: outcome.capability,
      inputText: inbound.text,
      responseText: outcome.responseText
    });
    trace.projected.state_summary.push({
      traceId,
      summary: outcome.stateSnapshot.summary,
      turnCount: outcome.stateSnapshot.turnCount
    });
  }

  async endTurn(traceId: string, outcome: TurnOutcome): Promise<void> {
    const trace = this.requireTrace(traceId);
    trace.outcome = outcome;
  }

  async failTurn(traceId: string, error: unknown): Promise<void> {
    const trace = this.requireTrace(traceId);
    trace.error = error;
  }

  getSnapshot(): TraceRecord[] {
    return [...this.traces.values()];
  }

  private requireTrace(traceId: string): TraceRecord {
    const trace = this.traces.get(traceId);
    if (!trace) {
      throw new Error(`Trace not found: ${traceId}`);
    }
    return trace;
  }
}
