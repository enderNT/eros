import { describe, expect, test } from "bun:test";
import { loadSettings } from "../src/config";
import { ClinicDspyHttpBridge } from "../src/core/services/clinic-dspy-bridge";
import { ClinicLlmService } from "../src/core/services/clinic-llm-service";
import { ClinicRoutingService } from "../src/core/services/clinic-routing-service";
import { buildTestSettings } from "./test-settings";

describe("clinic routing deterministic guards", () => {
  test("routes appointment requests without relying on remote llm", async () => {
    const settings = loadSettings();
    const llmService = new ClinicLlmService(settings);
    const bridge = new ClinicDspyHttpBridge({ ...settings.dspy, enabled: false });
    const routingService = new ClinicRoutingService(settings, llmService, bridge);

    const decision = await routingService.routeState({
      user_message: "Quiero agendar una cita para manana",
      conversation_summary: "",
      current_mode: "conversation",
      last_tool_result: "",
      last_assistant_message: "",
      memories: []
    });

    expect(decision.next_node).toBe("appointment");
    expect(decision.intent).toBe("appointment");
    expect(decision.debug).toEqual({
      provider: "guard",
      raw_next_node: "appointment",
      final_next_node: "appointment",
      validation_applied: false
    });
  });

  test("keeps appointment follow-ups inside the appointment branch with minimal routing context", async () => {
    const settings = loadSettings();
    const llmService = new ClinicLlmService(settings);
    const bridge = new ClinicDspyHttpBridge({ ...settings.dspy, enabled: false });
    const routingService = new ClinicRoutingService(settings, llmService, bridge);

    const decision = await routingService.routeState({
      user_message: "mañana a las 10 am",
      conversation_summary: "Usuario quiere agendar una cita y falta la fecha y hora.",
      current_mode: "appointment",
      last_tool_result: "",
      last_assistant_message: "Compárteme por favor la fecha y hora que prefieres para tu cita.",
      memories: []
    });

    expect(decision.next_node).toBe("appointment");
    expect(decision.debug?.provider).toBe("guard");
  });

  test("keeps information follow-ups inside rag when there is retrieval context", async () => {
    const settings = loadSettings();
    const llmService = new ClinicLlmService(settings);
    const bridge = new ClinicDspyHttpBridge({ ...settings.dspy, enabled: false });
    const routingService = new ClinicRoutingService(settings, llmService, bridge);

    const decision = await routingService.routeState({
      user_message: "y cuanto cuesta?",
      conversation_summary: "Se habló sobre estimulación magnética y el usuario pidió más detalle.",
      current_mode: "information",
      last_tool_result: "Servicio estimulación magnética recuperado desde base de conocimiento.",
      last_assistant_message: "Puedo darte la información base y, si quieres, te comparto precios y disponibilidad.",
      memories: []
    });

    expect(decision.next_node).toBe("rag");
    expect(decision.needs_retrieval).toBe(true);
    expect(decision.debug).toEqual({
      provider: "guard",
      raw_next_node: "rag",
      final_next_node: "rag",
      validation_applied: false
    });
  });

  test("normalizes invalid dspy next_node values to conversation", async () => {
    const settings = buildTestSettings({
      dspy: {
        enabled: true
      }
    });
    const llmService = new ClinicLlmService(settings);
    const bridge = new ClinicDspyHttpBridge(settings.dspy);
    bridge.predictStateRouter = async () => ({
      next_node: "information" as never,
      intent: "ask_about_treatment_info",
      confidence: 0.82,
      needs_retrieval: false,
      state_update: {},
      reason: "remote-dspy"
    });
    const routingService = new ClinicRoutingService(settings, llmService, bridge);

    const decision = await routingService.routeState({
      user_message: "Necesito información",
      conversation_summary: "",
      current_mode: "conversation",
      last_tool_result: "",
      last_assistant_message: "",
      memories: []
    });

    expect(decision.next_node).toBe("conversation");
    expect(decision.debug).toEqual({
      provider: "dspy",
      raw_next_node: "information",
      final_next_node: "conversation",
      validation_applied: true
    });
  });

  test("captures raw next_node when llm output is normalized", async () => {
    const settings = buildTestSettings();
    const llmService = new ClinicLlmService(settings);
    (llmService as unknown as { requestJson: () => Promise<Record<string, unknown>> }).requestJson = async () => ({
      next_node: "information",
      intent: "ask_about_treatment_info",
      confidence: 0.71,
      needs_retrieval: false,
      reason: "remote-json"
    });

    const decision = await llmService.classifyStateRoute({
      user_message: "Necesito información",
      conversation_summary: "",
      current_mode: "conversation",
      last_tool_result: "",
      last_assistant_message: "",
      memories: []
    });

    expect(decision.next_node).toBe("conversation");
    expect(decision.debug).toEqual({
      provider: "llm",
      raw_next_node: "information",
      final_next_node: "conversation",
      validation_applied: true
    });
  });

  test("sends the full conversation summary to the routing signature while keeping other routing guards intact", async () => {
    const settings = buildTestSettings({
      dspy: {
        enabled: true
      }
    });
    const llmService = new ClinicLlmService(settings);
    const bridge = new ClinicDspyHttpBridge(settings.dspy);
    let capturedPayload: Record<string, unknown> | null = null;
    bridge.predictStateRouter = async (payload) => {
      capturedPayload = payload;
      return {
        next_node: "conversation",
        intent: "conversation",
        confidence: 0.8,
        needs_retrieval: false,
        state_update: {},
        reason: "remote-dspy"
      };
    };
    const routingService = new ClinicRoutingService(settings, llmService, bridge);
    const longSummary = `Resumen-${"s".repeat(700)}`;

    await routingService.routeState({
      user_message: "Quiero continuar con lo anterior",
      conversation_summary: longSummary,
      current_mode: "conversation",
      last_tool_result: "",
      last_assistant_message: "",
      memories: []
    });

    expect(capturedPayload?.conversation_summary).toBe(longSummary);
  });
});
