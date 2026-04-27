import type { InboundMessage, TurnOutcome } from "../domain/contracts";
import type { ClinicStateStore, OutboundTransport, TraceSink } from "../domain/ports";
import { ExecutionLogger, OperationalLogger } from "./services/operational-logger";
import { ClinicWorkflow, ClinicWorkflowDiagnostics, type ClinicWorkflowObserver } from "./services/clinic-workflow";

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

function buildConsoleFlowSummary(
  nextNode: string,
  diagnostics: ClinicWorkflowDiagnostics
): string {
  const capability = mapCapability(nextNode);
  const parts: string[] = [];

  if (diagnostics.retrieval) {
    const retrieval = diagnostics.retrieval.fallbackUsed
      ? `${diagnostics.retrieval.status}->${diagnostics.retrieval.backend}`
      : `${diagnostics.retrieval.status}:${diagnostics.retrieval.backend}`;
    parts.push(retrieval);
  }

  if (diagnostics.reply) {
    parts.push(`${diagnostics.reply.provider}:${diagnostics.reply.replyMode}`);
  }

  return parts.length > 0 ? `${capability} [${parts.join(", ")}]` : capability;
}

const RECENT_TURN_LIMIT = 5;

function buildTurnPairsFromHistory(
  history: Array<{ role: "user" | "assistant"; text: string }>
): Array<Record<string, string>> {
  const recentTurns: Array<Record<string, string>> = [];
  let pendingUser = "";

  for (const entry of history) {
    if (entry.role === "user") {
      if (pendingUser) {
        recentTurns.push({ user: pendingUser, assistant: "" });
      }
      pendingUser = entry.text;
      continue;
    }

    if (!pendingUser) {
      continue;
    }

    recentTurns.push({
      user: pendingUser,
      assistant: entry.text
    });
    pendingUser = "";
  }

  if (pendingUser) {
    recentTurns.push({ user: pendingUser, assistant: "" });
  }

  return recentTurns;
}

function buildRecentTurnsFromHistory(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  limit: number
): Array<Record<string, string>> {
  return buildTurnPairsFromHistory(history).slice(-limit);
}

function buildSummaryFromHistory(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  limit: number
): string {
  const archivedTurns = buildTurnPairsFromHistory(history).slice(0, -limit);
  if (archivedTurns.length === 0) {
    return "";
  }

  const summary = archivedTurns
    .map((turn) => `Usuario: ${turn.user}${turn.assistant ? ` Asistente: ${turn.assistant}` : ""}`)
    .join(" | ");
  return summary;
}

