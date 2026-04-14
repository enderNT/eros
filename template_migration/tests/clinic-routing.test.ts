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
      active_goal: "",
      stage: "",
      pending_action: "",
      pending_question: "",
      appointment_slots: {},
      last_tool_result: "",
      last_user_message: "",
      last_assistant_message: "",
      memories: []
    });

    expect(decision.next_node).toBe("appointment");
    expect(decision.intent).toBe("appointment");
  });
});
