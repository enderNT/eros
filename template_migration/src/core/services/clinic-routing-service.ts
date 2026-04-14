import type { AppSettings } from "../../config";
import type { RoutingPacket, StateRoutingDecision } from "../../domain/contracts";
import type { ClinicDspyBridge } from "../../domain/ports";
import { ClinicLlmService } from "./clinic-llm-service";

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

export class ClinicRoutingService {
  constructor(
    private readonly settings: AppSettings,
    private readonly llmService: ClinicLlmService,
    private readonly dspyBridge: ClinicDspyBridge
  ) {}

  async routeState(input: {
    user_message: string;
    conversation_summary: string;
    active_goal: string;
    stage: string;
    pending_action: string;
    pending_question: string;
    appointment_slots: Record<string, unknown>;
    last_tool_result: string;
    last_user_message: string;
    last_assistant_message: string;
    memories: string[];
  }): Promise<StateRoutingDecision> {
    const routingPacket: RoutingPacket = {
      user_message: compact(input.user_message, 400),
      conversation_summary: compact(input.conversation_summary, 500),
      active_goal: compact(input.active_goal, 80),
      stage: compact(input.stage, 80),
      pending_action: compact(input.pending_action, 120),
      pending_question: compact(input.pending_question, 200),
      appointment_slots: Object.fromEntries(
        Object.entries(input.appointment_slots).map(([key, value]) => [key, compact(String(value), 120)])
      ),
      last_tool_result: compact(input.last_tool_result, 280),
      last_user_message: compact(input.last_user_message, 280),
      last_assistant_message: compact(input.last_assistant_message, 280),
      memories: input.memories.slice(0, 3).map((memory) => compact(memory, 160))
    };

    const guard = this.deterministicGuard(routingPacket);
    if (guard) {
      return guard;
    }

    if (this.settings.dspy.enabled) {
      const decision = await this.dspyBridge.predictStateRouter({ ...routingPacket, guard_hint: {} });
      if (decision) {
        return decision.next_node === "rag" && !decision.needs_retrieval
          ? { ...decision, needs_retrieval: true }
          : decision;
      }
    }

    const decision = await this.llmService.classifyStateRoute(routingPacket, {});
    return decision.next_node === "rag" && !decision.needs_retrieval
      ? { ...decision, needs_retrieval: true }
      : decision;
  }

  summarizeMemories(memories: string[]): string[] {
    return memories.slice(0, 3).map((memory) => compact(memory, 140)).filter(Boolean);
  }

  private deterministicGuard(routingPacket: RoutingPacket): StateRoutingDecision | null {
    const userMessage = routingPacket.user_message.toLowerCase().trim();
    if (!userMessage) {
      return {
        next_node: "conversation",
        intent: "conversation",
        confidence: 0.3,
        needs_retrieval: false,
        state_update: {},
        reason: "empty-message"
      };
    }

    if (this.isAppointmentInformationRequest(routingPacket, userMessage)) {
      return {
        next_node: "rag",
        intent: "rag",
        confidence: 0.94,
        needs_retrieval: true,
        state_update: {
          active_goal: "information",
          stage: "lookup",
          pending_action: "",
          pending_question: ""
        },
        reason: "appointment-to-information"
      };
    }

    if (this.isAppointmentFollowUp(routingPacket, userMessage)) {
      return {
        next_node: "appointment",
        intent: "appointment",
        confidence: 0.95,
        needs_retrieval: false,
        state_update: {
          active_goal: "appointment",
          stage: "collecting_slots",
          pending_action: "collecting_slots"
        },
        reason: "appointment-follow-up"
      };
    }

    if (this.isExplicitAppointmentRequest(userMessage)) {
      return {
        next_node: "appointment",
        intent: "appointment",
        confidence: 0.92,
        needs_retrieval: false,
        state_update: {
          active_goal: "appointment",
          stage: "collecting_slots",
          pending_action: "collecting_slots"
        },
        reason: "appointment-request"
      };
    }

    if (this.isInformationFollowUp(routingPacket, userMessage)) {
      return {
        next_node: "rag",
        intent: "rag",
        confidence: 0.89,
        needs_retrieval: true,
        state_update: {
          active_goal: "information",
          stage: "lookup"
        },
        reason: "information-follow-up"
      };
    }

    if (this.isExplicitRagRequest(userMessage)) {
      return {
        next_node: "rag",
        intent: "rag",
        confidence: 0.86,
        needs_retrieval: true,
        state_update: {
          active_goal: "information",
          stage: "lookup"
        },
        reason: "information-request"
      };
    }

    if (this.isSimpleConversation(userMessage)) {
      return {
        next_node: "conversation",
        intent: "conversation",
        confidence: 0.9,
        needs_retrieval: false,
        state_update: {
          active_goal: routingPacket.active_goal || "conversation",
          stage: routingPacket.stage || "open"
        },
        reason: "simple-conversation"
      };
    }

    return null;
  }

  private isAppointmentFollowUp(routingPacket: RoutingPacket, userMessage: string): boolean {
    const activeAppointment = routingPacket.active_goal === "appointment" || ["collecting_slots", "ready_for_handoff"].includes(routingPacket.stage);
    if (!activeAppointment) {
      return false;
    }
    if (routingPacket.pending_question) {
      return true;
    }
    if (Object.keys(routingPacket.appointment_slots).length > 0 && userMessage.length <= 40) {
      return true;
    }
    return /\b(si|sí|no|claro|mañana|manana|hoy|tarde|noche|am|pm|\d{1,2}:\d{2}|\d{1,2}\s?am|\d{1,2}\s?pm)\b/i.test(userMessage);
  }

  private isAppointmentInformationRequest(routingPacket: RoutingPacket, userMessage: string): boolean {
    const activeAppointment = routingPacket.active_goal === "appointment" || ["collecting_slots", "ready_for_handoff"].includes(routingPacket.stage);
    if (!activeAppointment || !this.isExplicitRagRequest(userMessage) || this.looksLikeSlotAnswer(userMessage)) {
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
    const hasContext =
      routingPacket.active_goal === "information" ||
      routingPacket.stage === "lookup" ||
      Boolean(routingPacket.last_tool_result.trim());
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
}