function buildInitialGraphState(
  inbound: InboundMessage,
  recentTurnLimit: number
) {
  const history = inbound.deliveryContext?.history ?? [];
  const lastAssistantMessage = [...history].reverse().find((entry) => entry.role === "assistant")?.text ?? "";

  return {
    session_id: inbound.sessionId,
    actor_id: inbound.actorId,
    contact_name: inbound.contactName ?? "Paciente",
    last_user_message: "",
    last_assistant_message: lastAssistantMessage,
    summary: buildSummaryFromHistory(history, recentTurnLimit),
    active_goal: "",
    stage: "",
    pending_action: "",
    pending_question: "",
    appointment_slots: {},
    last_tool_result: "",
    recalled_memories: [],
    next_node: "conversation" as const,
    intent: "conversation",
    confidence: 0,
    needs_retrieval: false,
    routing_reason: "",
    state_update: {},
    response_text: "",
    appointment_payload: {},
    handoff_required: false,
    turn_count: history.filter((entry) => entry.role === "user").length,
    summary_refresh_requested: false,
    recent_turns: buildRecentTurnsFromHistory(history, recentTurnLimit)
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
    const workflowObserver: ClinicWorkflowObserver = {
      onRoute: async (event) => {
        await executionLogger.route({
          resolver: event.resolver,
          input: event.input,
          decision: event.decision,
          debug: event.debug
        });
      }
    };
    let finalDeliveryAttempted = false;
    try {
      const previous = await this.stateStore.load(inbound.sessionId);
      await this.logStateLoad(executionLogger, inbound, previous);
      const initialState = {
        ...(previous ?? buildInitialGraphState(inbound, RECENT_TURN_LIMIT)),
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
      const workflowResult = await this.workflow.run(initialState, traceId, workflowObserver);
      const result = workflowResult.state;
      await this.stateStore.save(inbound.sessionId, result);
      await this.logStateSave(executionLogger, inbound, result);
      await this.traceSink.append(traceId, "workflow_result", result);
      await this.logWorkflowDiagnostics(executionLogger, inbound, result, workflowResult.diagnostics);
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
        usedDspy: workflowResult.diagnostics.reply?.provider === "dspy_service",
        knowledgeCount: workflowResult.diagnostics.retrieval?.resultCount ?? 0,
        consoleSummary: buildConsoleFlowSummary(result.next_node, workflowResult.diagnostics)
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
        finalDeliveryAttempted = true;
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

      if (inbound.deliveryContext?.provider === "webhook_async" && typeof this.outboundTransport.emitFailure === "function") {
        finalDeliveryAttempted = true;
        const outboundResult = await this.outboundTransport.emitFailure(
          new Error("Turn completed without response_text"),
          inbound
        );
        await this.traceSink.append(traceId, "outbound.emit.result", {
          destination: outboundResult?.destination ?? inbound.channel,
          status: outboundResult?.status ?? "failed",
          response: outboundResult?.response ?? {}
        });
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
      if (
        !finalDeliveryAttempted &&
        inbound.deliveryContext?.provider === "webhook_async" &&
        typeof this.outboundTransport.emitFailure === "function"
      ) {
        try {
          finalDeliveryAttempted = true;
          const outboundResult = await this.outboundTransport.emitFailure(error, inbound);
          await this.traceSink.append(traceId, "outbound.emit.result", {
            destination: outboundResult?.destination ?? inbound.channel,
            status: outboundResult?.status ?? "failed",
            response: outboundResult?.response ?? {}
          });
        } catch (callbackError) {
          await this.logger.logSystemError("webhook_async_failure_callback", "clinic_orchestrator", callbackError, {
            session_id: inbound.sessionId,
            correlation_id: inbound.correlationId ?? inbound.sessionId,
            trace_id: traceId
          });
        }
      }
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
    state: Awaited<ReturnType<ClinicWorkflow["run"]>>["state"]
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

  private async logWorkflowDiagnostics(
    executionLogger: ExecutionLogger,
    inbound: InboundMessage,
    state: Awaited<ReturnType<ClinicWorkflow["run"]>>["state"],
    diagnostics: ClinicWorkflowDiagnostics
  ): Promise<void> {
    if (diagnostics.shortTermMemory) {
      await executionLogger.memoryWrite("clinic_state_window", {
        scope: "short_term",
        component: "clinic_state_store",
        request: {
          session_id: inbound.sessionId,
          policy: "summary_plus_recent_window",
          max_recent_turns: state.recent_turns.length
        },
        response: diagnostics.shortTermMemory,
        status: "ok",
        summary: `clinic_state window_overflow summarized=${diagnostics.shortTermMemory.summarizedTurns} retained=${diagnostics.shortTermMemory.retainedTurns}`
      });
    }

    if (diagnostics.retrieval) {
      await executionLogger.tool("knowledge_provider", {
        component: diagnostics.retrieval.backend === "clinic_config"
          ? "clinic_config_fallback"
          : diagnostics.retrieval.backend === "simulate"
            ? "qdrant_simulation"
            : "qdrant",
        request: {
          query: inbound.text,
          contact_id: inbound.actorId
        },
        response: {
          backend: diagnostics.retrieval.backend,
          status: diagnostics.retrieval.status,
          result_count: diagnostics.retrieval.resultCount,
          fallback_used: diagnostics.retrieval.fallbackUsed
        },
        status: diagnostics.retrieval.status
      });
    }

    if (diagnostics.appointmentExtraction) {
      await executionLogger.tool("appointment_extraction", {
        component: diagnostics.appointmentExtraction.provider,
        request: {
          user_message: inbound.text,
          contact_name: state.contact_name
        },
        response: {
          clinic_context_present: diagnostics.appointmentExtraction.clinicContextPresent
        },
        status: "ok"
      });
    }

    if (diagnostics.reply) {
      await executionLogger.tool(`${diagnostics.reply.node}_reply`, {
        component: diagnostics.reply.provider,
        request: {
          node: diagnostics.reply.node,
          intent: state.intent
        },
        response: {
          reply_mode: diagnostics.reply.replyMode
        },
        status: diagnostics.reply.replyMode === "fallback" ? "fallback" : "ok"
      });
    }
  }
}
