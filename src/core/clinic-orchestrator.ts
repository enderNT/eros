import type { InboundMessage, TurnOutcome } from "../domain/contracts";
import type { ClinicStateStore, OutboundTransport, TraceSink } from "../domain/ports";
import { ExecutionLogger, OperationalLogger } from "./services/operational-logger";
import { ClinicWorkflow } from "./services/clinic-workflow";

function mapCapability(nextNode: string): "conversation" | "knowledge" | "action" {
  if (nextNode === "rag") return "knowledge";
  if (nextNode === "appointment") return "action";
  return "conversation";
}

function summarizeGraphState(state: {
  summary: string;
  turn_count: number;
  next_node: string;
  intent: string;
  stage: string;
  active_goal: string;
}) {
  return {
    summary: state.summary,
    turnCount: state.turn_count,
    nextNode: state.next_node,
    intent: state.intent,
    stage: state.stage,
    activeGoal: state.active_goal
  };
}

function buildRouteInput(state: {
  last_user_message: string;
  summary: string;
  active_goal: string;
  stage: string;
  pending_action: string;
  pending_question: string;
  appointment_slots: Record<string, unknown>;
  last_tool_result: string;
  last_assistant_message: string;
  recalled_memories: string[];
}) {
  return {
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
  };
}

function buildRouteDecision(state: {
  next_node: string;
  intent: string;
  confidence: number;
  needs_retrieval: boolean;
  state_update: Record<string, unknown>;
  routing_reason: string;
}) {
  return {
    capability: mapCapability(state.next_node),
    intent: state.intent,
    confidence: state.confidence,
    needsKnowledge: state.needs_retrieval,
    statePatch: state.state_update,
    reason: state.routing_reason
  };
}

export class ClinicOrchestrator {
  constructor(
    private readonly stateStore: ClinicStateStore,
    private readonly workflow: ClinicWorkflow,
    private readonly outboundTransport: OutboundTransport,
    private readonly traceSink: TraceSink,
    private readonly logger: OperationalLogger
  ) {}

