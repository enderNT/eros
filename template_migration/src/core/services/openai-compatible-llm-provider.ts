import type {
  Capability,
  CapabilityResult,
  ExecutionContext,
  InboundMessage,
  MemoryHit,
  RouteDecision,
  ShortTermState
} from "../../domain/contracts";
import type { LlmProvider } from "../../domain/ports";
import type { AppSettings } from "../../config";
import {
  extractJsonObject,
  readBooleanValue,
  readNumberValue,
  readRecord,
  readStringArray,
  readStringValue
} from "./json-response";

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  constructor(
    private readonly settings: AppSettings["llm"],
    private readonly fallback: LlmProvider
  ) {}

  async decideRoute(input: {
    inbound: InboundMessage;
    state: ShortTermState;
    promptDigest: string;
  }): Promise<RouteDecision> {
    const prompt = [
      "Decide la capability para un asistente stateful.",
      'Responde SOLO JSON con keys: capability, intent, confidence, needsKnowledge, statePatch, reason.',
      'capability debe ser "conversation", "knowledge" o "action".',
      `input="${input.inbound.text}"`,
      `channel="${input.inbound.channel ?? "unknown"}"`,
      `promptDigest="${input.promptDigest}"`,
      `stateSummary="${input.state.summary}"`
    ].join("\n");

    const parsed = await this.requestJson(prompt);
    if (!parsed) {
      return this.fallback.decideRoute(input);
    }

    return {
      capability: normalizeCapability(parsed.capability),
      intent: readStringValue(parsed.intent, "general_conversation"),
      confidence: clamp(readNumberValue(parsed.confidence, 0.7)),
      needsKnowledge: readBooleanValue(parsed.needsKnowledge, false),
      statePatch: normalizeStatePatch(parsed.statePatch) ?? {},
      reason: readStringValue(parsed.reason, "Respuesta remota normalizada.")
    };
  }

  async generateReply(capability: Capability, context: ExecutionContext): Promise<CapabilityResult> {
    const prompt = [
      "Genera una respuesta para un asistente stateful.",
      "Responde SOLO JSON con keys: responseText, statePatch, handoffRequired, artifacts, memoryHints.",
      `capability="${capability}"`,
      `input="${context.inbound.text}"`,
      `stateSummary="${context.shortTermState.summary}"`,
      `promptDigest="${context.memorySelection.promptDigest}"`,
      `knowledge="${context.knowledge.map((item) => item.content).join(" | ")}"`
    ].join("\n");

    const parsed = await this.requestJson(prompt);
    if (!parsed) {
      return this.fallback.generateReply(capability, context);
    }

    return {
      responseText: readStringValue(parsed.responseText, this.defaultResponse(capability, context.inbound.text)),
      statePatch: normalizeStatePatch(parsed.statePatch),
      handoffRequired: readBooleanValue(parsed.handoffRequired, false),
      artifacts: readRecord(parsed.artifacts) ?? { provider: "openai_compatible", capability },
      memoryHints: readStringArray(parsed.memoryHints)
    };
  }

  async summarizeState(input: { state: ShortTermState; recentUserText: string }): Promise<string> {
    const response = await this.requestText(
      [
        "Resume brevemente el estado conversacional en una sola frase.",
        `stateSummary="${input.state.summary}"`,
        `recentUserText="${input.recentUserText}"`
      ].join("\n")
    );
    return response || this.fallback.summarizeState(input);
  }

  async summarizeMemories(input: { query: string; memories: MemoryHit[]; budgetChars: number }): Promise<string> {
    const response = await this.requestText(
      [
        "Resume memorias relevantes respetando el presupuesto de caracteres.",
        `budgetChars=${input.budgetChars}`,
        `query="${input.query}"`,
        `memories="${input.memories.map((item) => item.memory).join(" | ")}"`
      ].join("\n")
    );
    return (response || (await this.fallback.summarizeMemories(input))).slice(0, input.budgetChars);
  }

  private async requestJson(prompt: string): Promise<Record<string, unknown> | null> {
    const text = await this.requestText(prompt);
    return text ? extractJsonObject(text) : null;
  }

  private async requestText(prompt: string): Promise<string | null> {
    const url = resolveChatCompletionsUrl(this.settings.baseUrl);
    if (!url || !this.settings.apiKey) {
      return null;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.settings.apiKey}`
        },
        body: JSON.stringify({
          model: this.settings.model,
          temperature: this.settings.temperature,
          messages: [
            {
              role: "system",
              content: "Eres un backend que responde de forma estructurada y segura."
            },
            {
              role: "user",
              content: prompt
            }
          ]
        }),
        signal: AbortSignal.timeout(this.settings.timeoutMs)
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return payload.choices?.[0]?.message?.content?.trim() || null;
    } catch {
      return null;
    }
  }

  private defaultResponse(capability: Capability, text: string): string {
    return `Respuesta ${capability} generada con fallback para: ${text}`;
  }
}

function normalizeCapability(value: unknown): Capability {
  return value === "knowledge" || value === "action" ? value : "conversation";
}

function normalizeStatePatch(value: unknown): Partial<ShortTermState> | undefined {
  const patch = readRecord(value);
  if (!patch) {
    return undefined;
  }
  return patch as Partial<ShortTermState>;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function resolveChatCompletionsUrl(baseUrl?: string): string | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/$/, "").endsWith("/chat/completions")
    ? trimmed.replace(/\/$/, "")
    : `${trimmed.replace(/\/$/, "")}/chat/completions`;
}
