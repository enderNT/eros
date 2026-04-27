import type { AppSettings } from "../../config";
import type {
  AppointmentIntentPayload,
  ClinicMemoryPersistenceDecision,
  GeneratedReply,
  ReplyContextState,
  RoutingPacket,
  ShortTermState,
  StateRoutingDecisionDebug,
  StateRoutingDecision,
  TurnMemoryInput
} from "../../domain/contracts";
import {
  extractJsonObject,
  readBooleanValue,
  readNumberValue,
  readStringArray,
  readStringValue
} from "./json-response";

function isFirstTurn(context?: ReplyContextState): boolean {
  if (!context) {
    return true;
  }
  return context.turn_count <= 1 && !context.summary && context.recent_turns.length === 0 && !context.last_assistant_message;
}

function normalizeReplyOutput(responseText: string, context?: ReplyContextState): string {
  let compactText = responseText.replace(/\s+/g, " ").trim();
  if (!compactText || isFirstTurn(context)) {
    return compactText;
  }

  const patterns = [
    /^(hola|buenas|buenos dias|buenas tardes|buenas noches)[,!.:\s-]*/i,
    /^soy eros bot(?:,?\s*asistente(?: virtual)? de clinica eros neuronal)?[,!.:\s-]*/i
  ];

  let changed = true;
  while (changed && compactText) {
    changed = false;
    for (const pattern of patterns) {
      const updated = compactText.replace(pattern, "").trimStart();
      if (updated !== compactText) {
        compactText = updated;
        changed = true;
      }
    }
  }

  return compactText || responseText.trim();
}

function formatReplyContext(context?: ReplyContextState, options?: { include_tool_result?: boolean; include_slots?: boolean }): string {
  if (!context) {
    return "Contexto del hilo: n/a";
  }

  const lines = [
    `Turno: ${context.turn_count}`,
    `Resumen: ${context.summary || "n/a"}`,
    `Objetivo activo: ${context.active_goal || "n/a"}`,
    `Etapa: ${context.stage || "n/a"}`,
    `Accion pendiente: ${context.pending_action || "n/a"}`,
    `Pregunta pendiente: ${context.pending_question || "n/a"}`,
    `Ultimo mensaje del asistente: ${context.last_assistant_message || "n/a"}`
  ];

  if (options?.include_tool_result) {
    lines.push(`Ultimo resultado de herramienta: ${context.last_tool_result || "n/a"}`);
  }

  if (options?.include_slots) {
    lines.push(`Slots de cita: ${JSON.stringify(context.appointment_slots ?? {})}`);
  }

  if (context.recent_turns.length > 0) {
    lines.push(`Turnos recientes: ${JSON.stringify(context.recent_turns)}`);
  }

  return lines.join("\n");
}

function buildRoutingDebug(
  provider: StateRoutingDecisionDebug["provider"],
  rawNextNode: string,
  finalNextNode: string,
  validationApplied: boolean
): StateRoutingDecisionDebug {
  return {
    provider,
    raw_next_node: rawNextNode,
    final_next_node: finalNextNode,
    validation_applied: validationApplied
  };
}

function fallbackStateRoute(routingPacket: RoutingPacket, guardHint?: Record<string, unknown>): StateRoutingDecision {
  const userMessage = routingPacket.user_message.toLowerCase();
  if (guardHint?.force_node === "appointment") {
    return {
      next_node: "appointment",
      intent: "appointment",
      confidence: 0.88,
      needs_retrieval: false,
      state_update: {},
      reason: "fallback-force-appointment",
      debug: buildRoutingDebug("llm", "appointment", "appointment", false)
    };
  }

  if (/(cita|agendar|agenda|calendly|reservar|turno)/i.test(userMessage)) {
    return {
      next_node: "appointment",
      intent: "appointment",
      confidence: 0.8,
      needs_retrieval: false,
      state_update: {},
      reason: "fallback-appointment-keyword",
      debug: buildRoutingDebug("llm", "appointment", "appointment", false)
    };
  }

  if (/(horario|precio|costo|servicio|doctor|psiquiatr|terapia|valoracion|estimulacion)/i.test(userMessage)) {
    return {
      next_node: "rag",
      intent: "rag",
      confidence: 0.76,
      needs_retrieval: true,
      state_update: {},
      reason: "fallback-rag-keyword",
      debug: buildRoutingDebug("llm", "rag", "rag", false)
    };
  }

  return {
    next_node: "conversation",
    intent: "conversation",
    confidence: 0.7,
    needs_retrieval: false,
    state_update: {},
    reason: "fallback-conversation",
    debug: buildRoutingDebug("llm", "conversation", "conversation", false)
  };
}

export class ClinicLlmService {
  constructor(private readonly settings: AppSettings) {}

