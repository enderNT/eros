import { describe, expect, it } from "bun:test";
import type { AppSettings } from "../src/config";
import type { ExecutionContext, RouteDecision, ShortTermState } from "../src/domain/contracts";
import { GenericLlmProvider } from "../src/core/services/generic-llm-provider";
import { HttpDspyBridge } from "../src/core/services/http-dspy-bridge";
import { LangGraphCapabilityGraph } from "../src/core/services/langgraph-capability-graph";
import { NoopKnowledgeProvider } from "../src/core/services/noop-knowledge-provider";
import { buildTestSettings } from "./test-settings";

const settings: AppSettings = buildTestSettings();

const shortTermState: ShortTermState = {
  summary: "",
  recentTurns: [],
  continuitySignals: [],
  turnCount: 0
};

function buildContext(routeDecision: RouteDecision): ExecutionContext {
  return {
    inbound: {
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "hola",
      rawPayload: {},
      receivedAt: new Date().toISOString()
    },
    shortTermState,
    memorySelection: {
      rawRecall: [],
      promptDigest: "usuario saluda"
    },
    knowledge: [],
    routeDecision,
    traceId: "trace-1"
  };
}

describe("LangGraphCapabilityGraph", () => {
  it("routes conversation capability through the conversation node", async () => {
    const graph = new LangGraphCapabilityGraph({
      settings,
      llmProvider: new GenericLlmProvider(),
      dspyBridge: new HttpDspyBridge(settings.dspy),
      knowledgeProvider: new NoopKnowledgeProvider()
    });

    const result = await graph.invoke(
      buildContext({
        capability: "conversation",
        intent: "general_conversation",
        confidence: 0.8,
        needsKnowledge: false,
        reason: "test",
        statePatch: {}
      })
    );

    expect(result.route).toBe("conversation");
    expect(result.result.responseText).toContain("Mantengo la conversación");
  });

  it("routes knowledge capability through the rag node", async () => {
    const graph = new LangGraphCapabilityGraph({
      settings,
      llmProvider: new GenericLlmProvider(),
      dspyBridge: new HttpDspyBridge(settings.dspy),
      knowledgeProvider: new NoopKnowledgeProvider()
    });

    const result = await graph.invoke(
      buildContext({
        capability: "knowledge",
        intent: "knowledge_lookup",
        confidence: 0.8,
        needsKnowledge: true,
        reason: "test",
        statePatch: {}
      })
    );

    expect(result.route).toBe("rag");
    expect(result.result.responseText).toContain("Comparto una respuesta basada en el contexto recuperado");
  });
});
