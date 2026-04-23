import { describe, expect, test } from "bun:test";
import { loadSettings } from "../src/config";
import { ClinicDspyHttpBridge } from "../src/core/services/clinic-dspy-bridge";
import { ClinicLlmService } from "../src/core/services/clinic-llm-service";
import { ClinicRoutingService } from "../src/core/services/clinic-routing-service";

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
  });
});
