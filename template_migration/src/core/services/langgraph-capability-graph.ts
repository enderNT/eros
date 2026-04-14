import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { AppSettings } from "../../config";
import type {
  CapabilityResult,
  ExecutionContext,
  KnowledgeDocument,
  RouteDecision
} from "../../domain/contracts";
import type { DspyBridge, KnowledgeProvider, LlmProvider } from "../../domain/ports";

type LangGraphRoute = "conversation" | "rag";

const GraphState = Annotation.Root({
  context: Annotation<ExecutionContext>(),
  routeDecision: Annotation<RouteDecision>(),
  route: Annotation<LangGraphRoute>({
    reducer: (_left, right) => right,
    default: () => "conversation"
  }),
  knowledge: Annotation<KnowledgeDocument[]>({
    reducer: (_left, right) => right,
    default: () => []
  }),
  result: Annotation<CapabilityResult | null>({
    reducer: (_left, right) => right,
    default: () => null
  }),
  usedDspy: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false
  })
});

type LangGraphState = typeof GraphState.State;

interface LangGraphCapabilityGraphDeps {
  settings: AppSettings;
  llmProvider: LlmProvider;
  dspyBridge: DspyBridge;
  knowledgeProvider: KnowledgeProvider;
}

export class LangGraphCapabilityGraph {
  private readonly graph;

  constructor(private readonly deps: LangGraphCapabilityGraphDeps) {
    this.graph = new StateGraph(GraphState)
      .addNode("route_selector", async (state) => this.routeNode(state))
      .addNode("conversation", async (state) => this.conversationNode(state))
      .addNode("rag", async (state) => this.ragNode(state))
      .addEdge(START, "route_selector")
      .addConditionalEdges("route_selector", (state) => state.route, {
        conversation: "conversation",
        rag: "rag"
      })
      .addEdge("conversation", END)
      .addEdge("rag", END)
      .compile();
  }

  async invoke(context: ExecutionContext): Promise<{
    route: LangGraphRoute;
    result: CapabilityResult;
    knowledge: KnowledgeDocument[];
    usedDspy: boolean;
  }> {
    const finalState = await this.graph.invoke({
      context,
      routeDecision: context.routeDecision,
      route: "conversation",
      knowledge: context.knowledge,
      result: null,
      usedDspy: false
    });

    if (!finalState.result) {
      throw new Error("LangGraph capability graph finished without a result");
    }

    return {
      route: finalState.route,
      result: finalState.result,
      knowledge: finalState.knowledge,
      usedDspy: finalState.usedDspy
    };
  }

  private async routeNode(state: LangGraphState): Promise<Partial<LangGraphState>> {
    return {
      route: state.routeDecision.capability === "knowledge" ? "rag" : "conversation"
    };
  }

  private async conversationNode(state: LangGraphState): Promise<Partial<LangGraphState>> {
    const dspyResult = await this.dspyReply("conversation", state.context);
    if (dspyResult) {
      return { result: dspyResult, usedDspy: true };
    }

    return {
      result: await this.deps.llmProvider.generateReply("conversation", state.context),
      usedDspy: false
    };
  }

  private async ragNode(state: LangGraphState): Promise<Partial<LangGraphState>> {
    const knowledge =
      this.deps.settings.knowledge.enabled && state.routeDecision.needsKnowledge
        ? await this.deps.knowledgeProvider.retrieve(
            state.context.inbound.text,
            this.deps.settings.knowledge.topK
          )
        : state.knowledge;

    const knowledgeContext: ExecutionContext = {
      ...state.context,
      knowledge
    };

    const dspyResult = await this.dspyReply("knowledge", knowledgeContext);
    if (dspyResult) {
      return {
        knowledge,
        result: dspyResult,
        usedDspy: true
      };
    }

    return {
      knowledge,
      result: await this.deps.llmProvider.generateReply("knowledge", knowledgeContext),
      usedDspy: false
    };
  }

  private async dspyReply(
    capability: "conversation" | "knowledge",
    context: ExecutionContext
  ): Promise<CapabilityResult | null> {
    if (!this.deps.settings.dspy.enabled) {
      return null;
    }

    const enabledByCapability = {
      conversation: this.deps.settings.dspy.conversationReplyEnabled,
      knowledge: this.deps.settings.dspy.knowledgeReplyEnabled
    } as const;

    if (!enabledByCapability[capability]) {
      return null;
    }

    return this.deps.dspyBridge.predictReply?.(capability, context) ?? null;
  }
}
