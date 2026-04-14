import type { AppSettings } from "../config";
import type {
  CapabilityResult,
  ExecutionContext,
  InboundMessage,
  RouteDecision,
  ShortTermState,
  TurnOutcome
} from "../domain/contracts";
import type {
  DspyBridge,
  KnowledgeProvider,
  LlmProvider,
  MemoryProvider,
  OutboundTransport,
  StateStore,
  TraceSink
} from "../domain/ports";
import { buildPromptMemorySelection } from "./services/memory-selection";
import { LangGraphCapabilityGraph } from "./services/langgraph-capability-graph";
import { ExecutionLogger, OperationalLogger } from "./services/operational-logger";
import { appendTurn, mergeState } from "./utils/state";

const NO_VALUE = "n/a";

interface OrchestratorDependencies {
  settings: AppSettings;
  stateStore: StateStore;
  memoryProvider: MemoryProvider;
  knowledgeProvider: KnowledgeProvider;
  llmProvider: LlmProvider;
  dspyBridge: DspyBridge;
  traceSink: TraceSink;
  outboundTransport: OutboundTransport;
  logger: OperationalLogger;
  langGraph: LangGraphCapabilityGraph;
}

export class TurnOrchestrator {
  constructor(private readonly deps: OrchestratorDependencies) {}

  async processTurn(inbound: InboundMessage): Promise<TurnOutcome> {
    const traceId = await this.deps.traceSink.startTurn(inbound);
    const executionLogger = await this.deps.logger.startRun(inbound);

    try {
      await this.deps.traceSink.append(traceId, "ingest", inbound);

      let state = await this.loadShortTermState(inbound, executionLogger);
      state = appendTurn(
        state,
        { role: "user", text: inbound.text, timestamp: inbound.receivedAt },
        this.deps.settings.prompt.recentTurnsLimit
      );

      const recalledMemories = await this.loadLongTermMemories(inbound, executionLogger);
      const memorySelection = await buildPromptMemorySelection(
        inbound.text,
        recalledMemories,
        this.deps.llmProvider,
        this.deps.settings.prompt
      );
      await this.deps.traceSink.append(traceId, "load_context", {
        shortTermState: state,
        rawRecall: memorySelection.rawRecall,
        promptDigest: memorySelection.promptDigest
      });
      await executionLogger.context({
        shortTermState: {
          summary: state.summary,
          turnCount: state.turnCount,
          lastCapability: state.lastCapability ?? null,
          lastIntent: state.lastIntent ?? null,
          continuitySignals: state.continuitySignals
        },
        memory: {
          provider: this.deps.settings.memory.provider,
          enabled: this.deps.settings.memory.enabled,
          topK: this.deps.settings.memory.topK,
          scoreThreshold: this.deps.settings.memory.scoreThreshold,
          rawRecallCount: memorySelection.rawRecall.length,
          promptDigest: memorySelection.promptDigest
        }
      });

      const routeDecision = await this.decideRoute(inbound, state, memorySelection.promptDigest, traceId, executionLogger);

      const context: ExecutionContext = {
        inbound,
        shortTermState: state,
        memorySelection,
        knowledge: [],
        routeDecision,
        traceId
      };

      const { result, usedDspy, knowledge, graphRoute } = await this.executeCapability(context, executionLogger);
      await this.deps.traceSink.append(traceId, "execute_capability", {
        capability: routeDecision.capability,
        result,
        usedDspy
      });
      await executionLogger.flow({
        selectedFlow: routeDecision.intent,
        capability: routeDecision.capability,
        result: {
          responseText: result.responseText,
          handoffRequired: result.handoffRequired,
          artifacts: {
            ...result.artifacts,
            graphRoute: graphRoute ?? null
          }
        },
        usedDspy,
        knowledgeCount: knowledge.length
      });

      const updatedState = await this.finalizeState(state, routeDecision, result, inbound.text);
      const outcome: TurnOutcome = {
        capability: routeDecision.capability,
        intent: routeDecision.intent,
        confidence: routeDecision.confidence,
        responseText: result.responseText,
        handoffRequired: result.handoffRequired,
        stateSnapshot: updatedState,
        artifacts: {
          ...result.artifacts,
          knowledgeCount: knowledge.length,
          usedDspy
        }
      };

      await this.persist(inbound, updatedState, result, executionLogger);
      await this.deps.traceSink.projectReply(traceId, outcome, inbound);
      await this.deps.traceSink.endTurn(traceId, outcome);
      const outbound = await this.deps.outboundTransport.emit(outcome, inbound);
      await executionLogger.output({
        destination: outbound?.destination ?? inbound.channel,
        request: {
          channel: inbound.channel,
          provider: this.deps.settings.channel.provider,
          replyEnabled: this.deps.settings.channel.replyEnabled
        },
        response: outbound?.response ?? {
          status: outbound?.status ?? "ok"
        },
        finalOutput: outcome.responseText
      });
      await executionLogger.end({
        status: "ok",
        summary: `${routeDecision.capability}:${routeDecision.intent}`,
        result: outcome.handoffRequired ? "handoff_required" : "completed"
      });

      return outcome;
    } catch (error) {
      await this.deps.traceSink.failTurn(traceId, error);
      await executionLogger.fail(error);
      throw error;
    }
  }

