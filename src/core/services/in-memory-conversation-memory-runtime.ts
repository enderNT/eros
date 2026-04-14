import type {
  ClinicMemoryRecord,
  MemoryCommitResult,
  MemoryContext,
  ShortTermState,
  TurnMemoryInput
} from "../../domain/contracts";
import type { ClinicLlmService, ClinicMemoryRuntime } from "../../domain/ports";

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

  constructor(private readonly llmService: ClinicLlmService) {}

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
    domainState: Record<string, unknown>
  ): Promise<MemoryCommitResult> {
    let summary = shortTerm.summary;
    if (domainState.refresh_summary === true) {
      summary = await this.llmService.buildStateSummary({
        current_summary: shortTerm.summary,
        user_message: turn.user_message,
        assistant_message: turn.assistant_message,
        active_goal: shortTerm.activeGoal ?? "",
        stage: shortTerm.stage ?? ""
      });
    }

    const stored_records: ClinicMemoryRecord[] = [];
    const created_at = new Date().toISOString();
    const profileCandidate = compact(turn.user_message, 220);
    const episodeCandidate = compact(`${turn.user_message} | ${turn.assistant_message}`, 320);

    if (profileCandidate.length >= 12) {
      const record: StoredMemory = {
        actor_id: actorId,
        kind: "profile",
        text: profileCandidate,
        source: "stateful-flow",
        created_at,
        metadata: {
          route: turn.route
        }
      };
      this.memories.push(record);
      stored_records.push(record);
    }

    if (domainState.handoff_required === true && episodeCandidate.length >= 18) {
      const record: StoredMemory = {
        actor_id: actorId,
        kind: "episode",
        text: episodeCandidate,
        source: "stateful-flow",
        created_at,
        metadata: {
          route: turn.route
        }
      };
      this.memories.push(record);
      stored_records.push(record);
    }

    return {
      summary,
      stored_records,
      turn_count: shortTerm.turnCount
    };
  }
}
