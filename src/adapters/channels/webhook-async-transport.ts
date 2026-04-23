import type { AppSettings } from "../../config";
import type { InboundMessage, TurnOutcome } from "../../domain/contracts";
import type { OutboundTransport } from "../../domain/ports";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "No fue posible procesar el mensaje.";
}

async function readResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { body: text };
  }

  return { body: text };
}

export class WebhookAsyncTransport implements OutboundTransport {
  constructor(
    private readonly settings: AppSettings["channel"],
    private readonly appName: string
  ) {}

  async emit(outcome: TurnOutcome, inbound: InboundMessage): Promise<{
    status: string;
    destination: string;
    response: Record<string, unknown>;
  }> {
    return this.postCallback(
      inbound,
      {
        status: "completed",
        assistantText: outcome.responseText,
        rawResponse: {
          provider: this.appName,
          capability: outcome.capability,
          intent: outcome.intent,
          confidence: outcome.confidence,
          handoffRequired: outcome.handoffRequired
        }
      }
    );
  }

  async emitFailure(error: unknown, inbound: InboundMessage): Promise<{
    status: string;
    destination: string;
    response: Record<string, unknown>;
  }> {
    return this.postCallback(
      inbound,
      {
        status: "failed",
        error: toErrorMessage(error),
        rawResponse: {
          provider: this.appName,
          code: "PROCESSING_ERROR"
        }
      }
    );
  }

  private async postCallback(
    inbound: InboundMessage,
    payload: {
      status: "completed";
      assistantText: string;
      rawResponse: Record<string, unknown>;
    } | {
      status: "failed";
      error: string;
      rawResponse: Record<string, unknown>;
    }
  ): Promise<{
    status: string;
    destination: string;
    response: Record<string, unknown>;
  }> {
    const callbackUrl = inbound.deliveryContext?.callbackUrl;
    const chatRequestId = inbound.deliveryContext?.chatRequestId;
    const userMessageId = inbound.deliveryContext?.userMessageId;
    const integrationRequestId = inbound.deliveryContext?.integrationRequestId;
    const callbackSecret = this.settings.webhookAsync.callbackSecret;

    if (!callbackUrl || !chatRequestId || !userMessageId) {
      throw new Error("webhook_async outbound delivery requires callbackUrl, chatRequestId and userMessageId");
    }

    if (!callbackSecret) {
      throw new Error("webhook_async outbound delivery requires CHAT_WEBHOOK_CALLBACK_SECRET");
    }

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${callbackSecret}`
      },
      body: JSON.stringify({
        sessionId: inbound.sessionId,
        userMessageId,
        chatRequestId,
        integrationRequestId,
        ...payload
      })
    });

    const responsePayload = await readResponsePayload(response);
    if (!response.ok) {
      throw new Error(
        `webhook_async callback failed: ${response.status} ${JSON.stringify(responsePayload)}`
      );
    }

    return {
      status: payload.status,
      destination: "webhook_async_callback",
      response: {
        http_status: response.status,
        callback_url: callbackUrl,
        callback_status: payload.status,
        ...responsePayload
      }
    };
  }
}
