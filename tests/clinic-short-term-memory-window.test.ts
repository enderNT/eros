import { describe, expect, test } from "bun:test";
import type {
  ClinicGraphNode,
  GeneratedReply,
  GraphState,
  MemoryCommitResult,
  MemoryContext,
  StateRoutingDecision
} from "../src/domain/contracts";
import type {
  ClinicDspyBridge,
  ClinicKnowledgeProvider,
  ClinicLlmService,
  ClinicMemoryRuntime,
  ClinicRoutingService,
  OutboundTransport
} from "../src/domain/ports";
import { ClinicOrchestrator } from "../src/core/clinic-orchestrator";
import { InMemoryClinicStateStore } from "../src/core/services/in-memory-clinic-state-store";
import { InMemoryTraceSink } from "../src/core/services/in-memory-trace-sink";
import { OperationalLogger } from "../src/core/services/operational-logger";
import { ClinicWorkflow } from "../src/core/services/clinic-workflow";
import { buildTestSettings } from "./test-settings";

class RecordingWorkflow {
  recordedState: GraphState | null = null;

  async run(initialState: GraphState) {
    this.recordedState = structuredClone(initialState);
    return {
      state: {
        ...initialState,
        response_text: "respuesta generada",
        last_assistant_message: "respuesta generada"
      },
      diagnostics: {}
    };
  }
}

class StubRoutingService implements ClinicRoutingService {
  async routeState(): Promise<StateRoutingDecision> {
    return {
      next_node: "conversation",
      intent: "conversation",
      confidence: 0.9,
      needs_retrieval: false,
      state_update: {},
      reason: "test"
    };
  }

  summarizeMemories(memories: string[]): string[] {
    return memories;
  }
}

class StubClinicLlmService implements ClinicLlmService {
  readonly summaryCalls: Array<Record<string, string>> = [];

  async classifyStateRoute(): Promise<StateRoutingDecision> {
    throw new Error("not_implemented");
  }

  async generateConversationReply(): Promise<GeneratedReply> {
    return {
      response_text: "respuesta nueva",
      reply_mode: "llm"
    };
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

  async buildStateSummary(input: {
    current_summary: string;
    user_message: string;
    assistant_message: string;
    active_goal: string;
    stage: string;
  }): Promise<string> {
    this.summaryCalls.push(input);
    const fragment = `Usuario: ${input.user_message} Asistente: ${input.assistant_message}`.trim();
    return [input.current_summary, fragment].filter(Boolean).join(" | ");
  }
}

class StubClinicMemoryRuntime implements ClinicMemoryRuntime {
  readonly commitCalls: Array<{
    shortTermSummary: string;
    recentTurns: Array<{ role: "user"; text: string; timestamp: string }>;
  }> = [];

  async loadContext(
    _sessionId: string,
    _actorId: string,
    _query: string,
    shortTerm: {
      summary: string;
      recentTurns: Array<{ role: "user"; text: string; timestamp: string }>;
      turnCount: number;
    }
  ): Promise<MemoryContext> {
    return {
      recalled_memories: [],
      raw_records: [],
      turn_count: shortTerm.turnCount + 1
    };
  }

  async commitTurn(
    _sessionId: string,
    _actorId: string,
    _turn: {
      user_message: string;
      assistant_message: string;
      route: ClinicGraphNode;
    },
    shortTerm: {
      summary: string;
      recentTurns: Array<{ role: "user"; text: string; timestamp: string }>;
      turnCount: number;
    }
  ): Promise<MemoryCommitResult> {
    this.commitCalls.push({
      shortTermSummary: shortTerm.summary,
      recentTurns: shortTerm.recentTurns
    });
    return {
      summary: shortTerm.summary,
      stored_records: [],
      turn_count: shortTerm.turnCount
    };
  }
}

class StubKnowledgeProvider implements ClinicKnowledgeProvider {
  async buildContext() {
    return {
      text: "",
      backend: "simulate" as const,
      status: "simulated" as const,
      resultCount: 0,
      fallbackUsed: false
    };
  }
}

class StubDspyBridge implements ClinicDspyBridge {
  async health(): Promise<boolean> {
    return false;
  }

  async predictStateRouter(): Promise<StateRoutingDecision | null> {
    return null;
  }

  async predictConversationReply(): Promise<GeneratedReply | null> {
    return null;
  }

  async predictRagReply(): Promise<GeneratedReply | null> {
    return null;
  }

