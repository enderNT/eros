import type { InboundMessage, TurnOutcome } from "../domain/contracts";
import type { ClinicStateStore, OutboundTransport, TraceSink } from "../domain/ports";
import { ClinicWorkflow } from "./services/clinic-workflow";

function mapCapability(nextNode: string): "conversation" | "knowledge" | "action" {
  if (nextNode === "rag") return "knowledge";
  if (nextNode === "appointment") return "action";
  return "conversation";
}

export class ClinicOrchestrator {
  constructor(
    private readonly stateStore: ClinicStateStore,
    private readonly workflow: ClinicWorkflow,
    private readonly outboundTransport: OutboundTransport,
    private readonly traceSink: TraceSink
  ) {}

  async processTurn(inbound: InboundMessage) {
    const traceId = await this.traceSink.startTurn(inbound);
    const previous = await this.stateStore.load(inbound.sessionId);
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
    const result = await this.workflow.run(initialState);
    await this.stateStore.save(inbound.sessionId, result);
    await this.traceSink.append(traceId, "workflow_result", result);

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
      await this.outboundTransport.emit(outcome, inbound);
      await this.traceSink.endTurn(traceId, outcome);
    }

    return result;
  }
}