  async processTurn(inbound: InboundMessage) {
    const traceId = await this.traceSink.startTurn(inbound);
    const executionLogger = await this.logger.startRun(inbound);
    try {
      const previous = await this.stateStore.load(inbound.sessionId);
      await this.logStateLoad(executionLogger, inbound, previous);
      const initialState = {
        ...(previous ?? {
          session_id: inbound.sessionId,
          actor_id: inbound.actorId,
          contact_name: inbound.contactName ?? "Paciente",
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
        }),
        session_id: inbound.sessionId,
        actor_id: inbound.actorId,
        contact_name: inbound.contactName ?? previous?.contact_name ?? "Paciente",
        last_user_message: inbound.text,
        response_text: ""
      };

      await this.traceSink.append(traceId, "ingest", initialState);
      await executionLogger.context({
        shortTermState: summarizeGraphState(initialState),
        memory: {
          provider: "clinic_short_term_state",
          enabled: true,
          topK: 0,
          scoreThreshold: 0,
          rawRecallCount: initialState.recalled_memories.length,
          promptDigest: initialState.summary
        }
      });
      const result = await this.workflow.run(initialState, traceId);
      await this.stateStore.save(inbound.sessionId, result);
      await this.logStateSave(executionLogger, inbound, result);
      await this.traceSink.append(traceId, "workflow_result", result);
      await executionLogger.route({
        resolver: "clinic_routing_service",
        input: buildRouteInput(initialState),
        decision: buildRouteDecision(result)
      });
      await executionLogger.flow({
        selectedFlow: result.intent,
        capability: mapCapability(result.next_node),
        result: {
          responseText: result.response_text,
          handoffRequired: result.handoff_required,
          routingReason: result.routing_reason,
          nextNode: result.next_node,
          appointmentPayload: result.appointment_payload
        },
        usedDspy: false,
        knowledgeCount: result.next_node === "rag" && result.last_tool_result ? 1 : 0
      });

      if (result.response_text) {
        const outcome: TurnOutcome = {
          capability: mapCapability(result.next_node),
          intent: result.intent,
          confidence: result.confidence,
          responseText: result.response_text,
          handoffRequired: result.handoff_required,
          stateSnapshot: {
            summary: result.summary,
            recentTurns: [],
            activeGoal: result.active_goal,
            stage: result.stage,
            pendingAction: result.pending_action,
            pendingQuestion: result.pending_question,
            appointmentSlots: result.appointment_slots,
            lastToolResult: result.last_tool_result,
            lastAssistantMessage: result.last_assistant_message,
            lastUserMessage: result.last_user_message,
            continuitySignals: [],
            turnCount: result.turn_count
          },
          artifacts: {
            routing_reason: result.routing_reason,
            next_node: result.next_node,
            appointment_payload: result.appointment_payload
          }
        };
        const outboundResult = await this.outboundTransport.emit(outcome, inbound);
        await this.traceSink.append(traceId, "outbound.emit.result", {
          destination: outboundResult?.destination ?? inbound.channel,
          status: outboundResult?.status ?? "sent",
          response: outboundResult?.response ?? {}
        });
        await executionLogger.output({
          destination: outboundResult?.destination ?? inbound.channel,
          request: {
            channel: inbound.channel,
            provider: inbound.deliveryContext?.provider ?? inbound.channel,
            replyEnabled: true
          },
          response: outboundResult?.response ?? {
            status: outboundResult?.status ?? "sent"
          },
          finalOutput: outcome.responseText
        });
        await this.traceSink.endTurn(traceId, outcome);
        await executionLogger.end({
          status: "ok",
          summary: `${outcome.capability}:${outcome.intent}`,
          result: outcome.handoffRequired ? "handoff_required" : "completed"
        });
        void this.flushTrace(traceId, inbound);
        return result;
      }

      await executionLogger.end({
        status: "ok",
        summary: `${mapCapability(result.next_node)}:${result.intent}`,
        result: "no_response_text"
      });
      return result;
    } catch (error) {
      await this.traceSink.failTurn(traceId, error);
      await executionLogger.fail(error);
      void this.flushTrace(traceId, inbound);
      throw error;
    }
  }

  private async flushTrace(traceId: string, inbound: InboundMessage): Promise<void> {
    try {
      await this.traceSink.flush(traceId);
    } catch (error) {
      await this.logger.logSystemError("trace_flush", "clinic_orchestrator", error, {
        session_id: inbound.sessionId,
        correlation_id: inbound.correlationId ?? inbound.sessionId,
        trace_id: traceId
      });
    }
  }

  private async logStateLoad(
    executionLogger: ExecutionLogger,
    inbound: InboundMessage,
    previous: Awaited<ReturnType<ClinicStateStore["load"]>>
  ): Promise<void> {
    await executionLogger.memoryRead("clinic_state", {
      scope: "short_term",
      component: "clinic_state_store",
      request: {
        session_id: inbound.sessionId
      },
      response: {
        found: Boolean(previous),
        state: previous ? summarizeGraphState(previous) : null
      },
      status: "ok",
      summary: previous
        ? `loaded clinic_state turns=${previous.turn_count}`
        : "clinic_state empty"
    });
  }

  private async logStateSave(
    executionLogger: ExecutionLogger,
    inbound: InboundMessage,
    state: Awaited<ReturnType<ClinicWorkflow["run"]>>
  ): Promise<void> {
    await executionLogger.memoryWrite("clinic_state", {
      scope: "short_term",
      component: "clinic_state_store",
      request: {
        session_id: inbound.sessionId
      },
      response: summarizeGraphState(state),
      status: "ok",
      summary: `saved clinic_state turns=${state.turn_count}`
    });
  }
}