  async predictAppointmentReply(): Promise<GeneratedReply | null> {
    return null;
  }
}

function createGraphState(): GraphState {
  return {
    session_id: "session-1",
    actor_id: "actor-1",
    contact_name: "Paciente",
    last_user_message: "nuevo turno",
    last_assistant_message: "respuesta previa",
    summary: "",
    active_goal: "conversation",
    stage: "open",
    pending_action: "",
    pending_question: "",
    appointment_slots: {},
    last_tool_result: "",
    recalled_memories: [],
    next_node: "conversation",
    intent: "conversation",
    confidence: 0.9,
    needs_retrieval: false,
    routing_reason: "",
    state_update: {},
    response_text: "",
    appointment_payload: {},
    handoff_required: false,
    turn_count: 5,
    summary_refresh_requested: false,
    recent_turns: [
      { user: "u1", assistant: "a1" },
      { user: "u2", assistant: "a2" },
      { user: "u3", assistant: "a3" },
      { user: "u4", assistant: "a4" },
      { user: "u5", assistant: "a5" }
    ]
  };
}

describe("clinic short-term memory window", () => {
  test("builds initial clinic state with only the last five turns and summarizes older history", async () => {
    const settings = buildTestSettings();
    const workflow = new RecordingWorkflow();
    const orchestrator = new ClinicOrchestrator(
      new InMemoryClinicStateStore(),
      workflow as unknown as ClinicWorkflow,
      { emit: async () => undefined } satisfies OutboundTransport,
      new InMemoryTraceSink(),
      new OperationalLogger(settings)
    );

    await orchestrator.processTurn({
      sessionId: "session-1",
      actorId: "actor-1",
      channel: "test",
      text: "turno actual",
      rawPayload: {},
      receivedAt: new Date().toISOString(),
      deliveryContext: {
        provider: "test",
        history: [
          { role: "user", text: "u1" },
          { role: "assistant", text: "a1" },
          { role: "user", text: "u2" },
          { role: "assistant", text: "a2" },
          { role: "user", text: "u3" },
          { role: "assistant", text: "a3" },
          { role: "user", text: "u4" },
          { role: "assistant", text: "a4" },
          { role: "user", text: "u5" },
          { role: "assistant", text: "a5" },
          { role: "user", text: "u6" },
          { role: "assistant", text: "a6" },
          { role: "user", text: "u7" },
          { role: "assistant", text: "a7" }
        ]
      }
    });

    expect(workflow.recordedState).not.toBeNull();
    expect(workflow.recordedState?.recent_turns.map((turn) => turn.user)).toEqual(["u3", "u4", "u5", "u6", "u7"]);
    expect(workflow.recordedState?.summary).toContain("Usuario: u1 Asistente: a1");
    expect(workflow.recordedState?.summary).toContain("Usuario: u2 Asistente: a2");
    expect(workflow.recordedState?.turn_count).toBe(7);
  });

  test("folds overflow turns into summary while keeping a five-turn window", async () => {
    const settings = buildTestSettings({
      prompt: {
        memoryMaxItems: 3,
        memoryBudgetChars: 1200,
        recentTurnsLimit: 9,
        summarizeOnOverflow: true
      }
    });
    const llmService = new StubClinicLlmService();
    const memoryRuntime = new StubClinicMemoryRuntime();
    const workflow = new ClinicWorkflow(
      new StubRoutingService(),
      llmService,
      memoryRuntime,
      new StubKnowledgeProvider(),
      new StubDspyBridge(),
      settings
    );

    const result = await workflow.run(createGraphState());

    expect(result.state.recent_turns.map((turn) => turn.user)).toEqual(["u2", "u3", "u4", "u5", "nuevo turno"]);
    expect(result.state.summary).toContain("Usuario: u1 Asistente: a1");
    expect(result.diagnostics.shortTermMemory).toEqual({
      summarizedTurns: 1,
      retainedTurns: 5,
      summaryUpdated: true
    });
    expect(llmService.summaryCalls).toHaveLength(1);
    expect(llmService.summaryCalls[0]?.user_message).toBe("u1");
    expect(memoryRuntime.commitCalls).toHaveLength(1);
    expect(memoryRuntime.commitCalls[0]?.recentTurns).toHaveLength(5);
    expect(memoryRuntime.commitCalls[0]?.shortTermSummary).toContain("Usuario: u1 Asistente: a1");
  });
});