  private async decideRoute(
    inbound: InboundMessage,
    state: ShortTermState,
    promptDigest: string,
    traceId: string,
    executionLogger: ExecutionLogger
  ): Promise<RouteDecision> {
    let decision: RouteDecision | null = null;
    let fallback: string | undefined;

    const routeInput = {
      inbound: {
        text: inbound.text,
        channel: inbound.channel,
        sessionId: inbound.sessionId
      },
      state: {
        turnCount: state.turnCount,
        summary: state.summary,
        lastCapability: state.lastCapability ?? null,
        lastIntent: state.lastIntent ?? null
      },
      promptDigest
    };

    if (this.deps.settings.dspy.enabled) {
      const startedAt = Date.now();
      const dspyDecision = await this.deps.dspyBridge.predictRouteDecision?.({ inbound, state, promptDigest });
      await executionLogger.tool("dspy_route_decision", {
        component: "dspy_bridge",
        request: routeInput,
        response: dspyDecision ?? { status: "no_prediction" },
        status: dspyDecision ? "ok" : "fallback",
        latency_ms: Date.now() - startedAt
      });
      decision = dspyDecision ?? null;
      if (!decision) {
        fallback = "generic_llm_provider";
      }
    }

    if (!decision) {
      const startedAt = Date.now();
      decision = await this.deps.llmProvider.decideRoute({ inbound, state, promptDigest });
      await executionLogger.model("route_decision", {
        logical_task: "route_decision",
        provider: "generic_llm_provider",
        request: routeInput,
        response_raw: decision,
        parsed_result: decision,
        mode_used: "heuristic",
        fallback_applied: fallback ?? NO_VALUE,
        latency_ms: Date.now() - startedAt
      });
    }

    await this.deps.traceSink.projectRouteDecision(traceId, decision);
    await this.deps.traceSink.append(traceId, "route", decision);
    await executionLogger.route({
      resolver: decision ? (fallback ? "generic_llm_provider" : this.deps.settings.dspy.enabled ? "dspy_bridge" : "generic_llm_provider") : "unknown",
      input: routeInput,
      decision,
      fallback
    });
    return decision;
  }

