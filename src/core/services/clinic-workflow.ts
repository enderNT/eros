import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AppSettings } from "../../config";
import type {
  AppointmentIntentPayload,
  ClinicGraphNode,
  GeneratedReply,
  GraphState,
  ReplyContextState,
  RoutingPacket,
  ShortTermState
} from "../../domain/contracts";
import type {
  ClinicConfigProvider,
  ClinicDspyBridge,
  ClinicKnowledgeProvider,
  ClinicLlmService,
  ClinicMemoryRuntime,
  ClinicRoutingService
} from "../../domain/ports";

const GraphAnnotation = Annotation.Root({
  state: Annotation<GraphState>({
    reducer: (_left, right) => right,
    default: () => createEmptyGraphState()
  })
});

type WorkflowState = typeof GraphAnnotation.State;

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function createEmptyGraphState(): GraphState {
  return {
    session_id: "",
    actor_id: "",
    contact_name: "Paciente",
    last_user_message: "",
    last_assistant_message: "",
    summary: "",
    active_goal: "",
    stage: "",
    pending_action: "",
    pending_question: "",
    appointment_slots: {},
    last_tool_result: "",
    recalled_memories: [],
    next_node: "conversation",
    intent: "conversation",
    confidence: 0,
    needs_retrieval: false,
    routing_reason: "",
    state_update: {},
    response_text: "",
    appointment_payload: {},
    handoff_required: false,
    turn_count: 0,
    summary_refresh_requested: false,
    recent_turns: []
  };
}

function toShortTermState(state: GraphState): ShortTermState {
  return {
    summary: state.summary,
    recentTurns: state.recent_turns.map((turn) => ({
      role: "user",
      text: `${turn.user ?? ""} ${turn.assistant ?? ""}`.trim(),
      timestamp: new Date().toISOString()
    })),
    activeGoal: state.active_goal,
    stage: state.stage,
    pendingAction: state.pending_action,
    pendingQuestion: state.pending_question,
    appointmentSlots: state.appointment_slots,
    lastToolResult: state.last_tool_result,
    lastAssistantMessage: state.last_assistant_message,
    lastUserMessage: state.last_user_message,
    continuitySignals: [],
    turnCount: state.turn_count
  };
}

function buildReplyContext(state: GraphState): ReplyContextState {
  return {
    turn_count: state.turn_count,
    summary: state.summary,
    active_goal: state.active_goal,
    stage: state.stage,
    pending_action: state.pending_action,
    pending_question: state.pending_question,
    last_assistant_message: state.last_assistant_message,
    last_tool_result: state.last_tool_result,
    appointment_slots: state.appointment_slots,
    recent_turns: state.recent_turns
  };
}

function appendRecentTurn(recentTurns: Array<Record<string, string>>, userMessage: string, assistantMessage: string, limit = 3) {
  return [...recentTurns, { user: compact(userMessage, 220), assistant: compact(assistantMessage, 220) }].slice(-limit);
}

function mergeSlots(existing: Record<string, unknown>, incoming: Record<string, unknown>) {
  const merged = { ...existing };
  for (const key of ["patient_name", "reason", "preferred_date", "preferred_time"]) {
    if (incoming[key]) {
      merged[key] = incoming[key];
    }
  }
  if (incoming.missing_fields !== undefined) {
    merged.missing_fields = Array.isArray(incoming.missing_fields) ? incoming.missing_fields : [];
  }
  if (incoming.confidence !== undefined) {
    merged.confidence = incoming.confidence;
  }
  if (incoming.should_handoff !== undefined) {
    merged.should_handoff = incoming.should_handoff;
  }
  return merged;
}

function buildPendingQuestion(missingFields: string[]): string {
  const fieldNames: Record<string, string> = {
    patient_name: "el nombre del paciente",
    reason: "el motivo o especialidad",
    preferred_date: "la fecha preferida",
    preferred_time: "la hora preferida"
  };
  const readable = missingFields.map((field) => fieldNames[field] ?? field);
  if (readable.length === 0) return "";
  if (readable.length === 1) return `Necesito ${readable[0]} para continuar.`;
  if (readable.length === 2) return `Necesito ${readable[0]} y ${readable[1]} para continuar.`;
  return `Necesito ${readable.slice(0, -1).join(", ")} y ${readable.at(-1)} para continuar.`;
}

export class ClinicWorkflow {
  private readonly graph;

