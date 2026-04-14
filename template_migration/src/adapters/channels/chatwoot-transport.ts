import type { AppSettings } from "../../config";
import type { InboundMessage, TurnOutcome } from "../../domain/contracts";
import type { OutboundTransport } from "../../domain/ports";

export class ChatwootTransport implements OutboundTransport {
  constructor(private readonly settings: AppSettings["channel"]) {}

  async emit(outcome: TurnOutcome, inbound: InboundMessage): Promise<{
    status: string;
    destination: string;
    response: Record<string, unknown>;
  }> {
    const accountId = inbound.deliveryContext?.accountId ?? inbound.accountId ?? this.settings.accountId;
    const conversationId = inbound.deliveryContext?.conversationId ?? inbound.sessionId;

    if (!accountId || !conversationId) {
      throw new Error("Chatwoot outbound delivery requires accountId and conversationId");
    }

    if (!this.settings.chatwoot.baseUrl || !this.settings.chatwoot.apiAccessToken) {
      throw new Error("Chatwoot outbound delivery requires CHATWOOT_BASE_URL and CHATWOOT_API_ACCESS_TOKEN");
    }

    const url = `${this.settings.chatwoot.baseUrl.replace(/\/$/, "")}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        api_access_token: this.settings.chatwoot.apiAccessToken
      },
      body: JSON.stringify({
        content: outcome.responseText,
        message_type: "outgoing",
        private: false,
        content_type: "text",
        content_attributes: {}
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Chatwoot outbound delivery failed: ${response.status} ${detail}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    return {
      status: "sent",
      destination: "chatwoot",
      response: {
        id: payload.id,
        status: payload.status,
        conversation_id: payload.conversation_id,
        message_type: payload.message_type
      }
    };
  }
}
