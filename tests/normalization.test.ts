import { describe, expect, it } from "bun:test";
import {
  assessChatwootWebhook,
  normalizeChatwootInboundMessage,
  normalizeInboundMessage
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
});