  constructor(
    private readonly routingService: ClinicRoutingService,
    private readonly llmService: ClinicLlmService,
    private readonly memoryRuntime: ClinicMemoryRuntime,
    private readonly clinicConfigProvider: ClinicConfigProvider,
    private readonly knowledgeProvider: ClinicKnowledgeProvider,
    private readonly dspyBridge: ClinicDspyBridge,
    private readonly settings: AppSettings
  ) {
    this.graph = new StateGraph(GraphAnnotation)
      .addNode("load_context", async ({ state }) => ({ state: await this.loadContext(state) }))
      .addNode("route", async ({ state }) => ({ state: await this.route(state) }))
      .addNode("conversation", async ({ state }) => ({ state: await this.conversation(state) }))
      .addNode("rag", async ({ state }) => ({ state: await this.rag(state) }))
      .addNode("appointment", async ({ state }) => ({ state: await this.appointment(state) }))
      .addNode("finalize_turn", async ({ state }) => ({ state: this.finalizeTurn(state) }))
      .addNode("store_memory", async ({ state }) => ({ state: await this.storeMemory(state) }))
      .addEdge(START, "load_context")
      .addEdge("load_context", "route")
      .addConditionalEdges("route", ({ state }) => state.next_node, {
        conversation: "conversation",
        rag: "rag",
        appointment: "appointment"
      })
      .addEdge("conversation", "finalize_turn")
      .addEdge("rag", "finalize_turn")
      .addEdge("appointment", "finalize_turn")
      .addEdge("finalize_turn", "store_memory")
      .addEdge("store_memory", END)
      .compile();
  }

  async run(initialState: GraphState): Promise<GraphState> {
    const result = await this.graph.invoke({ state: initialState });
    return result.state;
  }

  private async loadContext(state: GraphState): Promise<GraphState> {
    const context = await this.memoryRuntime.loadContext(
      state.session_id,
      state.actor_id,
      state.last_user_message || state.summary || "contexto del usuario",
      toShortTermState(state)
    );

    return {
      ...state,
      turn_count: context.turn_count,
      recalled_memories: this.routingService.summarizeMemories(context.recalled_memories)
    };
  }

  private async route(state: GraphState): Promise<GraphState> {
    const decision = await this.routingService.routeState({
      user_message: state.last_user_message,
      conversation_summary: state.summary,
      active_goal: state.active_goal,
      stage: state.stage,
      pending_action: state.pending_action,
      pending_question: state.pending_question,
      appointment_slots: state.appointment_slots,
      last_tool_result: state.last_tool_result,
      last_user_message: state.last_user_message,
      last_assistant_message: state.last_assistant_message,
      memories: state.recalled_memories
    });

    return {
      ...this.applyStatePatch(state, decision.state_update),
      next_node: decision.next_node,
      intent: decision.intent,
      confidence: decision.confidence,
      needs_retrieval: decision.needs_retrieval,
      routing_reason: decision.reason,
      state_update: decision.state_update,
      summary_refresh_requested: state.summary_refresh_requested || state.active_goal !== String(decision.state_update.active_goal ?? state.active_goal)
    };
  }

  private async conversation(state: GraphState): Promise<GraphState> {
    const payload = this.buildConversationPayload(state);
    const context = buildReplyContext(state);
    const generatedReply =
      (await this.dspyBridge.predictConversationReply(payload)) ??
      (await this.llmService.generateConversationReply(payload, context));

    return {
      ...state,
      response_text: generatedReply.response_text,
      last_assistant_message: generatedReply.response_text,
      last_tool_result: "",
      handoff_required: false,
      appointment_payload: {}
    };
  }

  private async rag(state: GraphState): Promise<GraphState> {
    const clinicContext = await this.clinicConfigProvider.toContextText();
    const ragContext = await this.knowledgeProvider.buildContext(
      state.last_user_message || "contexto del usuario",
      state.actor_id,
      clinicContext,
      state.recalled_memories
    );
    const payload = {
      ...this.buildConversationPayload(state),
      retrieved_context: ragContext
    };
    const context = buildReplyContext(state);
    const generatedReply =
      (await this.dspyBridge.predictRagReply(payload)) ??
      (await this.llmService.generateRagReply(payload, context));

    return {
      ...state,
      last_tool_result: compact(ragContext, 240),
      response_text: generatedReply.response_text,
      last_assistant_message: generatedReply.response_text,
      handoff_required: false,
      appointment_payload: {}
    };
  }

