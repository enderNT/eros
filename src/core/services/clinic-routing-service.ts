import type { AppSettings } from "../../config";
import type { ClinicGraphNode, RoutingPacket, StateRoutingDecision, StateRoutingDecisionDebug } from "../../domain/contracts";
import type { ClinicDspyBridge, TraceSink } from "../../domain/ports";
import { ClinicLlmService } from "./clinic-llm-service";

const ALLOWED_ROUTE_DESTINATIONS: ClinicGraphNode[] = ["conversation", "rag", "appointment"];

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function buildRoutingDebug(
  provider: StateRoutingDecisionDebug["provider"],
  rawNextNode: string,
  finalNextNode: string,
  validationApplied = false
): StateRoutingDecisionDebug {
  return {
    provider,
    raw_next_node: rawNextNode,
    final_next_node: finalNextNode,
    validation_applied: validationApplied
  };
}

function normalizeRouteDestination(value: string): ClinicGraphNode {
  return ALLOWED_ROUTE_DESTINATIONS.includes(value as ClinicGraphNode)
    ? (value as ClinicGraphNode)
    : "conversation";
}

export class ClinicRoutingService {
  constructor(
    private readonly settings: AppSettings,
    private readonly llmService: ClinicLlmService,
    private readonly dspyBridge: ClinicDspyBridge,
    private readonly traceSink?: TraceSink
  ) {}

  async routeState(input: {
    user_message: string;
    conversation_summary: string;
    current_mode: string;
    last_tool_result: string;
    last_assistant_message: string;
    memories: string[];
  }, traceId?: string): Promise<StateRoutingDecision> {
    const rawInput = {
      user_message: input.user_message,
      conversation_summary: input.conversation_summary,
      current_mode: input.current_mode,
      last_tool_result: input.last_tool_result,
      last_assistant_message: input.last_assistant_message,
      memories: input.memories,
      guard_hint: {}
    };

    const routingPacket: RoutingPacket = {
      user_message: compact(input.user_message, 400),
      conversation_summary: input.conversation_summary,
      current_mode: compact(this.normalizeMode(input.current_mode), 40),
      last_tool_result: compact(input.last_tool_result, 280),
      last_assistant_message: compact(input.last_assistant_message, 280),
      memories: input.memories.slice(0, 3).map((memory) => compact(memory, 160))
    };
    const signaturePayload = {
      ...routingPacket,
      guard_hint: {}
    };

    if (traceId) {
      await this.traceSink?.append(traceId, "clinic.route.raw_input", rawInput);
      await this.traceSink?.append(traceId, "clinic.route.input", signaturePayload);
    }

    const guard = this.deterministicGuard(routingPacket);
    if (guard) {
      const guardedDecision = {
        ...guard,
        debug: buildRoutingDebug("guard", guard.next_node, guard.next_node)
      };
      if (traceId) {
        await this.traceSink?.append(traceId, "clinic.route.output", guardedDecision);
        await this.traceSink?.append(traceId, "clinic.route.meta", {
          provider: "guard"
        });
      }
      return guardedDecision;
    }

    if (this.settings.dspy.enabled) {
      const decision = await this.dspyBridge.predictStateRouter(signaturePayload);
      if (decision) {
        const rawNextNode = String(decision.next_node ?? "");
        const finalNextNode = normalizeRouteDestination(rawNextNode);
        const normalizedDecision = {
          ...decision,
          next_node: finalNextNode
        };
        const normalized = normalizedDecision.next_node === "rag" && !normalizedDecision.needs_retrieval
          ? { ...normalizedDecision, needs_retrieval: true }
          : normalizedDecision;
        const tracedDecision = {
          ...normalized,
          debug: buildRoutingDebug("dspy", rawNextNode, String(normalized.next_node ?? ""), rawNextNode !== finalNextNode)
        };
        if (traceId) {
          await this.traceSink?.append(traceId, "clinic.route.output", tracedDecision);
          await this.traceSink?.append(traceId, "clinic.route.meta", {
            provider: "dspy"
          });
        }
        return tracedDecision;
      }
    }

    const decision = await this.llmService.classifyStateRoute(routingPacket, {});
    const normalized = decision.next_node === "rag" && !decision.needs_retrieval
      ? { ...decision, needs_retrieval: true }
      : decision;
    const tracedDecision = {
      ...normalized,
      debug: {
        ...normalized.debug,
        provider: "llm",
        raw_next_node: normalized.debug?.raw_next_node ?? normalized.next_node,
        final_next_node: normalized.debug?.final_next_node ?? normalized.next_node,
        validation_applied: normalized.debug?.validation_applied ?? false
      } satisfies StateRoutingDecisionDebug
    };
    if (traceId) {
      await this.traceSink?.append(traceId, "clinic.route.output", tracedDecision);
      await this.traceSink?.append(traceId, "clinic.route.meta", {
        provider: "llm"
      });
    }
    return tracedDecision;
  }

  summarizeMemories(memories: string[]): string[] {
    return memories.slice(0, 3).map((memory) => compact(memory, 140)).filter(Boolean);
  }

