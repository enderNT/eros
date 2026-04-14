import { Elysia } from "elysia";
import { loadSettings } from "./config";
import {
  assessChatwootWebhook,
  normalizeChatwootInboundMessage,
  normalizeInboundMessage
} from "./adapters/http/inbound";
import { createOutboundTransport, createTraceSink } from "./core/factories/runtime";
import { ClinicOrchestrator } from "./core/clinic-orchestrator";
import { ClinicDspyHttpBridge } from "./core/services/clinic-dspy-bridge";
import { ClinicConfigLoader } from "./core/services/clinic-config-loader";
import { ClinicLlmService } from "./core/services/clinic-llm-service";
import { ClinicRoutingService } from "./core/services/clinic-routing-service";
import { ClinicWorkflow } from "./core/services/clinic-workflow";
import { InMemoryClinicStateStore } from "./core/services/in-memory-clinic-state-store";
import { InMemoryConversationMemoryRuntime } from "./core/services/in-memory-conversation-memory-runtime";
import { QdrantRetrievalService } from "./core/services/qdrant-retrieval-service";
import { OperationalLogger } from "./core/services/operational-logger";

export function buildApp() {
  const settings = loadSettings();
  const traceSink = createTraceSink(settings);
  const logger = new OperationalLogger(settings);
  const llmService = new ClinicLlmService(settings);
  const dspyBridge = new ClinicDspyHttpBridge(settings.dspy);
  const clinicConfigProvider = new ClinicConfigLoader(settings.clinic.configPath);
  const memoryRuntime = new InMemoryConversationMemoryRuntime(llmService, traceSink);
  const routingService = new ClinicRoutingService(settings, llmService, dspyBridge, traceSink);
  const workflow = new ClinicWorkflow(
    routingService,
    llmService,
    memoryRuntime,
    clinicConfigProvider,
    new QdrantRetrievalService(settings),
    dspyBridge,
    settings,
    traceSink
  );
  const outboundTransport = createOutboundTransport(settings);
  const orchestrator = new ClinicOrchestrator(new InMemoryClinicStateStore(), workflow, outboundTransport, traceSink, logger);
  let shuttingDown = false;

  const handleWebhook = async (body: unknown, set: { status?: number | string }) => {
    try {
      const payload = body as Record<string, unknown>;
      const assessment = assessChatwootWebhook(payload);
      if (!assessment.shouldProcess) {
        set.status = 202;
        return {
          accepted: true,
          mode: "ignored",
          reason: assessment.reason ?? "ignored_event"
        };
      }

      const inbound = assessment.isChatwoot
        ? normalizeChatwootInboundMessage(payload)
        : normalizeInboundMessage(payload);
      void orchestrator.processTurn(inbound).catch((error) => {
        void logger.logSystemError("async_turn", "http.webhook", error, {
          session_id: inbound.sessionId,
          correlation_id: inbound.correlationId ?? inbound.sessionId
        });
      });
      set.status = 202;
      return {
        accepted: true,
        mode: "async",
        sessionId: inbound.sessionId
      };
    } catch (error) {
      await logger.logSystemError("normalize_inbound", "http.webhook", error);
      set.status = 400;
      return {
        accepted: false,
        error: error instanceof Error ? error.message : "unknown_error"
      };
    }
  };

  const buildDependencyHealth = async () => {
    const trace = await traceSink.health();
    const dspy = settings.dspy.enabled
      ? await dspyBridge.health()
      : true;

    return {
      ok: !shuttingDown,
      shuttingDown,
      dependencies: {
        trace,
        dspy: {
          ok: dspy,
          details: {
            enabled: settings.dspy.enabled,
            service_url: settings.dspy.serviceUrl
          }
        }
      },
      timestamp: new Date().toISOString()
    };
  };

  const buildReadyHealth = async () => {
    const deps = await buildDependencyHealth();
    const degraded: string[] = [];
    if (settings.dspy.enabled && !deps.dependencies.dspy.ok) {
      degraded.push("dspy");
    }
    if (settings.trace.backend === "postgres" && !deps.dependencies.trace.ok) {
      degraded.push("trace");
    }

    return {
      ok: !shuttingDown,
      ready: !shuttingDown,
      degraded,
      service: settings.app.name,
      traceBackend: settings.trace.backend,
      timestamp: deps.timestamp
    };
  };

  const app = new Elysia()
    .get("/health/live", () => ({
      ok: true,
      live: true,
      service: settings.app.name,
      timestamp: new Date().toISOString()
    }))
    .get("/health/ready", async ({ set }) => {
      const health = await buildReadyHealth();
      if (!health.ok) {
        set.status = 503;
      }
      return health;
    })
    .get("/health/deps", async ({ set }) => {
      const health = await buildDependencyHealth();
      if (shuttingDown) {
        set.status = 503;
      }
      return health;
    })
    .get("/health", async ({ set }) => {
      const health = await buildReadyHealth();
      if (!health.ok) {
        set.status = 503;
      }
      return health;
    })
    .post("/webhooks/messages", async ({ body, set }) => handleWebhook(body, set))
    .post("/webhooks/chatwoot", async ({ body, set }) => handleWebhook(body, set))
    .post("/turns/execute", async ({ body, set }) => {
      try {
        const inbound = normalizeInboundMessage(body as Record<string, unknown>);
        const outcome = await orchestrator.processTurn(inbound);
        return {
          accepted: true,
          mode: "sync",
          outcome
        };
      } catch (error) {
        await logger.logSystemError("sync_turn", "http.turns.execute", error);
        set.status = 400;
        return {
          accepted: false,
          error: error instanceof Error ? error.message : "unknown_error"
        };
      }
    })
    .get("/debug/traces", () =>
      "getSnapshot" in traceSink && typeof traceSink.getSnapshot === "function"
        ? traceSink.getSnapshot()
        : []
    );

  return {
    app,
    shutdown: async () => {
      shuttingDown = true;
      await traceSink.close(settings.app.shutdownGraceMs);
    }
  };
}