  async classifyStateRoute(routingPacket: RoutingPacket, guardHint: Record<string, unknown> = {}): Promise<StateRoutingDecision> {
    const payload = await this.requestJson(
      "Eres un clasificador de ruta para un asistente de clinica. Devuelve JSON estricto con next_node, intent, confidence, needs_retrieval y reason. Solo enruta; no intentes mantener ni editar el estado conversacional. Los valores permitidos para next_node son conversation, rag y appointment.",
      JSON.stringify({ routing_packet: routingPacket, guard_hint: guardHint }, null, 2),
      0
    );

    if (!payload) {
      return fallbackStateRoute(routingPacket, guardHint);
    }

    const rawNextNode = readStringValue(payload.next_node, "conversation");
    const finalNextNode = ["conversation", "rag", "appointment"].includes(rawNextNode)
      ? (rawNextNode as StateRoutingDecision["next_node"])
      : "conversation";

    return {
      next_node: finalNextNode,
      intent: readStringValue(payload.intent, "conversation"),
      confidence: Math.max(0, Math.min(1, readNumberValue(payload.confidence, 0.7))),
      needs_retrieval: readBooleanValue(payload.needs_retrieval, false),
      state_update: {},
      reason: readStringValue(payload.reason, "remote-json"),
      debug: buildRoutingDebug("llm", rawNextNode, finalNextNode, rawNextNode !== finalNextNode)
    };
  }

  async generateConversationReply(payload: Record<string, unknown>, context?: ReplyContextState): Promise<GeneratedReply> {
    const text = await this.requestText(
      [
        "Eres Eros Bot, el asistente virtual de Clinica Eros Neuronal, una clinica de salud mental.",
        "Responde en espanol con tono humano, breve, claro y sereno.",
        "Solo puedes saludar o presentarte en el primer mensaje del hilo o si el usuario pregunta explicitamente quien eres.",
        "No inventes servicios, horarios, diagnosticos ni precios."
      ].join(" "),
      [
        formatReplyContext(context),
        `Memorias relevantes: ${JSON.stringify(payload.memories ?? [])}`,
        `Mensaje actual del usuario: ${String(payload.user_message ?? "")}`,
        "Responde en espanol de forma breve, amable y profesional."
      ].join("\n")
    );

    if (!text) {
      return {
        response_text: normalizeReplyOutput(this.buildConversationFallback(context), context),
        reply_mode: "fallback"
      };
    }

    return {
      response_text: normalizeReplyOutput(text, context),
      reply_mode: "llm"
    };
  }

  async generateRagReply(payload: Record<string, unknown>, context?: ReplyContextState): Promise<GeneratedReply> {
    const text = await this.requestText(
      [
        "Eres Eros Bot, asistente de Clinica Eros Neuronal, una clinica de salud mental.",
        "Estas respondiendo en modo RAG.",
        "Usa solo el contexto recuperado y la memoria compartida.",
        "Si el contexto no alcanza, dilo con claridad y ofrece canalizar con recepcion."
      ].join(" "),
      [
        formatReplyContext(context, { include_tool_result: true }),
        `Contexto recuperado por RAG:\n${String(payload.retrieved_context ?? "")}`,
        `Memoria conversacional: ${JSON.stringify(payload.memories ?? [])}`,
        `Mensaje actual del usuario: ${String(payload.user_message ?? "")}`
      ].join("\n")
    );

    if (!text) {
      return {
        response_text: normalizeReplyOutput(
          "Soy Eros Bot y solo puedo responder con la informacion recuperada de Clinica Eros Neuronal. Si necesitas un dato que no aparece en el contexto actual, lo canalizo con recepcion.",
          context
        ),
        reply_mode: "fallback"
      };
    }

    return {
      response_text: normalizeReplyOutput(text, context),
      reply_mode: "llm"
    };
  }

