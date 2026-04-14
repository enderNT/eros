import { afterEach, describe, expect, it } from "bun:test";
import { GenericLlmProvider } from "../src/core/services/generic-llm-provider";
import {
  OpenAiCompatibleLlmProvider,
  resolveChatCompletionsUrl
} from "../src/core/services/openai-compatible-llm-provider";
import { buildTestSettings } from "./test-settings";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("OpenAiCompatibleLlmProvider", () => {
  it("resolves the chat completions URL from a base URL", () => {
    expect(resolveChatCompletionsUrl("https://example.com/v1")).toBe("https://example.com/v1/chat/completions");
    expect(resolveChatCompletionsUrl("https://example.com/v1/chat/completions")).toBe("https://example.com/v1/chat/completions");
  });

  it("parses JSON wrapped in fenced code blocks", async () => {
    const settings = buildTestSettings({
      llm: {
        provider: "openai_compatible",
        apiKey: "secret",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        timeoutMs: 1000,
        temperature: 0
      }
    });
    const provider = new OpenAiCompatibleLlmProvider(settings.llm, new GenericLlmProvider());

    global.fetch = ((async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '```json\n{"capability":"knowledge","intent":"lookup","confidence":0.9,"needsKnowledge":true,"statePatch":{"lastIntent":"lookup"},"reason":"consulta factual"}\n```'
              }
            }
          ]
        })
      )) as unknown) as typeof fetch;

    const result = await provider.decideRoute({
      inbound: {
        sessionId: "session-1",
        actorId: "user-1",
        channel: "test",
        text: "Busca este dato",
        rawPayload: {},
        receivedAt: new Date().toISOString()
      },
      state: {
        summary: "",
        recentTurns: [],
        continuitySignals: [],
        turnCount: 0
      },
      promptDigest: "dato recordado"
    });

    expect(result.capability).toBe("knowledge");
    expect(result.intent).toBe("lookup");
    expect(result.needsKnowledge).toBe(true);
  });

  it("falls back to the local provider when the remote backend is unavailable", async () => {
    const settings = buildTestSettings({
      llm: {
        provider: "openai_compatible",
        apiKey: "secret",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        timeoutMs: 1000,
        temperature: 0
      }
    });
    const provider = new OpenAiCompatibleLlmProvider(settings.llm, new GenericLlmProvider());

    global.fetch = ((async () => new Response("upstream error", { status: 500 })) as unknown) as typeof fetch;

    const result = await provider.generateReply("conversation", {
      inbound: {
        sessionId: "session-1",
        actorId: "user-1",
        channel: "test",
        text: "Hola",
        rawPayload: {},
        receivedAt: new Date().toISOString()
      },
      shortTermState: {
        summary: "",
        recentTurns: [],
        continuitySignals: [],
        turnCount: 0
      },
      memorySelection: {
        rawRecall: [],
        promptDigest: ""
      },
      knowledge: [],
      routeDecision: {
        capability: "conversation",
        intent: "general_conversation",
        confidence: 0.8,
        needsKnowledge: false,
        statePatch: {},
        reason: "test"
      },
      traceId: "trace-1"
    });

    expect(result.responseText).toContain("Mantengo la conversación");
  });
});
