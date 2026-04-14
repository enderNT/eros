import type { InboundMessage } from "../../domain/contracts";

interface ChatwootWebhookPayload {
  event?: string;
  id?: string | number;
  content?: string;
  text?: string;
  message_type?: string | number;
  private?: boolean;
  account?: {
    id?: string | number;
  };
  conversation?: {
    id?: string | number;
    account_id?: string | number;
  };
  contact?: {
    id?: string | number;
    name?: string;
  };
  sender?: {
    id?: string | number;
    name?: string;
    type?: string;
  };
  inbox?: {
    id?: string | number;
  };
  messages?: Array<Record<string, unknown>>;
  additional_attributes?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ChatwootWebhookAssessment {
  isChatwoot: boolean;
  shouldProcess: boolean;
  reason?: string;
}

const INCOMING_TYPES = new Set(["incoming", "0", 0]);

export function assessChatwootWebhook(payload: ChatwootWebhookPayload): ChatwootWebhookAssessment {
  const isChatwoot =
    payload.event !== undefined ||
    payload.message_type !== undefined ||
    payload.account?.id !== undefined ||
    payload.conversation?.id !== undefined;

  if (!isChatwoot) {
    return { isChatwoot: false, shouldProcess: true };
  }

  if ((payload.event ?? "").toString().trim().toLowerCase() !== "message_created") {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: `ignored_event:${String(payload.event ?? "unknown")}`
    };
  }

  if (payload.private === true) {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: "ignored_private_message"
    };
  }

  if (payload.message_type !== undefined && !INCOMING_TYPES.has(payload.message_type)) {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: `ignored_message_type:${String(payload.message_type)}`
    };
  }

  if (payload.sender?.type && payload.sender.type !== "contact") {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: `ignored_sender_type:${payload.sender.type}`
    };
  }

  const text = resolveLatestMessage(payload);
  if (!text) {
    return {
      isChatwoot: true,
      shouldProcess: false,
      reason: "missing_content"
    };
  }

  return { isChatwoot: true, shouldProcess: true };
}

export function normalizeInboundMessage(payload: Record<string, unknown>): InboundMessage {
  const nestedMessage = payload.message && typeof payload.message === "object" ? payload.message as Record<string, unknown> : {};
  const conversation = payload.conversation && typeof payload.conversation === "object" ? payload.conversation as Record<string, unknown> : {};
  const sender = payload.sender && typeof payload.sender === "object" ? payload.sender as Record<string, unknown> : {};
  const text = typeof payload.text === "string"
    ? payload.text
    : typeof nestedMessage.text === "string"
      ? nestedMessage.text
      : "";
  if (!text.trim()) {
    throw new Error("Unable to normalize inbound payload: missing text");
  }

  return {
    sessionId: String(payload.sessionId ?? conversation.id ?? crypto.randomUUID()),
    actorId: String(payload.actorId ?? sender.id ?? "anonymous"),
    channel: String(payload.channel ?? "generic_http"),
    text: text.trim(),
    correlationId: payload.correlationId ? String(payload.correlationId) : undefined,
    parentRunId: payload.parentRunId ? String(payload.parentRunId) : undefined,
    trigger: payload.trigger ? String(payload.trigger) : "http_message",
    accountId: payload.accountId ? String(payload.accountId) : undefined,
    contactName: payload.contactName ? String(payload.contactName) : sender.name ? String(sender.name) : undefined,
    rawPayload: payload,
    receivedAt: new Date().toISOString()
  };
}

export function normalizeChatwootInboundMessage(payload: ChatwootWebhookPayload): InboundMessage {
  const text = resolveLatestMessage(payload);
  if (!text) {
    throw new Error("Unable to normalize Chatwoot payload: missing content");
  }

  const conversationId =
    payload.conversation?.id ??
    payload.additional_attributes?.conversation_id ??
    payload.id ??
    crypto.randomUUID();
  const accountId =
    payload.account?.id ??
    payload.conversation?.account_id ??
    payload.additional_attributes?.account_id;
  const contactId =
    payload.contact?.id ??
    payload.sender?.id ??
    payload.meta?.sender;
  const contactName =
    payload.contact?.name ??
    payload.sender?.name ??
    "Paciente";

  return {
    sessionId: String(conversationId),
    actorId: String(contactId ?? "unknown-contact"),
    channel: "chatwoot",
    text,
    correlationId: payload.id ? String(payload.id) : String(conversationId),
    trigger: payload.event ? `chatwoot:${payload.event}` : "chatwoot:message_created",
    accountId: accountId ? String(accountId) : undefined,
    contactName: String(contactName),
    deliveryContext: {
      provider: "chatwoot",
      accountId: accountId ? String(accountId) : undefined,
      conversationId: String(conversationId),
      inboxId: payload.inbox?.id ? String(payload.inbox.id) : undefined,
      contactId: contactId ? String(contactId) : undefined
    },
    rawPayload: payload,
    receivedAt: new Date().toISOString()
  };
}

function resolveLatestMessage(payload: ChatwootWebhookPayload): string {
  if (typeof payload.content === "string" && payload.content.trim()) {
    return payload.content.trim();
  }
  if (typeof payload.text === "string" && payload.text.trim()) {
    return payload.text.trim();
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of [...messages].reverse()) {
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}