  private async appointment(state: GraphState): Promise<GraphState> {
    const clinicContext = await this.clinicConfigProvider.toContextText();
    const context = buildReplyContext(state);
    const appointment = await this.llmService.extractAppointmentPayload({
      user_message: state.last_user_message,
      memories: state.recalled_memories,
      clinic_context: clinicContext,
      contact_name: state.contact_name,
      current_slots: state.appointment_slots,
      pending_question: state.pending_question,
      context
    });

    const payload = {
      ...this.buildConversationPayload(state),
      contact_name: state.contact_name,
      appointment_state: appointment,
      booking_url: this.settings.clinic.bookingUrl
    };
    const generatedReply =
      (await this.dspyBridge.predictAppointmentReply(payload)) ??
      (await this.llmService.generateAppointmentReply(payload, appointment, context));

    const appointmentSlots = mergeSlots(state.appointment_slots, appointment as Record<string, unknown>);
    const pendingQuestion = appointment.missing_fields.length > 0 ? buildPendingQuestion(appointment.missing_fields) : "";
    const stage = appointment.missing_fields.length > 0 ? "collecting_slots" : "ready_for_handoff";
    const pendingAction = appointment.missing_fields.length > 0 ? "collecting_slots" : "";
    const responseText =
      appointment.missing_fields.length > 0
        ? generatedReply.response_text
        : `${generatedReply.response_text} Tu solicitud quedo lista para recepcion.`.trim();

    return {
      ...state,
      response_text: responseText,
      last_assistant_message: responseText,
      appointment_slots: appointmentSlots,
      pending_question: pendingQuestion,
      pending_action: pendingAction,
      active_goal: "appointment",
      stage,
      last_tool_result: compact(
        `appointment missing=${appointment.missing_fields.join(",") || "none"} confidence=${appointment.confidence.toFixed(2)}`,
        200
      ),
      handoff_required: appointment.should_handoff,
      appointment_payload: appointment as Record<string, unknown>
    };
  }

  private finalizeTurn(state: GraphState): GraphState {
    const cleaned = structuredClone(state);
    if (cleaned.next_node !== "appointment") {
      cleaned.pending_action = "";
      cleaned.pending_question = "";
      cleaned.appointment_slots = {};
      if (["collecting_slots", "ready_for_handoff"].includes(cleaned.stage)) {
        cleaned.stage = "open";
      }
      if (cleaned.active_goal === "appointment" && !cleaned.handoff_required) {
        cleaned.active_goal = "conversation";
      }
    }
    if (cleaned.next_node !== "rag") {
      cleaned.last_tool_result = "";
    }

    cleaned.summary_refresh_requested =
      cleaned.summary_refresh_requested ||
      cleaned.summary.length >= this.settings.state.refreshCharThreshold ||
      (cleaned.turn_count > 0 && cleaned.turn_count % this.settings.state.refreshTurnThreshold === 0) ||
      (cleaned.next_node === "appointment" && cleaned.stage === "ready_for_handoff");

    return cleaned;
  }

  private async storeMemory(state: GraphState): Promise<GraphState> {
    if (!state.response_text || !state.last_user_message || !state.actor_id || !state.session_id) {
      return state;
    }

    const shortTerm = toShortTermState(state);
    const commitResult = await this.memoryRuntime.commitTurn(
      state.session_id,
      state.actor_id,
      {
        user_message: state.last_user_message,
        assistant_message: state.response_text,
        route: state.next_node
      },
      shortTerm,
      {
        appointment_slots: state.appointment_slots,
        handoff_required: state.handoff_required,
        contact_name: state.contact_name,
        response_text: state.response_text,
        refresh_summary: state.summary_refresh_requested
      }
    );

    return {
      ...state,
      summary: state.summary_refresh_requested ? compact(commitResult.summary, 700) : state.summary,
      summary_refresh_requested: false,
      recent_turns: appendRecentTurn(state.recent_turns, state.last_user_message, state.response_text)
    };
  }

  private applyStatePatch(state: GraphState, patch: Record<string, unknown>): GraphState {
    const merged = structuredClone(state);
    for (const [key, value] of Object.entries(patch)) {
      if (key === "appointment_slots" && value && typeof value === "object" && !Array.isArray(value)) {
        merged.appointment_slots = mergeSlots(merged.appointment_slots, value as Record<string, unknown>);
        continue;
      }
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
    return merged;
  }

  private buildConversationPayload(state: GraphState): Record<string, unknown> {
    return {
      user_message: state.last_user_message,
      summary: state.summary,
      active_goal: state.active_goal,
      stage: state.stage,
      pending_question: state.pending_question,
      last_assistant_message: state.last_assistant_message,
      recent_turns: state.recent_turns,
      memories: state.recalled_memories
    };
  }
}
