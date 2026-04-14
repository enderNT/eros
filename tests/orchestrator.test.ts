import { describe, expect, it } from "bun:test";
import { TurnOrchestrator } from "../src/core/orchestrator";
import { GenericLlmProvider } from "../src/core/services/generic-llm-provider";
import { HttpDspyBridge } from "../src/core/services/http-dspy-bridge";
import { InMemoryMemoryProvider } from "../src/core/services/in-memory-memory-provider";
import { InMemoryStateStore } from "../src/core/services/in-memory-state-store";
import { InMemoryTraceSink } from "../src/core/services/in-memory-trace-sink";
import { LangGraphCapabilityGraph } from "../src/core/services/langgraph-capability-graph";
import { NoopKnowledgeProvider } from "../src/core/services/noop-knowledge-provider";
import { OperationalLogger } from "../src/core/services/operational-logger";
import { buildTestSettings } from "./test-settings";

const settings = buildTestSettings();

describe("TurnOrchestrator", () => {
  it("processes a generic conversation turn and persists continuity", async () => {
    const knowledgeProvider = new NoopKnowledgeProvider();
    const llmProvider = new GenericLlmProvider();
    const dspyBridge = new HttpDspyBridge(settings.dspy);
    const orchestrator = new TurnOrchestrator({
      settings,
      stateStore: new InMemoryStateStore(),
      memoryProvider: new InMemoryMemoryProvider(),
      knowledgeProvider,
      llmProvider,
      dspyBridge,
      traceSink: new InMemoryTraceSink(),
      outboundTransport: { emit: async () => undefined },
      logger: new OperationalLogger(settings),
      langGraph: new LangGraphCapabilityGraph({
        settings,
        knowledgeProvider,
        llmProvider,
        dspyBridge
      })
    });

    const firstOutcome = await orchestrator.processTurn({
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "Hola, me llamo Gabriel y quiero probar el bot base.",
      rawPayload: {},
      receivedAt: new Date().toISOString()
    });

    const secondOutcome = await orchestrator.processTurn({
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "Recuerdas cómo me llamo?",
      rawPayload: {},
      receivedAt: new Date().toISOString()
    });

    expect(firstOutcome.capability).toBe("conversation");
    expect(secondOutcome.stateSnapshot.recentTurns.length).toBeGreaterThan(1);
    expect(secondOutcome.responseText).toContain("Memoria útil");
  });
});
