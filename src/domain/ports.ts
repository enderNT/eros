import type {
  AddMemoryResult,
  Capability,
  CapabilityResult,
  ClinicConfig,
  GeneratedReply,
  GraphState,
  ExecutionContext,
  InboundMessage,
  KnowledgeDocument,
  MemoryCommitResult,
  MemoryContext,
  MemoryHit,
  PromptMemorySelection,
  ReplyContextState,
  RoutingPacket,
  StateRoutingDecision,
  RouteDecision,
  ShortTermState,
  TurnMemoryInput,
  TurnOutcome,
  TurnRecord
} from "./contracts";

export interface MemoryProvider {
  addTurn(messages: TurnRecord[], actorId: string, agentId: string, sessionId: string, metadata: Record<string, unknown>): Promise<AddMemoryResult>;
  search(query: string, actorId: string, agentId: string, topK: number, threshold: number): Promise<MemoryHit[]>;
}

export interface KnowledgeProvider {
  retrieve(query: string, topK: number): Promise<KnowledgeDocument[]>;
}

export interface LlmProvider {
  decideRoute(input: {
    inbound: InboundMessage;
    state: ShortTermState;
    promptDigest: string;
  }): Promise<RouteDecision>;
  generateReply(capability: Capability, context: ExecutionContext): Promise<CapabilityResult>;
  summarizeState(input: { state: ShortTermState; recentUserText: string }): Promise<string>;
  summarizeMemories(input: { query: string; memories: MemoryHit[]; budgetChars: number }): Promise<string>;
}

export interface DspyBridge {
  health(): Promise<boolean>;
  predictRouteDecision?(payload: {
    inbound: InboundMessage;
    state: ShortTermState;
    promptDigest: string;
  }): Promise<RouteDecision | null>;
  predictReply?(capability: Capability, context: ExecutionContext): Promise<CapabilityResult | null>;
}

export interface HealthStatus {
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface TraceSink {
  startTurn(inbound: InboundMessage): Promise<string>;
  append(traceId: string, event: string, payload: unknown): Promise<void>;
  projectRouteDecision(traceId: string, decision: RouteDecision): Promise<void>;
  projectReply(traceId: string, outcome: TurnOutcome, inbound: InboundMessage): Promise<void>;
  endTurn(traceId: string, outcome: TurnOutcome): Promise<void>;
  failTurn(traceId: string, error: unknown): Promise<void>;
  flush(traceId: string): Promise<void>;
  health(): Promise<HealthStatus>;
  close(timeoutMs?: number): Promise<void>;
}

export interface OutboundTransport {
  emit(
    outcome: TurnOutcome,
    inbound: InboundMessage
  ): Promise<
    | void
    | {
        status: string;
        destination?: string;
        response?: Record<string, unknown>;
      }
  >;
}

export interface StateStore {
  load(sessionId: string): Promise<ShortTermState>;
  save(sessionId: string, state: ShortTermState): Promise<void>;
}

export interface ClinicStateStore {
  load(sessionId: string): Promise<GraphState | null>;
  save(sessionId: string, state: GraphState): Promise<void>;
  health(): Promise<HealthStatus>;
  close(timeoutMs?: number): Promise<void>;
}

export interface ClinicMemoryRuntime {
  loadContext(sessionId: string, actorId: string, query: string, shortTerm: ShortTermState): Promise<MemoryContext>;
  commitTurn(
    sessionId: string,
    actorId: string,
    turn: TurnMemoryInput,
    shortTerm: ShortTermState,
    domainState: Record<string, unknown>,
    traceId?: string
  ): Promise<MemoryCommitResult>;
}

export interface ClinicLlmService {
  classifyStateRoute(routingPacket: RoutingPacket, guardHint?: Record<string, unknown>): Promise<StateRoutingDecision>;
  generateConversationReply(payload: Record<string, unknown>, context?: ReplyContextState): Promise<GeneratedReply>;
  generateRagReply(payload: Record<string, unknown>, context?: ReplyContextState): Promise<GeneratedReply>;
  extractAppointmentPayload(input: {
    user_message: string;
    memories: string[];
    clinic_context: string;
    contact_name: string;
    current_slots?: Record<string, unknown>;
    pending_question?: string;
    context?: ReplyContextState;
  }): Promise<{
    patient_name?: string | null;
    reason?: string | null;
    preferred_date?: string | null;
    preferred_time?: string | null;
    missing_fields: string[];
    should_handoff: boolean;
    confidence: number;
  }>;
  generateAppointmentReply(
    payload: Record<string, unknown>,
    appointment: {
      patient_name?: string | null;
      reason?: string | null;
      preferred_date?: string | null;
      preferred_time?: string | null;
      missing_fields: string[];
      should_handoff: boolean;
      confidence: number;
    },
    context?: ReplyContextState
  ): Promise<GeneratedReply>;
  buildStateSummary(input: {
    current_summary: string;
    user_message: string;
    assistant_message: string;
    active_goal: string;
    stage: string;
  }): Promise<string>;
}

export interface ClinicRoutingService {
  routeState(input: {
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
  }, traceId?: string): Promise<StateRoutingDecision>;
  summarizeMemories(memories: string[]): string[];
}

export interface ClinicDspyBridge {
  health(): Promise<boolean>;
  predictStateRouter(payload: RoutingPacket & { guard_hint?: Record<string, unknown> }): Promise<StateRoutingDecision | null>;
  predictConversationReply(payload: Record<string, unknown>): Promise<GeneratedReply | null>;
  predictRagReply(payload: Record<string, unknown>): Promise<GeneratedReply | null>;
  predictAppointmentReply(payload: Record<string, unknown>): Promise<GeneratedReply | null>;
}

export interface ClinicKnowledgeProvider {
  buildContext(query: string, contactId: string, clinicContext: string, memories: string[]): Promise<string>;
}

export interface ClinicConfigProvider {
  load(): Promise<ClinicConfig>;
  toContextText(): Promise<string>;
}
