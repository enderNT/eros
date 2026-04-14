import type { InboundMessage, RouteDecision, TurnOutcome } from "../../domain/contracts";
import type { TraceSink } from "../../domain/ports";
import {
  appendTraceEvent,
  createTraceRecord,
  markTraceEnded,
  markTraceFailed,
  projectReply,
  projectRouteDecision,
  type TraceRecord
} from "./trace-record";

export class InMemoryTraceSink implements TraceSink {
  private readonly traces = new Map<string, TraceRecord>();

  async startTurn(inbound: InboundMessage): Promise<string> {
    const traceId = crypto.randomUUID();
    this.traces.set(traceId, createTraceRecord(traceId, inbound));
    return traceId;
  }

  async append(traceId: string, event: string, payload: unknown): Promise<void> {
    const trace = this.requireTrace(traceId);
    appendTraceEvent(trace, event, payload);
  }

  async projectRouteDecision(traceId: string, decision: RouteDecision): Promise<void> {
    const trace = this.requireTrace(traceId);
    projectRouteDecision(trace, traceId, decision);
  }

  async projectReply(traceId: string, outcome: TurnOutcome, inbound: InboundMessage): Promise<void> {
    const trace = this.requireTrace(traceId);
    projectReply(trace, traceId, outcome, inbound);
  }

  async endTurn(traceId: string, outcome: TurnOutcome): Promise<void> {
    const trace = this.requireTrace(traceId);
    markTraceEnded(trace, outcome);
  }

  async failTurn(traceId: string, error: unknown): Promise<void> {
    const trace = this.requireTrace(traceId);
    markTraceFailed(trace, error);
  }

  async flush(_traceId: string): Promise<void> {
    return;
  }

  async health(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    return {
      ok: true,
      details: {
        backend: "in_memory",
        traceCount: this.traces.size
      }
    };
  }

  async close(_timeoutMs?: number): Promise<void> {
    return;
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
