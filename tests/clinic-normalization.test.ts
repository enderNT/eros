import { describe, expect, test } from "bun:test";
import { assessChatwootWebhook, normalizeChatwootInboundMessage } from "../src/adapters/http/inbound";

describe("chatwoot inbound normalization", () => {
  test("accepts incoming message_created events", () => {
    const payload = {
      event: "message_created",
      id: 77,
      content: "Hola, quiero agendar una cita",
      message_type: "incoming",
      account: { id: 9 },
      conversation: { id: 1234 },
      sender: { id: 456, name: "Ana", type: "contact" }
    };

    expect(assessChatwootWebhook(payload).shouldProcess).toBe(true);
    expect(normalizeChatwootInboundMessage(payload)).toEqual(
      expect.objectContaining({
        sessionId: "1234",
        actorId: "456",
        channel: "chatwoot",
        text: "Hola, quiero agendar una cita",
        accountId: "9",
        contactName: "Ana"
      })
    );
  });
});
