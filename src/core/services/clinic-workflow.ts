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
  ClinicDspyBridge,
  ClinicKnowledgeContext,
  ClinicKnowledgeProvider,
  ClinicLlmService,
  ClinicMemoryRuntime,
  ClinicRoutingService,
  TraceSink
} from "../../domain/ports";

export interface ClinicWorkflowDiagnostics {
  retrieval?: {
    backend: ClinicKnowledgeContext["backend"];
    status: ClinicKnowledgeContext["status"];
    resultCount: number;
    fallbackUsed: boolean;
  };
  shortTermMemory?: {
    summarizedTurns: number;
    retainedTurns: number;
    summaryUpdated: boolean;
  };
  reply?: {
    node: ClinicGraphNode;
    provider: "dspy_service" | "llm_service";
    replyMode: GeneratedReply["reply_mode"];
  };
  appointmentExtraction?: {
    provider: "llm_service";
    clinicContextPresent: boolean;
  };
}

export interface ClinicWorkflowRunResult {
  state: GraphState;
  diagnostics: ClinicWorkflowDiagnostics;
}

function mergeDiagnostics(
  left: ClinicWorkflowDiagnostics,
  right: ClinicWorkflowDiagnostics
): ClinicWorkflowDiagnostics {
  return {
    ...left,
    ...right,
    retrieval: right.retrieval ?? left.retrieval,
    shortTermMemory: right.shortTermMemory ?? left.shortTermMemory,
    reply: right.reply ?? left.reply,
    appointmentExtraction: right.appointmentExtraction ?? left.appointmentExtraction
  };
}

