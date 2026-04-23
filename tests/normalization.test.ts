import { describe, expect, it } from "bun:test";
import {
  assessChatwootWebhook,
  assessWebhookAsyncRequest,
  normalizeChatwootInboundMessage,
  normalizeInboundMessage,
  normalizeWebhookAsyncInboundMessage
} from "../src/adapters/http/inbound";

describe("normalizeInboundMessage", () => {
  it("maps a generic channel payload to the internal contract", () => {
    const inbound = normalizeInboundMessage({
      conversation: { id: 123 },
      sender: { id: 456, name: "Ana" },
      message: { text: "Hola" },
      channel: "demo-channel"
    });

    expect(inbound.sessionId).toBe("123");
    expect(inbound.actorId).toBe("456");
    expect(inbound.text).toBe("Hola");
    expect(inbound.contactName).toBe("Ana");
    expect(inbound.channel).toBe("demo-channel");
  });

  it("accepts an incoming Chatwoot message and maps delivery context", () => {
    const assessment = assessChatwootWebhook({
      event: "message_created",
      id: 999,
      content: "Hola desde Chatwoot",
      message_type: "incoming",
      private: false,
      conversation: { id: 123 },
      account: { id: 77 },
      inbox: { id: 5 },
      sender: { id: 456, name: "Ana", type: "contact" }
    });

    expect(assessment.isChatwoot).toBe(true);
    expect(assessment.shouldProcess).toBe(true);

    const inbound = normalizeChatwootInboundMessage({
      event: "message_created",
      id: 999,
      content: "Hola desde Chatwoot",
      message_type: "incoming",
      private: false,
      conversation: { id: 123 },
      account: { id: 77 },
      inbox: { id: 5 },
      sender: { id: 456, name: "Ana", type: "contact" }
    });

    expect(inbound.channel).toBe("chatwoot");
    expect(inbound.sessionId).toBe("123");
    expect(inbound.accountId).toBe("77");
    expect(inbound.deliveryContext?.conversationId).toBe("123");
    expect(inbound.deliveryContext?.accountId).toBe("77");
  });

  it("ignores outgoing Chatwoot messages to avoid loops", () => {
    const assessment = assessChatwootWebhook({
      event: "message_created",
      content: "Respuesta del agente",
      message_type: "outgoing",
      private: false,
      conversation: { id: 123 },
      account: { id: 77 },
      sender: { id: 2, name: "Agente", type: "user" }
    });

    expect(assessment.isChatwoot).toBe(true);
    expect(assessment.shouldProcess).toBe(false);
    expect(assessment.reason).toContain("ignored_message_type");
  });

  it("maps a webhook_async payload to the internal contract", () => {
    const assessment = assessWebhookAsyncRequest({
      sessionId: "sess_123",
      userMessageId: "msg_user_123",
      chatRequestId: "chatreq_123",
      integration: {
        id: "mi-integracion",
        transport: "webhook_async"
      },
      message: {
        id: "msg_user_123",
        role: "user",
        text: "Hola, necesito ayuda"
      },
      history: [
        { role: "user", text: "Mensaje previo" },
        { role: "assistant", text: "Respuesta previa" }
      ],
      systemPrompt: "Eres un asistente util",
      callbackUrl: "https://tu-app.com/api/chat/webhook/callback"
    });

    expect(assessment.isWebhookAsync).toBe(true);
    expect(assessment.shouldProcess).toBe(true);

    const inbound = normalizeWebhookAsyncInboundMessage(
      {
        sessionId: "sess_123",
        userMessageId: "msg_user_123",
        chatRequestId: "chatreq_123",
        integration: {
          id: "mi-integracion",
          transport: "webhook_async"
        },
        message: {
          id: "msg_user_123",
          role: "user",
          text: "Hola, necesito ayuda"
        },
        history: [
          { role: "user", text: "Mensaje previo" },
          { role: "assistant", text: "Respuesta previa" }
        ],
        systemPrompt: "Eres un asistente util",
        callbackUrl: "https://tu-app.com/api/chat/webhook/callback"
      },
      {
        integrationRequestId: "ext_abc_123"
      }
    );

    expect(inbound.channel).toBe("webhook_async");
    expect(inbound.sessionId).toBe("sess_123");
    expect(inbound.actorId).toBe("sess_123");
    expect(inbound.correlationId).toBe("chatreq_123");
    expect(inbound.deliveryContext).toEqual({
      provider: "webhook_async",
      callbackUrl: "https://tu-app.com/api/chat/webhook/callback",
      chatRequestId: "chatreq_123",
      userMessageId: "msg_user_123",
      integrationId: "mi-integracion",
      integrationTransport: "webhook_async",
      integrationRequestId: "ext_abc_123",
      systemPrompt: "Eres un asistente util",
      history: [
        { role: "user", text: "Mensaje previo" },
        { role: "assistant", text: "Respuesta previa" }
      ]
    });
  });
});
