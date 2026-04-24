import { describe, expect, test } from "bun:test";
import type {
  AddMemoryResult,
  ClinicMemoryRecord,
  GeneratedReply,
  MemoryHit,
  StateRoutingDecision,
  TurnRecord
} from "../src/domain/contracts";
import type { ClinicLlmService, MemoryProvider } from "../src/domain/ports";
import { ProviderBackedClinicMemoryRuntime } from "../src/core/services/provider-backed-clinic-memory-runtime";
import { buildTestSettings } from "./test-settings";

class StubMemoryProvider implements MemoryProvider {
  readonly searchCalls: Array<Record<string, unknown>> = [];
  readonly addCalls: Array<Record<string, unknown>> = [];

  constructor(
    private readonly hits: MemoryHit[] = [],
    private readonly addResult: AddMemoryResult = { stored: true, count: 2 }
  ) {}

  async addTurn(messages: TurnRecord[], actorId: string, agentId: string, sessionId: string, metadata: Record<string, unknown>): Promise<AddMemoryResult> {
    this.addCalls.push({ messages, actorId, agentId, sessionId, metadata });
    return this.addResult;
  }

  async search(query: string, actorId: string, agentId: string, topK: number, threshold: number): Promise<MemoryHit[]> {
    this.searchCalls.push({ query, actorId, agentId, topK, threshold });
    return this.hits;
  }
}

class StubClinicLlmService implements ClinicLlmService {
  async classifyStateRoute(): Promise<StateRoutingDecision> {
    throw new Error("not_implemented");
  }
  async generateConversationReply(): Promise<GeneratedReply> {
    throw new Error("not_implemented");
  }
  async generateRagReply(): Promise<GeneratedReply> {
    throw new Error("not_implemented");
  }
  async extractAppointmentPayload(): Promise<{
    patient_name?: string | null;
    reason?: string | null;
    preferred_date?: string | null;
    preferred_time?: string | null;
    missing_fields: string[];
    should_handoff: boolean;
    confidence: number;
  }> {
    throw new Error("not_implemented");
  }
  async generateAppointmentReply(): Promise<GeneratedReply> {
    throw new Error("not_implemented");
  }
  async buildStateSummary(): Promise<string> {
    return "summary-from-llm";
  }
}

describe("ProviderBackedClinicMemoryRuntime", () => {
  test("loads long-term memories from the configured memory provider", async () => {
    const settings = buildTestSettings({
      memory: {
        provider: "mem0",
        enabled: true,
        agentId: "eros-assistant",
        topK: 5,
        scoreThreshold: 0,
        mem0: {
          baseUrl: "https://mem0.example.com",
          apiKey: "secret",
          authMode: "token",
          orgId: "",
          projectId: "",
          searchPath: "/v1/memories/search",
          addPath: "/v1/memories"
        }
      }
    });
    const provider = new StubMemoryProvider([
      {
        id: "mem-1",
        memory: "Prefiere respuestas breves",
        score: 0.91,
        metadata: { kind: "profile" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ]);
    const runtime = new ProviderBackedClinicMemoryRuntime(settings.memory, provider, new StubClinicLlmService());

    const result = await runtime.loadContext(
      "session-1",
      "actor-1",
      "quiero retomar mi tratamiento",
      {
        summary: "",
        recentTurns: [],
        continuitySignals: [],
        turnCount: 3
      }
    );

    expect(provider.searchCalls).toHaveLength(1);
    expect(result.recalled_memories).toEqual(["Prefiere respuestas breves"]);
    expect(result.raw_records).toEqual<ClinicMemoryRecord[]>([
      {
        kind: "profile",
        text: "Prefiere respuestas breves",
        source: "mem0",
        created_at: "2026-01-01T00:00:00.000Z",
        metadata: {
          kind: "profile",
          id: "mem-1",
          score: 0.91,
          updated_at: "2026-01-01T00:00:00.000Z"
        }
      }
    ]);
    expect(result.turn_count).toBe(4);
  });

  test("commits turns through the configured memory provider instead of local RAM", async () => {
    const settings = buildTestSettings({
      memory: {
        provider: "mem0",
        enabled: true,
        agentId: "eros-assistant",
        topK: 5,
        scoreThreshold: 0,
        mem0: {
          baseUrl: "https://mem0.example.com",
          apiKey: "secret",
          authMode: "token",
          orgId: "",
          projectId: "",
          searchPath: "/v1/memories/search",
          addPath: "/v1/memories"
        }
      }
    });
    const provider = new StubMemoryProvider([], { stored: true, count: 2 });
    const runtime = new ProviderBackedClinicMemoryRuntime(settings.memory, provider, new StubClinicLlmService());

    const result = await runtime.commitTurn(
      "session-1",
      "actor-1",
      {
        user_message: "Quiero reagendar mi cita",
        assistant_message: "Claro, te ayudo con eso",
        route: "appointment"
      },
      {
        summary: "Resumen previo",
        recentTurns: [],
        activeGoal: "appointment",
        stage: "collecting_slots",
        continuitySignals: [],
        turnCount: 2
      },
      {
        handoff_required: true,
        refresh_summary: false
      }
    );

    expect(provider.addCalls).toHaveLength(1);
    expect(provider.addCalls[0]?.messages).toEqual([
      {
        role: "user",
        text: "Quiero reagendar mi cita",
        timestamp: expect.any(String)
      },
      {
        role: "assistant",
        text: "Claro, te ayudo con eso",
        timestamp: expect.any(String)
      }
    ]);
    expect(result.stored_records.map((record) => record.source)).toEqual(["mem0", "mem0"]);
    expect(result.stored_records.map((record) => record.kind)).toEqual(["profile", "episode"]);
    expect(result.turn_count).toBe(2);
  });
});
