import type {
  Capability,
  CapabilityResult,
  ExecutionContext,
  MemoryHit,
  RouteDecision,
  ShortTermState
} from "../../domain/contracts";
import type { LlmProvider } from "../../domain/ports";

function inferCapability(text: string): Capability {
  const lowerText = text.toLowerCase();
  if (/(buscar|qué es|que es|explica|información|informacion|dato|docs|documentación|documentacion|consulta)/i.test(lowerText)) {
    return "knowledge";
  }
  if (/(agenda|crea|actualiza|cancela|reserva|programa|haz|ejecuta|workflow|proceso|acción|accion)/i.test(lowerText)) {
    return "action";
  }
  return "conversation";
}

function inferIntent(text: string, capability: Capability): string {
  switch (capability) {
    case "knowledge":
      return "knowledge_lookup";
    case "action":
      return "workflow_progress";
    default:
      return text.trim().split(/\s+/).slice(0, 4).join("_").toLowerCase() || "general_conversation";
  }
}

function buildReplyPrefix(capability: Capability): string {
  switch (capability) {
    case "knowledge":
      return "Comparto una respuesta basada en el contexto recuperado";
    case "action":
      return "Te ayudo a avanzar el flujo solicitado";
    default:
      return "Mantengo la conversación con el contexto disponible";
  }
}

export class GenericLlmProvider implements LlmProvider {
  async decideRoute(input: { inbound: { text: string }; state: ShortTermState; promptDigest: string }): Promise<RouteDecision> {
    const capability = inferCapability(input.inbound.text);
    return {
      capability,
      intent: inferIntent(input.inbound.text, capability),
      confidence: capability === "conversation" ? 0.72 : 0.78,
      needsKnowledge: capability === "knowledge",
      reason: `Heurística genérica basada en texto y continuidad (turnos=${input.state.turnCount}, memoryDigest=${input.promptDigest.length}).`,
      statePatch: {
        lastCapability: capability,
        lastIntent: inferIntent(input.inbound.text, capability),
        activeGoal: capability === "action" ? "complete_user_requested_flow" : input.state.activeGoal
      }
    };
  }

  async generateReply(capability: Capability, context: ExecutionContext): Promise<CapabilityResult> {
    const knowledgeSnippet =
      capability === "knowledge" && context.knowledge.length > 0
        ? ` Fuentes recuperadas: ${context.knowledge.map((doc) => doc.content).join(" | ")}.`
        : "";

    const memorySnippet = context.memorySelection.promptDigest
      ? ` Memoria útil: ${context.memorySelection.promptDigest}.`
      : "";

    const continuitySnippet = context.shortTermState.summary
      ? ` Resumen del hilo: ${context.shortTermState.summary}.`
      : "";

    return {
      responseText: `${buildReplyPrefix(capability)}. Entendí: "${context.inbound.text}".${continuitySnippet}${memorySnippet}${knowledgeSnippet}`.trim(),
      handoffRequired: false,
      artifacts: {
        provider: "generic-llm-provider",
        capability,
        knowledgeCount: context.knowledge.length
      },
      memoryHints: [context.inbound.text],
      statePatch: {
        stage: capability === "action" ? "awaiting_next_step" : context.shortTermState.stage,
        pendingAction: capability === "action" ? "user_confirmation_or_follow_up" : undefined,
        continuitySignals: Array.from(new Set([...context.shortTermState.continuitySignals, capability]))
      }
    };
  }

  async summarizeState(input: { state: ShortTermState; recentUserText: string }): Promise<string> {
    const previous = input.state.summary ? `${input.state.summary} ` : "";
    return `${previous}Último mensaje del usuario: ${input.recentUserText}`.slice(0, 500);
  }

  async summarizeMemories(input: { query: string; memories: MemoryHit[]; budgetChars: number }): Promise<string> {
    const joined = input.memories.map((memory) => memory.memory).join(" | ");
    const summary = `Consulta: ${input.query}. Recuerdos relevantes: ${joined}`;
    return summary.slice(0, input.budgetChars);
  }
}
