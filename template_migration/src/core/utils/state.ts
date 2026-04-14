import type { ShortTermState, TurnRecord } from "../../domain/contracts";

export function createEmptyState(): ShortTermState {
  return {
    summary: "",
    recentTurns: [],
    continuitySignals: [],
    turnCount: 0
  };
}

export function appendTurn(state: ShortTermState, turn: TurnRecord, recentLimit: number): ShortTermState {
  return {
    ...state,
    recentTurns: [...state.recentTurns, turn].slice(-recentLimit),
    turnCount: state.turnCount + (turn.role === "user" ? 1 : 0)
  };
}

export function mergeState(state: ShortTermState, patch?: Partial<ShortTermState>): ShortTermState {
  if (!patch) return state;
  return {
    ...state,
    ...patch,
    recentTurns: patch.recentTurns ?? state.recentTurns,
    continuitySignals: patch.continuitySignals ?? state.continuitySignals
  };
}
