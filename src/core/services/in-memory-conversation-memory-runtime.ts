import type {
  ClinicMemoryRecord,
  MemoryCommitResult,
  MemoryContext,
  ShortTermState,
  TurnMemoryInput
} from "../../domain/contracts";
import type { ClinicLlmService, ClinicMemoryRuntime, TraceSink } from "../../domain/ports";
import {
  decideClinicMemoryPersistenceHeuristic,
  shouldEvaluateClinicMemoryWithLlm
} from "./clinic-memory-policy";

interface StoredMemory extends ClinicMemoryRecord {
  actor_id: string;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9áéíóúñü]+/i)
      .filter(Boolean)
  );
}

function scoreMatch(query: string, memory: string): number {
  const queryTokens = tokenize(query);
  const memoryTokens = tokenize(memory);
  if (queryTokens.size === 0 || memoryTokens.size === 0) {
    return 0;
  }

  let overlaps = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) {
      overlaps += 1;
    }
  }

  return overlaps / queryTokens.size;
}

function compact(value: string, limit: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

export class InMemoryConversationMemoryRuntime implements ClinicMemoryRuntime {
  private readonly memories: StoredMemory[] = [];

  constructor(
    private readonly llmService: ClinicLlmService,
    private readonly traceSink?: TraceSink
  ) {}

  async loadContext(
    _sessionId: string,
    actorId: string,
    query: string,
    shortTerm: ShortTermState
  ): Promise<MemoryContext> {
    const raw_records = this.memories
      .filter((memory) => memory.actor_id === actorId)
      .map((memory) => ({ ...memory, score: scoreMatch(query, memory.text) }))
      .filter((memory) => memory.score > 0)
      .sort((left, right) => right.score - left.score || right.created_at.localeCompare(left.created_at))
      .slice(0, 5)
      .map(({ score: _score, ...memory }) => memory);

    return {
      recalled_memories: raw_records.map((record) => record.text),
      raw_records,
      turn_count: shortTerm.turnCount + 1
    };
  }

  async commitTurn(
    _sessionId: string,
    actorId: string,
    turn: TurnMemoryInput,
    shortTerm: ShortTermState,
    domainState: Record<string, unknown>,
    traceId?: string
  ): Promise<MemoryCommitResult> {
    let summary = shortTerm.summary;
    if (domainState.refresh_summary === true) {
      const signaturePayload = {
        current_summary: shortTerm.summary,
        user_message: turn.user_message,
        assistant_message: turn.assistant_message,
        active_goal: shortTerm.activeGoal ?? "",
        stage: shortTerm.stage ?? ""
      };
      if (traceId) {
        await this.traceSink?.append(traceId, "clinic.state_summary.input", signaturePayload);
      }
      summary = await this.llmService.buildStateSummary(signaturePayload);
      if (traceId) {
        await this.traceSink?.append(traceId, "clinic.state_summary.output", {
          updated_summary: summary
        });
      }
    }

    const stored_records: ClinicMemoryRecord[] = [];
    const heuristicDecision = decideClinicMemoryPersistenceHeuristic(turn, shortTerm, domainState);
    const shouldEvaluateWithLlm = shouldEvaluateClinicMemoryWithLlm(turn, shortTerm, domainState);
    if (traceId) {
      await this.traceSink?.append(traceId, "clinic.memory_persistence.input", {
        provider: "in_memory",
        turn,
        handoff_required: domainState.handoff_required === true,
        heuristic_decision: heuristicDecision,
        llm_requested: shouldEvaluateWithLlm
      });
    }
    const llmDecision = shouldEvaluateWithLlm
      ? await this.llmService.decideMemoryPersistence({
          turn,
          short_term: shortTerm,
          handoff_required: domainState.handoff_required === true,
          heuristic_decision: heuristicDecision
        })
      : null;
    const persistenceDecision = llmDecision ?? (
      shouldEvaluateWithLlm
        ? { ...heuristicDecision, source: "heuristic_fallback" as const }
        : heuristicDecision
    );
    if (traceId) {
      await this.traceSink?.append(traceId, "clinic.memory_persistence.output", {
        provider: "in_memory",
        llm_evaluated: shouldEvaluateWithLlm,
        decision: persistenceDecision
      });
    }
    if (!persistenceDecision.shouldStore) {
      return {
        summary,
        stored_records,
        turn_count: shortTerm.turnCount,
        memory_persistence: {
          decision: persistenceDecision,
          llmEvaluated: shouldEvaluateWithLlm,
          providerWriteAttempted: false,
          providerWriteStored: false,
          storedRecordCount: 0,
          provider: "in_memory"
        }
      };
    }

    const created_at = new Date().toISOString();
    const profileCandidate = compact(turn.user_message, 220);
    const episodeCandidate = compact(`${turn.user_message} | ${turn.assistant_message}`, 320);

    if (persistenceDecision.shouldStoreProfile && profileCandidate.length >= 12) {
      const record: StoredMemory = {
        actor_id: actorId,
        kind: "profile",
        text: profileCandidate,
        source: "stateful-flow",
        created_at,
        metadata: {
          route: turn.route,
          memory_reasons: persistenceDecision.reasons
        }
      };
      this.memories.push(record);
      stored_records.push(record);
    }

    if (persistenceDecision.shouldStoreEpisode && episodeCandidate.length >= 18) {
      const record: StoredMemory = {
        actor_id: actorId,
        kind: "episode",
        text: episodeCandidate,
        source: "stateful-flow",
        created_at,
        metadata: {
          route: turn.route,
          memory_reasons: persistenceDecision.reasons
        }
      };
      this.memories.push(record);
      stored_records.push(record);
    }

    return {
      summary,
      stored_records,
      turn_count: shortTerm.turnCount,
      memory_persistence: {
        decision: persistenceDecision,
        llmEvaluated: shouldEvaluateWithLlm,
        providerWriteAttempted: true,
        providerWriteStored: stored_records.length > 0,
        storedRecordCount: stored_records.length,
        provider: "in_memory"
      }
    };
  }
}
