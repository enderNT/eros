import { describe, expect, it } from "bun:test";
import { createLlmProvider, createMemoryProvider, createOutboundTransport } from "../src/core/factories/runtime";
import { NoopTransport } from "../src/adapters/channels/noop-transport";
import { ChatwootTransport } from "../src/adapters/channels/chatwoot-transport";
import { WebhookAsyncTransport } from "../src/adapters/channels/webhook-async-transport";
import { InMemoryMemoryProvider } from "../src/core/services/in-memory-memory-provider";
import { Mem0MemoryProvider } from "../src/core/services/mem0-memory-provider";
import { OpenAiCompatibleLlmProvider } from "../src/core/services/openai-compatible-llm-provider";
import { GenericLlmProvider } from "../src/core/services/generic-llm-provider";
import { buildTestSettings } from "./test-settings";

describe("runtime factories", () => {
  it("creates providers according to environment settings", () => {
    const localSettings = buildTestSettings();
    expect(createLlmProvider(localSettings)).toBeInstanceOf(GenericLlmProvider);
    expect(createMemoryProvider(localSettings)).toBeInstanceOf(InMemoryMemoryProvider);
    expect(createOutboundTransport(localSettings)).toBeInstanceOf(NoopTransport);

    const remoteSettings = buildTestSettings({
      llm: {
        provider: "openai_compatible",
        apiKey: "secret",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        timeoutMs: 1000,
        temperature: 0
      },
      memory: {
        provider: "mem0",
        enabled: true,
        agentId: "agent-1",
        topK: 5,
        scoreThreshold: 0,
        mem0: {
          baseUrl: "https://mem0.example.com",
          apiKey: "secret",
          authMode: "x-api-key",
          orgId: "",
          projectId: "",
          searchPath: "/v1/search",
          addPath: "/v1/add"
        }
      },
      channel: {
        provider: "chatwoot",
        replyEnabled: true,
        chatwoot: {
          baseUrl: "https://chatwoot.example.com",
          apiAccessToken: "secret"
        }
      }
    });

    expect(createLlmProvider(remoteSettings)).toBeInstanceOf(OpenAiCompatibleLlmProvider);
    expect(createMemoryProvider(remoteSettings)).toBeInstanceOf(Mem0MemoryProvider);
    expect(createOutboundTransport(remoteSettings)).toBeInstanceOf(ChatwootTransport);
  });

  it("creates the webhook_async outbound transport when configured", () => {
    const settings = buildTestSettings({
      channel: {
        provider: "webhook_async",
        replyEnabled: true,
        chatwoot: {
          baseUrl: "",
          apiAccessToken: ""
        },
        webhookAsync: {
          callbackSecret: "shared-secret"
        }
      }
    });

    expect(createOutboundTransport(settings)).toBeInstanceOf(WebhookAsyncTransport);
  });
});