  private async executeCapability(
    context: ExecutionContext,
    executionLogger: ExecutionLogger
  ): Promise<{ result: CapabilityResult; usedDspy: boolean; knowledge: typeof context.knowledge; graphRoute?: string }> {
    const capability = context.routeDecision.capability;

    if (capability === "conversation" || capability === "knowledge") {
      const startedAt = Date.now();
      const graphResult = await this.deps.langGraph.invoke(context);
      await executionLogger.tool("langgraph", {
        component: "@langchain/langgraph",
        request: {
          capability,
          intent: context.routeDecision.intent,
          needsKnowledge: context.routeDecision.needsKnowledge
        },
        response: {
          route: graphResult.route,
          usedDspy: graphResult.usedDspy,
          knowledgeCount: graphResult.knowledge.length
        },
        status: "ok",
        latency_ms: Date.now() - startedAt
      });

      if (graphResult.route === "rag" && this.deps.settings.knowledge.enabled) {
        await executionLogger.tool("knowledge_provider", {
          component: this.deps.settings.knowledge.provider,
          request: {
            query: context.inbound.text,
            topK: this.deps.settings.knowledge.topK
          },
          response: {
            count: graphResult.knowledge.length,
            documents: graphResult.knowledge.map((document) => ({
              id: document.id,
              score: document.score,
              content: document.content
            }))
          },
          status: "ok"
        });
      }

      return {
        result: graphResult.result,
        usedDspy: graphResult.usedDspy,
        knowledge: graphResult.knowledge,
        graphRoute: graphResult.route
      };
    }

    const dspyEnabled = this.deps.settings.dspy.enabled;

    const capabilityRequest = {
      task: capability,
      input: context.inbound.text,
      stateSummary: context.shortTermState.summary,
      promptDigest: context.memorySelection.promptDigest,
      knowledgeCount: context.knowledge.length
    };

    if (dspyEnabled) {
      const startedAt = Date.now();
      const dspyResult = await this.deps.dspyBridge.predictReply?.(capability, context);
      await executionLogger.tool(`dspy_${capability}`, {
        component: "dspy_bridge",
        request: capabilityRequest,
        response: dspyResult ?? { status: "no_prediction" },
        status: dspyResult ? "ok" : "fallback",
        latency_ms: Date.now() - startedAt
      });
      if (dspyResult) {
        return { result: dspyResult, usedDspy: true, knowledge: context.knowledge };
      }
    }

    const startedAt = Date.now();
    const llmResult = await this.deps.llmProvider.generateReply(capability, context);
    await executionLogger.model(capability, {
      logical_task: `${capability}_reply`,
      provider: "generic_llm_provider",
      request: capabilityRequest,
      response_raw: llmResult.responseText,
      parsed_result: {
        responseText: llmResult.responseText,
        handoffRequired: llmResult.handoffRequired,
        artifacts: llmResult.artifacts,
        memoryHints: llmResult.memoryHints
      },
      mode_used: "template_generation",
      fallback_applied: dspyEnabled ? "dspy_to_generic_llm" : NO_VALUE,
      latency_ms: Date.now() - startedAt
    });

    return { result: llmResult, usedDspy: false, knowledge: context.knowledge };
  }

  private async loadShortTermState(
    inbound: InboundMessage,
    executionLogger: ExecutionLogger
  ): Promise<ShortTermState> {
    const state = await this.deps.stateStore.load(inbound.sessionId);
    await executionLogger.memoryRead("short_term_state", {
      scope: "short_term",
      component: "state_store",
      request: {
        sessionId: inbound.sessionId
      },
      response: {
        turnCount: state.turnCount,
        summary: state.summary,
        lastCapability: state.lastCapability ?? null,
        lastIntent: state.lastIntent ?? null
      },
      status: "ok",
      summary: `short_term read state_store turns=${state.turnCount} summary="${truncateSummary(state.summary)}"`
    });
    return state;
  }

  private async loadLongTermMemories(
    inbound: InboundMessage,
    executionLogger: ExecutionLogger
  ) {
    if (!this.deps.settings.memory.enabled) {
      await executionLogger.memoryRead("long_term_memory", {
        scope: "long_term",
        component: this.deps.settings.memory.provider,
        request: {
          enabled: false
        },
        response: {
          count: 0,
          digest: ""
        },
        status: "skipped",
        summary: `long_term read ${this.deps.settings.memory.provider} count=0 digest=""`
      });
      return [];
    }

    try {
      const recalledMemories = await this.deps.memoryProvider.search(
        inbound.text,
        inbound.actorId,
        this.deps.settings.memory.agentId,
        this.deps.settings.memory.topK,
        this.deps.settings.memory.scoreThreshold
      );
      await executionLogger.memoryRead("long_term_memory", {
        scope: "long_term",
        component: this.deps.settings.memory.provider,
        request: {
          query: inbound.text,
          actorId: inbound.actorId,
          agentId: this.deps.settings.memory.agentId,
          topK: this.deps.settings.memory.topK,
          threshold: this.deps.settings.memory.scoreThreshold
        },
        response: {
          count: recalledMemories.length,
          memories: recalledMemories
        },
        status: "ok",
        summary: `long_term read ${this.deps.settings.memory.provider} count=${recalledMemories.length} digest="${truncateSummary(recalledMemories.map((memory) => memory.memory).join(" | "))}"`
      });
      return recalledMemories;
    } catch (error) {
      await executionLogger.memoryRead("long_term_memory", {
        scope: "long_term",
        component: this.deps.settings.memory.provider,
        request: {
          query: inbound.text,
          actorId: inbound.actorId,
          agentId: this.deps.settings.memory.agentId,
          topK: this.deps.settings.memory.topK,
          threshold: this.deps.settings.memory.scoreThreshold
        },
        response: {
          count: 0,
          memories: []
        },
        status: "error",
        error,
        summary: `long_term read ${this.deps.settings.memory.provider} count=0 digest=""`
      });
      return [];
    }
  }

