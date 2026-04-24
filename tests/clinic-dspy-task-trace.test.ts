import { afterEach, describe, expect, test } from "bun:test";
import { ClinicDspyHttpBridge } from "../src/core/services/clinic-dspy-bridge";
import type { DspyTaskTraceRecord, DspyTaskTraceRecorder } from "../src/core/services/dspy-task-trace-recorder";
import { buildTestSettings } from "./test-settings";

class InMemoryDspyTaskTraceRecorder implements DspyTaskTraceRecorder {
  readonly entries: DspyTaskTraceRecord[] = [];

  async record(entry: DspyTaskTraceRecord): Promise<void> {
    this.entries.push(entry);
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async close(): Promise<void> {}
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("clinic dspy task trace recorder", () => {
  test("stores the exact request and response json for DSPy tasks", async () => {
    const recorder = new InMemoryDspyTaskTraceRecorder();
    const settings = buildTestSettings({
      dspy: {
        enabled: true,
        serviceUrl: "https://dspy.example.com",
        timeoutMs: 1000,
        retryCount: 0
      }
    });
    const bridge = new ClinicDspyHttpBridge(settings.dspy, recorder);
    const payload = {
      user_message: "hola",
      memories: ["uno", "dos"]
    };
    const rawResponse = '{\n  "response_text": "Hola",\n  "reply_mode": "llm"\n}';

    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://dspy.example.com/predict/conversation-reply");
      expect(init?.body).toBe(JSON.stringify(payload));
      return new Response(rawResponse, {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }) as typeof fetch;

    const result = await bridge.predictConversationReply(payload);

    expect(result).toEqual({
      response_text: "Hola",
      reply_mode: "llm"
    });
    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]).toMatchObject({
      taskName: "conversation_reply",
      endpoint: "/predict/conversation-reply",
      requestJson: JSON.stringify(payload),
      responseJson: rawResponse,
      responseStatus: 200,
      ok: true,
      errorText: null
    });
  });

  test("falls back to an alternate DSPy service URL and remembers it", async () => {
    const recorder = new InMemoryDspyTaskTraceRecorder();
    const settings = buildTestSettings({
      dspy: {
        enabled: true,
        serviceUrl: "https://dspy-primary.example.com",
        serviceUrlFallbacks: ["https://dspy-fallback.example.com"],
        timeoutMs: 1000,
        healthTimeoutMs: 200,
        retryCount: 0
      }
    });
    const bridge = new ClinicDspyHttpBridge(settings.dspy, recorder);
    const payload = { user_message: "hola" };
    const calls: string[] = [];

    globalThis.fetch = (async (input) => {
      const url = String(input);
      calls.push(url);

      if (url.startsWith("https://dspy-primary.example.com")) {
        throw new Error("The operation timed out.");
      }

      return new Response(JSON.stringify({
        response_text: "Hola desde fallback",
        reply_mode: "llm"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }) as typeof fetch;

    const firstResult = await bridge.predictConversationReply(payload);
    const secondResult = await bridge.predictConversationReply(payload);

    expect(firstResult?.response_text).toBe("Hola desde fallback");
    expect(secondResult?.response_text).toBe("Hola desde fallback");
    expect(calls).toEqual([
      "https://dspy-primary.example.com/predict/conversation-reply",
      "https://dspy-fallback.example.com/predict/conversation-reply",
      "https://dspy-fallback.example.com/predict/conversation-reply"
    ]);
    expect(recorder.entries).toHaveLength(2);
    expect(recorder.entries[0]).toMatchObject({
      responseStatus: 200,
      ok: true,
      errorText: null
    });
  });
});
