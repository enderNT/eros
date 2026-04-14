import { Elysia } from "elysia";
import { loadSettings } from "./config";
import {
  assessChatwootWebhook,
  normalizeChatwootInboundMessage,
  normalizeInboundMessage
} from "./adapters/http/inbound";
import { createOutboundTransport } from "./core/factories/runtime";
import { ClinicOrchestrator } from "./core/clinic-orchestrator";
import { ClinicDspyHttpBridge } from "./core/services/clinic-dspy-bridge";
import { ClinicConfigLoader } from "./core/services/clinic-config-loader";
import { ClinicLlmService } from "./core/services/clinic-llm-service";
import { ClinicRoutingService } from "./core/services/clinic-routing-service";
import { ClinicWorkflow } from "./core/services/clinic-workflow";
import { InMemoryClinicStateStore } from "./core/services/in-memory-clinic-state-store";
import { InMemoryConversationMemoryRuntime } from "./core/services/in-memory-conversation-memory-runtime";
import { InMemoryTraceSink } from "./core/services/in-memory-trace-sink";
import { QdrantRetrievalService } from "./core/services/qdrant-retrieval-service";
import { OperationalLogger } from "./core/services/operational-logger";

export function buildApp() {
  const settings = loadSettings();
  const traceSink = new InMemoryTraceSink();
  const logger = new OperationalLogger(settings);
  const llmService = new ClinicLlmService(settings);
  const dspyBridge = new ClinicDspyHttpBridge(settings.dspy);
  const clinicConfigProvider = new ClinicConfigLoader(settings.clinic.configPath);
  const memoryRuntime = new InMemoryConversationMemoryRuntime(llmService);
  const routingService = new ClinicRoutingService(settings, llmService, dspyBridge);
  const workflow = new ClinicWorkflow(
    routingService,
    llmService,
    memoryRuntime,
    clinicConfigProvider,
    new QdrantRetrievalService(settings),
    dspyBridge,
    settings
  );
  const outboundTransport = createOutboundTransport(settings);
  const orchestrator = new ClinicOrchestrator(new InMemoryClinicStateStore(), workflow, outboundTransport, traceSink);

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

  return new Elysia()
    .get("/health", async () => ({
      ok: true,
      service: settings.app.name,
      dspyEnabled: settings.dspy.enabled,
      traceBackend: settings.trace.backend,
      timestamp: new Date().toISOString()
    }))
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
    .get("/debug/traces", () => traceSink.getSnapshot());
}
