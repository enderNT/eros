import type { ShortTermState } from "../../domain/contracts";
import type { StateStore } from "../../domain/ports";
import { createEmptyState } from "../utils/state";

export class InMemoryStateStore implements StateStore {
  private readonly stateBySession = new Map<string, ShortTermState>();

  async load(sessionId: string): Promise<ShortTermState> {
    return this.stateBySession.get(sessionId) ?? createEmptyState();
  }

  async save(sessionId: string, state: ShortTermState): Promise<void> {
    this.stateBySession.set(sessionId, state);
  }
}