  private async finalizeState(
    state: ShortTermState,
    routeDecision: RouteDecision,
    result: CapabilityResult,
    userText: string
  ): Promise<ShortTermState> {
    const withDecision = mergeState(state, routeDecision.statePatch);
    const withResult = mergeState(withDecision, result.statePatch);
    const withAssistantTurn = appendTurn(
      withResult,
      { role: "assistant", text: result.responseText, timestamp: new Date().toISOString() },
      this.deps.settings.prompt.recentTurnsLimit
    );

    const shouldRefreshSummary =
      withAssistantTurn.turnCount % this.deps.settings.state.refreshTurnThreshold === 0 ||
      withAssistantTurn.summary.length >= this.deps.settings.state.refreshCharThreshold ||
      withAssistantTurn.summary.length === 0;

    if (!shouldRefreshSummary) {
      return withAssistantTurn;
    }

    return {
      ...withAssistantTurn,
      summary: await this.deps.llmProvider.summarizeState({
        state: withAssistantTurn,
        recentUserText: userText
      })
    };
  }

  private async persist(
    inbound: InboundMessage,
    state: ShortTermState,
    result: CapabilityResult,
    executionLogger: ExecutionLogger
  ): Promise<void> {
    await this.deps.stateStore.save(inbound.sessionId, state);
    await executionLogger.memoryWrite("short_term_state", {
      scope: "short_term",
      component: "state_store",
      request: {
        sessionId: inbound.sessionId
      },
      response: {
        turnCount: state.turnCount,
        stage: state.stage ?? null,
        summary: state.summary
      },
      status: "ok",
      summary: `short_term write state_store turns=${state.turnCount} stage=${state.stage ?? NO_VALUE}`
    });

    if (!this.deps.settings.memory.enabled) {
      await executionLogger.memoryWrite("long_term_memory", {
        scope: "long_term",
        component: this.deps.settings.memory.provider,
        request: {
          enabled: false
        },
        response: {
          stored: false,
          count: 0
        },
        status: "skipped",
        summary: `long_term write ${this.deps.settings.memory.provider} stored=false count=0`
      });
      return;
    }

    const messages = [
      { role: "user" as const, text: inbound.text, timestamp: inbound.receivedAt },
      { role: "assistant" as const, text: result.responseText, timestamp: new Date().toISOString() }
    ];
    const metadata = {
      channel: inbound.channel,
      capability: state.lastCapability,
      lastIntent: state.lastIntent
    };

    try {
      const memoryWriteResult = await this.deps.memoryProvider.addTurn(
        messages,
        inbound.actorId,
        this.deps.settings.memory.agentId,
        inbound.sessionId,
        metadata
      );
      await executionLogger.memoryWrite("long_term_memory", {
        scope: "long_term",
        component: this.deps.settings.memory.provider,
        request: {
          actorId: inbound.actorId,
          agentId: this.deps.settings.memory.agentId,
          sessionId: inbound.sessionId,
          metadata
        },
        response: memoryWriteResult as unknown as Record<string, unknown>,
        status: memoryWriteResult.stored ? "ok" : "noop",
        summary: `long_term write ${this.deps.settings.memory.provider} stored=${memoryWriteResult.stored} count=${memoryWriteResult.count}`
      });
    } catch (error) {
      await executionLogger.memoryWrite("long_term_memory", {
        scope: "long_term",
        component: this.deps.settings.memory.provider,
        request: {
          actorId: inbound.actorId,
          agentId: this.deps.settings.memory.agentId,
          sessionId: inbound.sessionId,
          metadata
        },
        response: {
          stored: false,
          count: 0
        },
        status: "error",
        error,
        summary: `long_term write ${this.deps.settings.memory.provider} stored=false count=0`
      });
    }
  }
}

function truncateSummary(value: string): string {
  if (!value) {
    return "";
  }
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`;
}
