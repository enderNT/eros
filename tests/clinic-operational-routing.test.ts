import { describe, expect, test } from "bun:test";
import type {
  ClinicGraphNode,
  GeneratedReply,
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

class StubRoutingService implements ClinicRoutingService {
  constructor(private readonly decision: StateRoutingDecision) {}

  async routeState(): Promise<StateRoutingDecision> {
    return this.decision;
  }

  summarizeMemories(memories: string[]): string[] {
    return memories;
  }
}

class StubClinicLlmService implements ClinicLlmService {
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

  async buildStateSummary(): Promise<string> {
    return "summary";
  }
}

class StubClinicMemoryRuntime implements ClinicMemoryRuntime {
  async loadContext(
    _sessionId: string,
    _actorId: string,
    _query: string,
    shortTerm: { turnCount: number }
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
      turnCount: number;
    }
  ): Promise<MemoryCommitResult> {
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

function createLoggerHarness() {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const settings = buildTestSettings({
    logging: {
      backend: "postgres",
      consoleEnabled: false,
      directory: "./tmp-test-logs",
      fileName: "app.log",
      maxFiles: 2,
      maxLinesPerFile: 50,
      instanceId: "",
      containerName: "",
      containerId: "",
      hostName: "test-host"
    },
    trace: {
      postgres: {
        connectionString: "postgres://example/test",
        schema: "tracing",
        connectTimeoutMs: 100,
        queryTimeoutMs: 100,
        healthTimeoutMs: 100
      }
    }
  });

  const logger = new OperationalLogger(settings, {
    createPostgresClient: () => ({
      async connect() {},
      async query(text: string, values?: unknown[]) {
        queries.push({
          text: text.replace(/\s+/g, " ").trim(),
          values
        });
        return {};
      },
      async end() {}
    })
  });

  return { logger, queries, settings };
}

function extractEntries(queries: Array<{ text: string; values?: unknown[] }>) {
  return queries
    .filter(({ text }) => text.includes("insert into \"tracing\".\"operational_log_entries\""))
    .map(({ values }) => ({
      runId: values?.[0] as string | null,
      seq: values?.[1] as number | null,
      title: values?.[3] as string,
      payload: values?.[8] ? JSON.parse(String(values[8])) as Record<string, unknown> : {}
    }));
}

function buildOrchestrator(
  logger: OperationalLogger,
  settings: ReturnType<typeof buildTestSettings>,
  decision: StateRoutingDecision
) {
  const traceSink = new InMemoryTraceSink();
  const workflow = new ClinicWorkflow(
    new StubRoutingService(decision),
    new StubClinicLlmService(),
    new StubClinicMemoryRuntime(),
    new StubKnowledgeProvider(),
    new StubDspyBridge(),
    settings,
    traceSink
  );

  return new ClinicOrchestrator(
    new InMemoryClinicStateStore(),
    workflow,
    {
      emit: async () => ({
        status: "sent",
        destination: "test",
        response: { ok: true }
      })
    } satisfies OutboundTransport,
    traceSink,
    logger
  );
}

function buildInbound() {
  return {
    sessionId: "session-1",
    actorId: "actor-1",
    channel: "test",
    text: "Necesito ayuda con una cita",
    rawPayload: {},
    receivedAt: new Date().toISOString()
  };
}

describe("clinic operational route logging", () => {
  test("logs route metadata before failing on an invalid branch", async () => {
    const { logger, queries, settings } = createLoggerHarness();
    const orchestrator = buildOrchestrator(logger, settings, {
      next_node: "information" as never,
      intent: "ask_about_treatment_info",
      confidence: 0.91,
      needs_retrieval: false,
      state_update: {},
      reason: "remote-dspy",
      debug: {
        provider: "dspy",
        raw_next_node: "information",
        final_next_node: "information",
        validation_applied: false
      }
    });

    await expect(orchestrator.processTurn(buildInbound())).rejects.toThrow("Invalid clinic route destination");
    await logger.close();

    const entries = extractEntries(queries).filter((entry) => entry.runId !== null);
    const routeEntry = entries.find((entry) => entry.title === "03.ROUTE");
    const endEntry = entries.find((entry) => entry.title === "08.END");

    expect(routeEntry).toBeDefined();
    expect(routeEntry?.payload.debug).toEqual({
      provider: "dspy",
      raw_next_node: "information",
      final_next_node: "information",
      validation_applied: true,
      allowed_destinations: ["conversation", "rag", "appointment"]
    });

    expect(endEntry).toBeDefined();
    expect(endEntry?.payload.debug).toEqual({
      provider: "dspy",
      raw_next_node: "information",
      final_next_node: "information",
      validation_applied: true,
      allowed_destinations: ["conversation", "rag", "appointment"],
      input_summary: {
        current_mode: "conversation",
        user_message_preview: "Necesito ayuda con una cita",
        conversation_summary_present: false,
        memory_count: 0,
        has_last_tool_result: false,
        has_last_assistant_message: false
      }
    });
    expect((routeEntry?.seq ?? 0) < (endEntry?.seq ?? 0)).toBe(true);
  });

  test("persists 03.ROUTE before later success blocks", async () => {
    const { logger, queries, settings } = createLoggerHarness();
    const orchestrator = buildOrchestrator(logger, settings, {
      next_node: "conversation",
      intent: "conversation",
      confidence: 0.96,
      needs_retrieval: false,
      state_update: {},
      reason: "guard-simple-conversation",
      debug: {
        provider: "guard",
        raw_next_node: "conversation",
        final_next_node: "conversation",
        validation_applied: false
      }
    });

    await orchestrator.processTurn(buildInbound());
    await logger.close();

    const orderedTitles = extractEntries(queries)
      .filter((entry) => entry.runId !== null && entry.seq !== null)
      .sort((left, right) => Number(left.seq) - Number(right.seq))
      .map((entry) => entry.title);

    const routeIndex = orderedTitles.indexOf("03.ROUTE");
    const stateWriteIndex = orderedTitles.indexOf("07.MEMORY.WRITE.clinic_state");
    const toolIndex = orderedTitles.indexOf("04.TOOL.conversation_reply");
    const flowIndex = orderedTitles.indexOf("06.FLOW");
    const outputIndex = orderedTitles.indexOf("07.OUTPUT");

    expect(routeIndex).toBeGreaterThan(-1);
    expect(routeIndex).toBeLessThan(stateWriteIndex);
    expect(routeIndex).toBeLessThan(toolIndex);
    expect(routeIndex).toBeLessThan(flowIndex);
    expect(routeIndex).toBeLessThan(outputIndex);
  });
});