  async extractAppointmentPayload(input: {
    user_message: string;
    memories: string[];
    clinic_context: string;
    contact_name: string;
    current_slots?: Record<string, unknown>;
    pending_question?: string;
    context?: ReplyContextState;
  }): Promise<AppointmentIntentPayload> {
    const payload = await this.requestJson(
      [
        "Eres el analizador de citas de Clinica Eros Neuronal, clinica de salud mental.",
        "Devuelve JSON estricto con llaves: patient_name, reason, preferred_date, preferred_time, missing_fields, should_handoff, confidence.",
        "Usa current_slots para conservar datos previos y solo marca en missing_fields los campos realmente ausentes."
      ].join(" "),
      [
        `Nombre de contacto: ${input.contact_name}`,
        formatReplyContext(input.context, { include_slots: true }),
        `Memorias relevantes: ${JSON.stringify(input.memories)}`,
        `Slots actuales: ${JSON.stringify(input.current_slots ?? {})}`,
        `Pendiente: ${input.pending_question ?? "n/a"}`,
        `Mensaje: ${input.user_message}`
      ]
        .concat(input.clinic_context.trim() ? [`Contexto clinico:\n${input.clinic_context}`] : [])
        .join("\n")
    );

    if (!payload) {
      return this.fallbackAppointment(input.user_message, input.contact_name, input.current_slots ?? {});
    }

    return {
      patient_name: readStringValue(payload.patient_name, "") || null,
      reason: readStringValue(payload.reason, "") || null,
      preferred_date: readStringValue(payload.preferred_date, "") || null,
      preferred_time: readStringValue(payload.preferred_time, "") || null,
      missing_fields: readStringArray(payload.missing_fields),
      should_handoff: readBooleanValue(payload.should_handoff, true),
      confidence: Math.max(0, Math.min(1, readNumberValue(payload.confidence, 0.7)))
    };
  }

  async generateAppointmentReply(
    payload: Record<string, unknown>,
    appointment: AppointmentIntentPayload,
    context?: ReplyContextState
  ): Promise<GeneratedReply> {
    const text = await this.requestText(
      [
        "Eres Eros Bot, asistente de Clinica Eros Neuronal, clinica de salud mental.",
        "Redacta respuestas para ayudar a agendar citas.",
        "Si faltan datos, pide solo los faltantes de forma breve y luego comparte el enlace.",
        `Incluye siempre este enlace exacto para agendar: ${this.settings.clinic.bookingUrl}`
      ].join(" "),
      [
        `Nombre del contacto: ${String(payload.contact_name ?? "")}`,
        formatReplyContext(context, { include_slots: true }),
        `Memorias relevantes: ${JSON.stringify(payload.memories ?? [])}`,
        `Mensaje del usuario: ${String(payload.user_message ?? "")}`,
        `Payload de cita: ${JSON.stringify(appointment)}`
      ].join("\n")
    );

    if (!text) {
      return {
        response_text: normalizeReplyOutput(this.buildAppointmentFallback(appointment), context),
        reply_mode: "fallback"
      };
    }

    const responseText = text.includes(this.settings.clinic.bookingUrl)
      ? text
      : `${text.trim()} Agenda aqui: ${this.settings.clinic.bookingUrl}`;

    return {
      response_text: normalizeReplyOutput(responseText, context),
      reply_mode: "llm"
    };
  }

  async buildStateSummary(input: {
    current_summary: string;
    user_message: string;
    assistant_message: string;
    active_goal: string;
    stage: string;
  }): Promise<string> {
    const text = await this.requestText(
      "Actualiza un resumen corto de estado conversacional. Mantenlo en una o dos frases. Devuelve solo el resumen.",
      [
        `Resumen actual: ${input.current_summary || "n/a"}`,
        `Objetivo activo: ${input.active_goal || "n/a"}`,
        `Etapa: ${input.stage || "n/a"}`,
        `Ultimo mensaje del usuario: ${input.user_message}`,
        `Ultima respuesta del asistente: ${input.assistant_message}`
      ].join("\n"),
      0.2
    );

    if (!text) {
      return [input.current_summary, `Usuario: ${input.user_message}`, `Asistente: ${input.assistant_message}`]
        .filter(Boolean)
        .join(" ");
    }

    return text.trim();
  }

  async decideMemoryPersistence(input: {
    turn: TurnMemoryInput;
    short_term: ShortTermState;
    handoff_required: boolean;
    heuristic_decision: ClinicMemoryPersistenceDecision;
  }): Promise<ClinicMemoryPersistenceDecision | null> {
    const payload = await this.requestJson(
      [
        "Evalua si un turno conversacional debe guardarse como memoria de largo plazo para Clinica Eros Neuronal.",
        "Debes ser conservador: solo guarda informacion estable, reutilizable en futuros turnos o sesiones, o eventos operativos importantes.",
        "No guardes saludos, agradecimientos, small talk, preguntas informativas aisladas, reformulaciones, ni datos que solo sirven para este turno.",
        "Devuelve JSON estricto con llaves: should_store, should_store_profile, should_store_episode, reasons.",
        "should_store_profile aplica para preferencias, identidad, contexto clinico o datos persistentes del usuario.",
        "should_store_episode aplica solo si el turno deja un evento operativo que debe sobrevivir, como handoff o seguimiento pendiente."
      ].join(" "),
      JSON.stringify({
        turn: input.turn,
        handoff_required: input.handoff_required,
        short_term: {
          summary: input.short_term.summary,
          active_goal: input.short_term.activeGoal ?? "",
          stage: input.short_term.stage ?? "",
          pending_action: input.short_term.pendingAction ?? "",
          pending_question: input.short_term.pendingQuestion ?? "",
          appointment_slots: input.short_term.appointmentSlots ?? {},
          recent_turns: input.short_term.recentTurns.slice(-5).map((turn) => ({
            role: turn.role,
            text: turn.text
          }))
        },
        heuristic_decision: input.heuristic_decision
      }, null, 2),
      0
    );

    if (!payload) {
      return null;
    }

    const shouldStore = readBooleanValue(payload.should_store, false);
    const shouldStoreProfile = shouldStore && readBooleanValue(payload.should_store_profile, false);
    const shouldStoreEpisode = shouldStore && input.handoff_required && readBooleanValue(payload.should_store_episode, false);

    return {
      shouldStore: shouldStoreProfile || shouldStoreEpisode,
      shouldStoreProfile,
      shouldStoreEpisode,
      reasons: readStringArray(payload.reasons).slice(0, 5)
    };
  }

