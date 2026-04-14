import type { GraphState } from "../../domain/contracts";
import type { ClinicStateStore } from "../../domain/ports";

export class InMemoryClinicStateStore implements ClinicStateStore {
  private readonly stateBySession = new Map<string, GraphState>();

  async load(sessionId: string): Promise<GraphState | null> {
    return this.stateBySession.get(sessionId) ?? null;
  }

  async save(sessionId: string, state: GraphState): Promise<void> {
    this.stateBySession.set(sessionId, structuredClone(state));
  }

  async health(): Promise<{ ok: boolean; details?: Record<string, unknown> }> {
    return {
      ok: true,
      details: {
        backend: "in_memory",
        sessions: this.stateBySession.size
      }
    };
  }

  async close(_timeoutMs?: number): Promise<void> {
    return;
  }
}
