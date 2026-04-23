import { afterEach, describe, expect, it } from "bun:test";
import { WebhookAsyncTransport } from "../src/adapters/channels/webhook-async-transport";
import { buildTestSettings } from "./test-settings";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("WebhookAsyncTransport", () => {
  it("posts a completed callback with the contract fields", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({
        ok: true,
        status: "completed",
        responseMessageId: "msg_assistant_456",
        projectId: "proj_123"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

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
    const transport = new WebhookAsyncTransport(settings.channel, settings.app.name);

    const response = await transport.emit(
      {
        capability: "conversation",
        intent: "conversation",
        confidence: 0.91,
        responseText: "Aqui esta la respuesta final",
        handoffRequired: false,
        stateSnapshot: {
          summary: "",
          recentTurns: [],
          continuitySignals: [],
          turnCount: 1
        },
        artifacts: {}
      },
      {
        sessionId: "sess_123",
        actorId: "sess_123",
        channel: "webhook_async",
        text: "Hola",
        correlationId: "chatreq_123",
        trigger: "webhook_async:message_received",
        deliveryContext: {
          provider: "webhook_async",
          callbackUrl: "https://tu-app.com/api/chat/webhook/callback",
          chatRequestId: "chatreq_123",
          userMessageId: "msg_user_123",
          integrationRequestId: "ext_abc_123"
        },
        rawPayload: {},
        receivedAt: new Date().toISOString()
      }
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("https://tu-app.com/api/chat/webhook/callback");
    expect(requests[0]?.init?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer shared-secret"
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      sessionId: "sess_123",
      userMessageId: "msg_user_123",
      chatRequestId: "chatreq_123",
      integrationRequestId: "ext_abc_123",
      status: "completed",
      assistantText: "Aqui esta la respuesta final",
      rawResponse: {
        provider: "test-app",
        capability: "conversation",
        intent: "conversation",
        confidence: 0.91,
        handoffRequired: false
      }
    });
    expect(response.status).toBe("completed");
    expect(response.destination).toBe("webhook_async_callback");
    expect(response.response.responseMessageId).toBe("msg_assistant_456");
  });

  it("posts a failed callback when processing fails", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({ ok: true, status: "failed" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

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
    const transport = new WebhookAsyncTransport(settings.channel, settings.app.name);

    const response = await transport.emitFailure(
      new Error("Timeout en el sistema interno"),
      {
        sessionId: "sess_123",
        actorId: "sess_123",
        channel: "webhook_async",
        text: "Hola",
        correlationId: "chatreq_123",
        trigger: "webhook_async:message_received",
        deliveryContext: {
          provider: "webhook_async",
          callbackUrl: "https://tu-app.com/api/chat/webhook/callback",
          chatRequestId: "chatreq_123",
          userMessageId: "msg_user_123",
          integrationRequestId: "ext_abc_123"
        },
        rawPayload: {},
        receivedAt: new Date().toISOString()
      }
    );

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      sessionId: "sess_123",
      userMessageId: "msg_user_123",
      chatRequestId: "chatreq_123",
      integrationRequestId: "ext_abc_123",
      status: "failed",
      error: "Timeout en el sistema interno",
      rawResponse: {
        provider: "test-app",
        code: "PROCESSING_ERROR"
      }
    });
    expect(response.status).toBe("failed");
  });
});