const GraphAnnotation = Annotation.Root({
  state: Annotation<GraphState>({
    reducer: (_left, right) => right,
    default: () => createEmptyGraphState()
  }),
  traceId: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => ""
  }),
  diagnostics: Annotation<ClinicWorkflowDiagnostics>({
    reducer: mergeDiagnostics,
    default: () => ({})
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

function getRecentTurnLimit(settings: AppSettings): number {
  return Math.max(1, Math.min(settings.prompt.recentTurnsLimit, 5));
}

function appendRecentTurn(
  recentTurns: Array<Record<string, string>>,
  userMessage: string,
  assistantMessage: string
) {
  return [...recentTurns, { user: compact(userMessage, 220), assistant: compact(assistantMessage, 220) }];
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

function deriveRoutingMode(state: GraphState): RoutingPacket["current_mode"] {
  if (state.active_goal === "appointment" || ["collecting_slots", "ready_for_handoff"].includes(state.stage)) {
    return "appointment";
  }
  if (state.active_goal === "information" || state.stage === "lookup" || Boolean(state.last_tool_result.trim())) {
    return "information";
  }
  return "conversation";
}

function extractPendingQuestion(replyText: string): string {
  const normalized = replyText.replace(/\s+/g, " ").trim();
  if (!normalized.includes("?")) {
    return "";
  }
  const matches = normalized.match(/[^?.!]*\?/g) ?? [];
  if (matches.length === 0) {
    return "";
  }
  return compact(matches.slice(-2).join(" ").trim(), 220);
}

function inferConversationStage(state: GraphState): string {
  const userMessage = state.last_user_message.toLowerCase();
  if (/(depres|ansiedad|estres|estr[eé]s|triste|sin ganas|insomnio|crisis|terapia|psicolog|psiquiatr)/i.test(userMessage)) {
    return "in_assessment";
  }
  if (state.active_goal === "conversation" && state.stage && !["lookup", "collecting_slots", "ready_for_handoff"].includes(state.stage)) {
    return state.stage;
  }
  return "open";
}

export class ClinicWorkflow {
  private readonly graph;

  constructor(
    private readonly routingService: ClinicRoutingService,
    private readonly llmService: ClinicLlmService,
    private readonly memoryRuntime: ClinicMemoryRuntime,
    private readonly knowledgeProvider: ClinicKnowledgeProvider,
    private readonly dspyBridge: ClinicDspyBridge,
    private readonly settings: AppSettings,
    private readonly traceSink?: TraceSink
  ) {
    this.graph = new StateGraph(GraphAnnotation)
      .addNode("load_context", async ({ state, traceId }) =>
        this.traceNode("load_context", traceId, state, (current) => this.loadContext(current, traceId))
      )
      .addNode("route", async ({ state, traceId }) =>
        this.traceNode("route", traceId, state, (current) => this.route(current, traceId))
      )
      .addNode("conversation", async ({ state, traceId }) =>
        this.traceNode("conversation", traceId, state, (current) => this.conversation(current, traceId))
      )
      .addNode("rag", async ({ state, traceId }) =>
        this.traceNode("rag", traceId, state, (current) => this.rag(current, traceId))
      )
      .addNode("appointment", async ({ state, traceId }) =>
        this.traceNode("appointment", traceId, state, (current) => this.appointment(current, traceId))
      )
      .addNode("finalize_turn", async ({ state, traceId }) =>
        this.traceNode("finalize_turn", traceId, state, async (current) => this.finalizeTurn(current))
      )
      .addNode("store_memory", async ({ state, traceId }) =>
        this.traceNode("store_memory", traceId, state, (current) => this.storeMemory(current, traceId))
      )
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

  async run(initialState: GraphState, traceId = ""): Promise<ClinicWorkflowRunResult> {
    const result = await this.graph.invoke({ state: initialState, traceId, diagnostics: {} });
    return {
      state: result.state,
      diagnostics: result.diagnostics
    };
  }

  private async loadContext(state: GraphState, traceId?: string): Promise<GraphState> {
    const context = await this.memoryRuntime.loadContext(
      state.session_id,
      state.actor_id,
      state.last_user_message || state.summary || "contexto del usuario",
      toShortTermState(state)
    );
    await this.trace(traceId, "clinic.load_context.output", context);

    return {
      ...state,
      turn_count: context.turn_count,
      recalled_memories: this.routingService.summarizeMemories(context.recalled_memories)
    };
  }

  private async route(state: GraphState, traceId?: string): Promise<GraphState> {
    const decision = await this.routingService.routeState({
      user_message: state.last_user_message,
      conversation_summary: state.summary,
      current_mode: deriveRoutingMode(state),
      last_tool_result: state.last_tool_result,
      last_assistant_message: state.last_assistant_message,
      memories: state.recalled_memories
    }, traceId);

    return {
      ...state,
      next_node: decision.next_node,
      intent: decision.intent,
      confidence: decision.confidence,
      needs_retrieval: decision.needs_retrieval,
      routing_reason: decision.reason,
      state_update: decision.state_update,
      summary_refresh_requested: state.summary_refresh_requested
    };
  }

  private async conversation(
    state: GraphState,
    traceId?: string
  ): Promise<{ state: GraphState; diagnostics: ClinicWorkflowDiagnostics }> {
    const payload = this.buildConversationPayload(state);
    const context = buildReplyContext(state);
    await this.trace(traceId, "clinic.conversation.input", payload);
    const dspyReply = await this.dspyBridge.predictConversationReply(payload);
    const generatedReply = dspyReply ?? (await this.llmService.generateConversationReply(payload, context));
    await this.trace(traceId, "clinic.conversation.output", {
      response_text: generatedReply.response_text
    });
    await this.trace(traceId, "clinic.conversation.meta", {
      provider: dspyReply ? "dspy" : "llm",
      reply_mode: generatedReply.reply_mode
    });
    const pendingQuestion = extractPendingQuestion(generatedReply.response_text);

    return {
      state: {
        ...state,
        response_text: generatedReply.response_text,
        last_assistant_message: generatedReply.response_text,
        active_goal: "conversation",
        stage: inferConversationStage(state),
        pending_action: pendingQuestion ? "follow_up" : "",
        pending_question: pendingQuestion,
        last_tool_result: "",
        handoff_required: false,
        appointment_payload: {}
      },
      diagnostics: {
        reply: {
          node: "conversation",
          provider: dspyReply ? "dspy_service" : "llm_service",
          replyMode: generatedReply.reply_mode
        }
      }
    };
  }

  private async rag(
    state: GraphState,
    traceId?: string
  ): Promise<{ state: GraphState; diagnostics: ClinicWorkflowDiagnostics }> {
    const ragContext = await this.knowledgeProvider.buildContext(
      state.last_user_message || "contexto del usuario",
      state.actor_id,
      state.recalled_memories
    );
    await this.trace(traceId, "clinic.rag.retrieval.meta", {
      backend: ragContext.backend,
      status: ragContext.status,
      result_count: ragContext.resultCount,
      fallback_used: ragContext.fallbackUsed
    });
    const payload = {
      ...this.buildConversationPayload(state),
      retrieved_context: ragContext.text
    };
    const context = buildReplyContext(state);
    await this.trace(traceId, "clinic.rag.input", payload);
    const dspyReply = await this.dspyBridge.predictRagReply(payload);
    const generatedReply = dspyReply ?? (await this.llmService.generateRagReply(payload, context));
    await this.trace(traceId, "clinic.rag.output", {
      response_text: generatedReply.response_text
    });
    await this.trace(traceId, "clinic.rag.meta", {
      provider: dspyReply ? "dspy" : "llm",
      reply_mode: generatedReply.reply_mode
    });
    const pendingQuestion = extractPendingQuestion(generatedReply.response_text);

    return {
      state: {
        ...state,
        last_tool_result: compact(ragContext.text, 240),
        response_text: generatedReply.response_text,
        last_assistant_message: generatedReply.response_text,
        active_goal: "information",
        stage: "lookup",
        pending_action: pendingQuestion ? "clarify_information_need" : "",
        pending_question: pendingQuestion,
        handoff_required: false,
        appointment_payload: {}
      },
      diagnostics: {
        retrieval: {
          backend: ragContext.backend,
          status: ragContext.status,
          resultCount: ragContext.resultCount,
          fallbackUsed: ragContext.fallbackUsed
        },
        reply: {
          node: "rag",
          provider: dspyReply ? "dspy_service" : "llm_service",
          replyMode: generatedReply.reply_mode
        }
      }
    };
  }

  private async appointment(
    state: GraphState,
    traceId?: string
  ): Promise<{ state: GraphState; diagnostics: ClinicWorkflowDiagnostics }> {
    const context = buildReplyContext(state);
    const extractionPayload = {
      user_message: state.last_user_message,
      memories: state.recalled_memories,
      clinic_context: "",
      contact_name: state.contact_name,
      current_slots: state.appointment_slots,
      pending_question: state.pending_question,
      reply_context: context
    };
    await this.trace(traceId, "clinic.appointment_extraction.input", extractionPayload);
    const appointment = await this.llmService.extractAppointmentPayload({
      user_message: extractionPayload.user_message,
      memories: extractionPayload.memories,
      clinic_context: extractionPayload.clinic_context,
      contact_name: extractionPayload.contact_name,
      current_slots: extractionPayload.current_slots,
      pending_question: extractionPayload.pending_question,
      context
    });
    await this.trace(traceId, "clinic.appointment_extraction.output", appointment as Record<string, unknown>);

    const payload = {
      ...this.buildConversationPayload(state),
      contact_name: state.contact_name,
      appointment_state: appointment,
      booking_url: this.settings.clinic.bookingUrl
    };
    await this.trace(traceId, "clinic.appointment_reply.input", payload);
    const dspyReply = await this.dspyBridge.predictAppointmentReply(payload);
    const generatedReply = dspyReply ?? (await this.llmService.generateAppointmentReply(payload, appointment, context));
    await this.trace(traceId, "clinic.appointment_reply.output", {
      response_text: generatedReply.response_text
    });
    await this.trace(traceId, "clinic.appointment_reply.meta", {
      provider: dspyReply ? "dspy" : "llm",
      reply_mode: generatedReply.reply_mode
    });

    const appointmentSlots = mergeSlots(state.appointment_slots, appointment as Record<string, unknown>);
    const pendingQuestion = appointment.missing_fields.length > 0 ? buildPendingQuestion(appointment.missing_fields) : "";
    const stage = appointment.missing_fields.length > 0 ? "collecting_slots" : "ready_for_handoff";
    const pendingAction = appointment.missing_fields.length > 0 ? "collecting_slots" : "";
    const responseText =
      appointment.missing_fields.length > 0
        ? generatedReply.response_text
        : `${generatedReply.response_text} Tu solicitud quedo lista para recepcion.`.trim();

    return {
      state: {
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
      },
      diagnostics: {
        appointmentExtraction: {
          provider: "llm_service",
          clinicContextPresent: false
        },
        reply: {
          node: "appointment",
          provider: dspyReply ? "dspy_service" : "llm_service",
          replyMode: generatedReply.reply_mode
        }
      }
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

    cleaned.summary_refresh_requested = cleaned.recent_turns.length >= getRecentTurnLimit(this.settings);

    return cleaned;
  }

  private async storeMemory(
    state: GraphState,
    traceId?: string
  ): Promise<GraphState | { state: GraphState; diagnostics: ClinicWorkflowDiagnostics }> {
    if (!state.response_text || !state.last_user_message || !state.actor_id || !state.session_id) {
      return state;
    }

    const recentTurnsWithCurrent = appendRecentTurn(state.recent_turns, state.last_user_message, state.response_text);
    const recentTurnLimit = getRecentTurnLimit(this.settings);
    const overflowTurns = recentTurnsWithCurrent.slice(0, Math.max(0, recentTurnsWithCurrent.length - recentTurnLimit));
    const retainedRecentTurns = recentTurnsWithCurrent.slice(-recentTurnLimit);
    const updatedSummary = await this.foldSummary(state, overflowTurns, traceId);
    const shortTerm = toShortTermState({
      ...state,
      summary: updatedSummary,
      recent_turns: retainedRecentTurns
    });
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
        refresh_summary: false
      },
      traceId
    );
    await this.trace(traceId, "clinic.store_memory.output", commitResult as unknown as Record<string, unknown>);

    const nextState = {
      ...state,
      summary: compact(updatedSummary, 700),
      summary_refresh_requested: false,
      recent_turns: retainedRecentTurns
    };

    if (overflowTurns.length === 0) {
      return nextState;
    }

    return {
      state: nextState,
      diagnostics: {
        shortTermMemory: {
          summarizedTurns: overflowTurns.length,
          retainedTurns: retainedRecentTurns.length,
          summaryUpdated: updatedSummary !== state.summary
        }
      }
    };
  }

  private async foldSummary(
    state: GraphState,
    overflowTurns: Array<Record<string, string>>,
    traceId?: string
  ): Promise<string> {
    let summary = state.summary;

    for (const turn of overflowTurns) {
      const userMessage = String(turn.user ?? "").trim();
      const assistantMessage = String(turn.assistant ?? "").trim();
      if (!userMessage && !assistantMessage) {
        continue;
      }

      const signaturePayload = {
        current_summary: summary,
        user_message: userMessage,
        assistant_message: assistantMessage,
        active_goal: state.active_goal,
        stage: state.stage
      };
      await this.trace(traceId, "clinic.state_summary.input", signaturePayload);
      summary = await this.llmService.buildStateSummary(signaturePayload);
      await this.trace(traceId, "clinic.state_summary.output", {
        updated_summary: summary
      });
    }

    return summary;
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

  private async traceNode(
    nodeName: string,
    traceId: string,
    state: GraphState,
    task: (current: GraphState) => Promise<GraphState | { state: GraphState; diagnostics?: ClinicWorkflowDiagnostics }>
  ): Promise<{ state: GraphState; diagnostics?: ClinicWorkflowDiagnostics }> {
    await this.trace(traceId, `langgraph.node.${nodeName}.before`, state);
    const outcome = await task(state);
    const nextState = "state" in outcome ? outcome.state : outcome;
    const diagnostics = "state" in outcome ? outcome.diagnostics : undefined;
    await this.trace(traceId, `langgraph.node.${nodeName}.after`, nextState);
    return {
      state: nextState,
      ...(diagnostics ? { diagnostics } : {})
    };
  }

  private async trace(traceId: string | undefined, event: string, payload: unknown): Promise<void> {
    if (!traceId) {
      return;
    }
    await this.traceSink?.append(traceId, event, payload);
  }
}