  private fallbackAppointment(
    userMessage: string,
    contactName: string,
    currentSlots: Record<string, unknown>
  ): AppointmentIntentPayload {
    const lowered = userMessage.toLowerCase();
    const reason =
      String(currentSlots.reason ?? "") ||
      ["psicoterapia", "psiquiatria", "terapia", "ansiedad", "depresion", "seguimiento", "evaluacion"].find((item) =>
        lowered.includes(item)
      ) ||
      null;
    const date = String(currentSlots.preferred_date ?? "") || lowered.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4}|manana|mañana|hoy|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado)\b/)?.[1] || null;
    const time = String(currentSlots.preferred_time ?? "") || lowered.match(/\b(\d{1,2}:\d{2}\s?(?:am|pm)?|\d{1,2}\s?(?:am|pm))\b/)?.[1] || null;
    const patientName = String(currentSlots.patient_name ?? "") || (contactName && contactName !== "Paciente" ? contactName : null);
    const missing_fields = [
      !patientName ? "patient_name" : "",
      !reason ? "reason" : "",
      !date ? "preferred_date" : "",
      !time ? "preferred_time" : ""
    ].filter(Boolean);

    return {
      patient_name: patientName,
      reason,
      preferred_date: date,
      preferred_time: time,
      missing_fields,
      should_handoff: true,
      confidence: 0.65
    };
  }

  private buildConversationFallback(context?: ReplyContextState): string {
    if (isFirstTurn(context)) {
      return "Hola, soy Eros Bot, asistente de Clinica Eros Neuronal. Puedo ayudarte con informacion general de la clinica, orientacion inicial y solicitudes de cita.";
    }
    if (context?.active_goal === "appointment" && context.pending_question) {
      return `Seguimos con tu solicitud de cita. ${context.pending_question} Si prefieres avanzar directo, puedes agendar aqui: ${this.settings.clinic.bookingUrl}`;
    }
    return "Seguimos con tu consulta. Puedo ayudarte con informacion general de la clinica, orientacion inicial y solicitudes de cita.";
  }

  private buildAppointmentFallback(appointment: AppointmentIntentPayload): string {
    if (appointment.missing_fields.length > 0) {
      const labels: Record<string, string> = {
        patient_name: "nombre del paciente",
        reason: "motivo o especialidad",
        preferred_date: "fecha preferida",
        preferred_time: "hora preferida"
      };
      return `Soy Eros Bot y puedo ayudarte a dejar lista tu cita en Clinica Eros Neuronal. Para continuar necesito: ${appointment.missing_fields.map((field) => labels[field] ?? field).join(", ")}. Si prefieres avanzar directo, puedes agendar aqui: ${this.settings.clinic.bookingUrl}`;
    }
    return `Ya tengo los datos necesarios para tu cita en Clinica Eros Neuronal. Puedes agendar directamente aqui: ${this.settings.clinic.bookingUrl}`;
  }

  private async requestJson(system: string, user: string, temperature?: number): Promise<Record<string, unknown> | null> {
    const text = await this.requestText(system, user, temperature);
    return text ? extractJsonObject(text) : null;
  }

  private async requestText(system: string, user: string, temperature?: number): Promise<string | null> {
    const baseUrl = this.settings.llm.baseUrl?.trim();
    if (!baseUrl || !this.settings.llm.apiKey) {
      return null;
    }

    const url = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/$/, "")}/chat/completions`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.settings.llm.apiKey}`
        },
        body: JSON.stringify({
          model: this.settings.llm.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          ...(temperature !== undefined ? { temperature } : this.settings.llm.temperature !== undefined ? { temperature: this.settings.llm.temperature } : {})
        }),
        signal: AbortSignal.timeout(this.settings.llm.timeoutMs)
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
}
