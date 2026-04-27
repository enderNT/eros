export type Capability = "conversation" | "knowledge" | "action";
export type ClinicGraphNode = "conversation" | "rag" | "appointment";

export interface InboundMessage {
  sessionId: string;
  actorId: string;
  channel: string;
  text: string;
  correlationId?: string;
  parentRunId?: string;
  trigger?: string;
  accountId?: string;
  contactName?: string;
  deliveryContext?: {
    provider: string;
    accountId?: string;
    conversationId?: string;
    inboxId?: string;
    contactId?: string;
    callbackUrl?: string;
    chatRequestId?: string;
    userMessageId?: string;
    integrationId?: string;
    integrationTransport?: string;
    integrationRequestId?: string;
    systemPrompt?: string | null;
    history?: Array<{
      role: "user" | "assistant";
      text: string;
    }>;
  };
  rawPayload: unknown;
  receivedAt: string;
}

export interface RouteDecision {
  capability: Capability;
  intent: string;
  confidence: number;
  needsKnowledge: boolean;
  statePatch: Partial<ShortTermState>;
  reason: string;
}

export interface CapabilityResult {
  responseText: string;
  statePatch?: Partial<ShortTermState>;
  handoffRequired: boolean;
  artifacts: Record<string, unknown>;
  memoryHints: string[];
}

export interface TurnOutcome {
  capability: Capability;
  intent: string;
  confidence: number;
  responseText: string;
  handoffRequired: boolean;
  stateSnapshot: ShortTermState;
  artifacts: Record<string, unknown>;
}

export interface TurnRecord {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}

export interface ShortTermState {
  summary: string;
  recentTurns: TurnRecord[];
  activeGoal?: string;
  stage?: string;
  pendingAction?: string;
  pendingQuestion?: string;
  appointmentSlots?: Record<string, unknown>;
  lastToolResult?: string;
  lastAssistantMessage?: string;
  lastUserMessage?: string;
  lastCapability?: Capability;
  lastIntent?: string;
  continuitySignals: string[];
  turnCount: number;
}

export interface MemoryHit {
  id: string;
  memory: string;
  score: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AddMemoryResult {
  stored: boolean;
  count: number;
}

export interface KnowledgeDocument {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface PromptMemorySelection {
  rawRecall: MemoryHit[];
  promptDigest: string;
}

export interface ExecutionContext {
  inbound: InboundMessage;
  shortTermState: ShortTermState;
  memorySelection: PromptMemorySelection;
  knowledge: KnowledgeDocument[];
  routeDecision: RouteDecision;
  traceId: string;
}

export interface RouteTraceDataset {
  traceId: string;
  capability: Capability;
  intent: string;
  confidence: number;
  reason: string;
}

export interface ReplyTraceDataset {
  traceId: string;
  capability: Capability;
  inputText: string;
  responseText: string;
}

export interface RoutingPacket {
  user_message: string;
  conversation_summary: string;
  current_mode: string;
  last_tool_result: string;
  last_assistant_message: string;
  memories: string[];
}

export interface StateRoutingDecisionDebug {
  provider: "guard" | "dspy" | "llm";
  raw_next_node: string;
  final_next_node: string;
  validation_applied: boolean;
}

export interface StateRoutingDecision {
  next_node: ClinicGraphNode;
  intent: string;
  confidence: number;
  needs_retrieval: boolean;
  state_update: Record<string, unknown>;
  reason: string;
  debug?: StateRoutingDecisionDebug;
}

export interface AppointmentIntentPayload {
  patient_name?: string | null;
  reason?: string | null;
  preferred_date?: string | null;
  preferred_time?: string | null;
  missing_fields: string[];
  should_handoff: boolean;
  confidence: number;
}

export interface ReplyContextState {
  turn_count: number;
  summary: string;
  active_goal: string;
  stage: string;
  pending_action: string;
  pending_question: string;
  last_assistant_message: string;
  last_tool_result: string;
  appointment_slots: Record<string, unknown>;
  recent_turns: Array<Record<string, string>>;
}

export interface GeneratedReply {
  response_text: string;
  reply_mode: "llm" | "fallback";
}

export interface ClinicConfig {
  clinic_name: string;
  timezone: string;
  services: Array<Record<string, unknown>>;
  doctors: Array<Record<string, unknown>>;
  hours: Record<string, string>;
  policies: Record<string, string>;
}

export interface ClinicMemoryRecord {
  kind: "profile" | "episode";
  text: string;
  source: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface MemoryContext {
  recalled_memories: string[];
  raw_records: ClinicMemoryRecord[];
  turn_count: number;
}

export interface TurnMemoryInput {
  user_message: string;
  assistant_message: string;
  route: ClinicGraphNode;
}

export interface MemoryCommitResult {
  summary: string;
  stored_records: ClinicMemoryRecord[];
  turn_count: number;
}

export interface ClinicMemoryPersistenceDecision {
  shouldStore: boolean;
  shouldStoreProfile: boolean;
  shouldStoreEpisode: boolean;
  reasons: string[];
}

export interface GraphState {
  session_id: string;
  actor_id: string;
  contact_name: string;
  last_user_message: string;
  last_assistant_message: string;
  summary: string;
  active_goal: string;
  stage: string;
  pending_action: string;
  pending_question: string;
  appointment_slots: Record<string, unknown>;
  last_tool_result: string;
  recalled_memories: string[];
  next_node: ClinicGraphNode;
  intent: string;
  confidence: number;
  needs_retrieval: boolean;
  routing_reason: string;
  state_update: Record<string, unknown>;
  response_text: string;
  appointment_payload: Record<string, unknown>;
  handoff_required: boolean;
  turn_count: number;
  summary_refresh_requested: boolean;
  recent_turns: Array<Record<string, string>>;
}