  private deterministicGuard(routingPacket: RoutingPacket): StateRoutingDecision | null {
    const userMessage = routingPacket.user_message.toLowerCase().trim();
    if (!userMessage) {
      return this.buildGuardDecision("conversation", 0.3, false, "empty-message");
    }

    if (this.isAppointmentInformationRequest(routingPacket, userMessage)) {
      return this.buildGuardDecision("rag", 0.94, true, "appointment-to-information");
    }

    if (this.isAppointmentFollowUp(routingPacket, userMessage)) {
      return this.buildGuardDecision("appointment", 0.95, false, "appointment-follow-up");
    }

    if (this.isExplicitAppointmentRequest(userMessage)) {
      return this.buildGuardDecision("appointment", 0.92, false, "appointment-request");
    }

    if (this.isInformationFollowUp(routingPacket, userMessage)) {
      return this.buildGuardDecision("rag", 0.89, true, "information-follow-up");
    }

    if (this.isExplicitRagRequest(userMessage)) {
      return this.buildGuardDecision("rag", 0.86, true, "information-request");
    }

    if (this.isSimpleConversation(userMessage)) {
      return this.buildGuardDecision("conversation", 0.9, false, "simple-conversation");
    }

    return null;
  }

  private isAppointmentFollowUp(routingPacket: RoutingPacket, userMessage: string): boolean {
    if (routingPacket.current_mode !== "appointment") {
      return false;
    }
    if (this.lastAssistantAskedQuestion(routingPacket.last_assistant_message)) {
      return true;
    }
    if (userMessage.length <= 40 && this.looksLikeSlotAnswer(userMessage)) {
      return true;
    }
    return /\b(si|sí|no|claro|mañana|manana|hoy|tarde|noche|am|pm|\d{1,2}:\d{2}|\d{1,2}\s?am|\d{1,2}\s?pm)\b/i.test(userMessage);
  }

  private isAppointmentInformationRequest(routingPacket: RoutingPacket, userMessage: string): boolean {
    if (routingPacket.current_mode !== "appointment" || !this.isExplicitRagRequest(userMessage) || this.looksLikeSlotAnswer(userMessage)) {
      return false;
    }
    return true;
  }

  private isExplicitAppointmentRequest(userMessage: string): boolean {
    return ["cita", "agendar", "agendo", "reservar", "turno", "agenda", "calendly", "programar"].some((keyword) =>
      userMessage.includes(keyword)
    );
  }

  private isExplicitRagRequest(userMessage: string): boolean {
    return [
      "horario",
      "horarios",
      "precio",
      "costo",
      "costos",
      "terapia",
      "psicoterapia",
      "psiquiatrica",
      "psiquiatrico",
      "valoracion",
      "evaluacion",
      "seguimiento",
      "estimulacion",
      "transcraneal",
      "servicio",
      "servicios",
      "doctor",
      "doctores",
      "especialidad",
      "especialidades",
      "direccion",
      "ubicacion",
      "politica",
      "pago",
      "pagos"
    ].some((keyword) => userMessage.includes(keyword));
  }

  private isInformationFollowUp(routingPacket: RoutingPacket, userMessage: string): boolean {
    const hasContext = routingPacket.current_mode === "information" || Boolean(routingPacket.last_tool_result.trim());
    if (!hasContext || this.isExplicitAppointmentRequest(userMessage)) {
      return false;
    }

    const compactMessage = userMessage.replace(/\s+/g, " ").trim();
    const markers = ["cual", "cuál", "como", "cómo", "cuanto", "cuánto", "cuando", "cuándo", "esa", "ese", "eso", "esta", "este", "terapia", "estimulacion", "transcraneal", "valoracion", "evaluacion", "seguimiento", "psicoterapia", "psiquiatr", "horario", "precio", "costo"];
    if (compactMessage.length <= 80 && markers.some((marker) => compactMessage.includes(marker))) {
      return true;
    }
    return compactMessage.endsWith("?") && compactMessage.length <= 120;
  }

  private looksLikeSlotAnswer(userMessage: string): boolean {
    return /\b(hoy|mañana|manana|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/i.test(userMessage) ||
      /\b(\d{1,2}:\d{2}\s?(?:am|pm)?|\d{1,2}\s?(?:am|pm))\b/i.test(userMessage) ||
      ["si", "sí", "no", "ok", "okay", "va"].includes(userMessage)
      ? true
      : false;
  }

  private isSimpleConversation(userMessage: string): boolean {
    const compactMessage = userMessage.replace(/\s+/g, " ").trim();
    if (["hola", "buenas", "buenos dias", "buenas tardes", "gracias", "ok", "okay", "si", "sí"].includes(compactMessage)) {
      return true;
    }
    if (compactMessage.length <= 6) {
      return true;
    }
    return ["hola", "gracias", "perfecto", "entendido"].some((marker) => compactMessage.includes(marker));
  }

  private normalizeMode(mode: string): string {
    if (["appointment", "information", "conversation"].includes(mode)) {
      return mode;
    }
    return "conversation";
  }

  private lastAssistantAskedQuestion(lastAssistantMessage: string): boolean {
    const normalized = lastAssistantMessage.trim();
    if (!normalized) {
      return false;
    }
    return normalized.includes("?") || /\b(necesito|comparte|indica|dime|confirmame|confírmame)\b/i.test(normalized);
  }

  private buildGuardDecision(
    nextNode: StateRoutingDecision["next_node"],
    confidence: number,
    needsRetrieval: boolean,
    reason: string
  ): StateRoutingDecision {
    return {
      next_node: nextNode,
      intent: nextNode === "rag" ? "rag" : nextNode,
      confidence,
      needs_retrieval: needsRetrieval,
      state_update: {},
      reason
    };
  }
}
