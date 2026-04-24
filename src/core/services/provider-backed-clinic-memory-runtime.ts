import type { AppSettings } from "../../config";
import type {
  ClinicMemoryRecord,
  MemoryCommitResult,
  MemoryContext,
  MemoryHit,
  ShortTermState,
  TurnMemoryInput,
  TurnRecord
} from "../../domain/contracts";
import type { ClinicLlmService, ClinicMemoryRuntime, MemoryProvider, TraceSink } from "../../domain/ports";

function compact(value: string, limit: number): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function toClinicMemoryRecord(provider: string, hit: MemoryHit): ClinicMemoryRecord {
  return {
    kind: hit.metadata.kind === "episode" ? "episode" : "profile",
    text: hit.memory,
    source: provider,
    created_at: hit.createdAt,
    metadata: {
      ...hit.metadata,
      id: hit.id,
      score: hit.score,
      updated_at: hit.updatedAt
    }
  };
}

function buildStoredRecords(
  provider: string,
  actorId: string,
  sessionId: string,
  turn: TurnMemoryInput,
  domainState: Record<string, unknown>,
  stored: boolean,
  count: number
): ClinicMemoryRecord[] {
  if (!stored) {
    return [];
  }

  const created_at = new Date().toISOString();
  const profileText = compact(turn.user_message, 220);
  const episodeText = compact(`${turn.user_message} | ${turn.assistant_message}`, 320);
  const sharedMetadata = {
    actor_id: actorId,
    session_id: sessionId,
    route: turn.route,
    stored_count: count
  };

  const records: ClinicMemoryRecord[] = [];
  if (profileText) {
    records.push({
      kind: "profile",
      text: profileText,
      source: provider,
      created_at,
      metadata: sharedMetadata
    });
  }

  if (domainState.handoff_required === true && episodeText) {
    records.push({
      kind: "episode",
      text: episodeText,
      source: provider,
      created_at,
      metadata: sharedMetadata
    });
  }

  return records;
}

export class ProviderBackedClinicMemoryRuntime implements ClinicMemoryRuntime {
  constructor(
    private readonly settings: AppSettings["memory"],
    private readonly memoryProvider: MemoryProvider,
    private readonly llmService: ClinicLlmService,
    private readonly traceSink?: TraceSink
  ) {}

  async loadContext(
    sessionId: string,
    actorId: string,
    query: string,
    shortTerm: ShortTermState
  ): Promise<MemoryContext> {
    if (!this.settings.enabled) {
      return {
        recalled_memories: [],
        raw_records: [],
        turn_count: shortTerm.turnCount + 1
      };
    }

    const hits = await this.memoryProvider.search(
      query,
      actorId,
      this.settings.agentId,
      this.settings.topK,
      this.settings.scoreThreshold
    );
    const raw_records = hits.map((hit) => toClinicMemoryRecord(this.settings.provider, hit));

    return {
      recalled_memories: raw_records.map((record) => record.text),
      raw_records,
      turn_count: shortTerm.turnCount + 1
    };
  }

  async commitTurn(
    sessionId: string,
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

    if (!this.settings.enabled) {
      return {
        summary,
        stored_records: [],
        turn_count: shortTerm.turnCount
      };
    }

    const messages = [
      {
        role: "user" as const,
        text: turn.user_message,
        timestamp: new Date().toISOString()
      },
      {
        role: "assistant" as const,
        text: turn.assistant_message,
        timestamp: new Date().toISOString()
      }
    ] satisfies TurnRecord[];
    const nonEmptyMessages = messages.filter((message) => message.text.trim().length > 0);

    const addResult = await this.memoryProvider.addTurn(
      nonEmptyMessages,
      actorId,
      this.settings.agentId,
      sessionId,
      {
        route: turn.route,
        handoff_required: domainState.handoff_required === true,
        source: "clinic_workflow"
      }
    );

    return {
      summary,
      stored_records: buildStoredRecords(
        this.settings.provider,
        actorId,
        sessionId,
        turn,
        domainState,
        addResult.stored,
        addResult.count
      ),
      turn_count: shortTerm.turnCount
    };
  }
}
