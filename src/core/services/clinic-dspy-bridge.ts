import type { AppSettings } from "../../config";
import type { ClinicDspyBridge } from "../../domain/ports";
import type { GeneratedReply, RoutingPacket, StateRoutingDecision } from "../../domain/contracts";
import { dspyTaskNameFromPath, NoopDspyTaskTraceRecorder, type DspyTaskTraceRecorder } from "./dspy-task-trace-recorder";

function parseJsonText(rawText: string): { parsed: unknown; isJson: boolean } {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { parsed: null, isJson: false };
  }

  try {
    return {
      parsed: JSON.parse(rawText) as unknown,
      isJson: true
    };
  } catch {
    return {
      parsed: null,
      isJson: false
    };
  }
}

export class ClinicDspyHttpBridge implements ClinicDspyBridge {
  private circuitOpenedUntil = 0;

  constructor(
    private readonly settings: AppSettings["dspy"],
    private readonly taskTraceRecorder: DspyTaskTraceRecorder = new NoopDspyTaskTraceRecorder()
  ) {}

  async health(): Promise<boolean> {
    if (!this.settings.enabled || this.isCircuitOpen()) {
      return false;
    }

    try {
      const response = await fetch(`${this.settings.serviceUrl}/health`, {
        signal: AbortSignal.timeout(this.settings.timeoutMs)
      });
      if (!response.ok) {
        return false;
      }

      const payload = await response.json().catch(() => null) as
        | { ready?: boolean; backend?: string }
        | null;
      if (!payload) {
        return true;
      }
      if (payload.ready === false) {
        return false;
      }
      if (payload.backend && payload.backend !== "dspy") {
        return false;
      }
      return true;
    } catch {
      this.openCircuit();
      return false;
    }
  }

  async predictStateRouter(payload: RoutingPacket & { guard_hint?: Record<string, unknown> }): Promise<StateRoutingDecision | null> {
    if (!this.settings.enabled || this.isCircuitOpen()) {
      return null;
    }
    return this.post<StateRoutingDecision>("/predict/state-router", payload);
  }

  async predictConversationReply(payload: Record<string, unknown>): Promise<GeneratedReply | null> {
    if (!this.settings.enabled || this.isCircuitOpen()) {
      return null;
    }
    return this.post<GeneratedReply>("/predict/conversation-reply", payload);
  }

  async predictRagReply(payload: Record<string, unknown>): Promise<GeneratedReply | null> {
    if (!this.settings.enabled || this.isCircuitOpen()) {
      return null;
    }
    return this.post<GeneratedReply>("/predict/rag-reply", payload);
  }

  async predictAppointmentReply(payload: Record<string, unknown>): Promise<GeneratedReply | null> {
    if (!this.settings.enabled || this.isCircuitOpen()) {
      return null;
    }
    return this.post<GeneratedReply>("/predict/appointment-reply", payload);
  }

  private async post<T>(path: string, payload: unknown): Promise<T | null> {
    let attempt = 0;
    const taskName = dspyTaskNameFromPath(path);
    const requestJson = JSON.stringify(payload);

    while (attempt <= this.settings.retryCount) {
      const startedAt = new Date().toISOString();
      let recordedAttempt = false;
      try {
        const response = await fetch(`${this.settings.serviceUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestJson,
          signal: AbortSignal.timeout(this.settings.timeoutMs)
        });
        const responseText = await response.text();
        const parsedResponse = parseJsonText(responseText);
        const result =
          parsedResponse.parsed && typeof parsedResponse.parsed === "object" && !Array.isArray(parsedResponse.parsed)
            ? parsedResponse.parsed as Record<string, unknown>
            : null;
        const completedAt = new Date().toISOString();

        await this.taskTraceRecorder.record({
          taskName,
          endpoint: path,
          requestJson,
          responseJson: parsedResponse.isJson ? responseText : null,
          responseStatus: response.status,
          ok: response.ok && parsedResponse.isJson,
          errorText: response.ok
            ? (parsedResponse.isJson ? null : "dspy_non_json_response")
            : `dspy_http_${response.status}`,
          startedAt,
          completedAt
        });
        recordedAttempt = true;

        if (!response.ok) {
          if (response.status >= 500) {
            throw new Error(`DSPy transient failure ${response.status}`);
          }
          return null;
        }

        if (!result || typeof result !== "object") {
          return null;
        }

        if (path === "/predict/state-router") {
          return typeof result.next_node === "string" ? (result as T) : null;
        }

        const replyMode = typeof result.reply_mode === "string" ? result.reply_mode : "";
        const replyText = typeof result.response_text === "string" ? result.response_text.trim() : "";
        if (replyMode !== "llm" || !replyText) {
          return null;
        }

        return result as T;
      } catch (error) {
        if (!recordedAttempt) {
          await this.taskTraceRecorder.record({
            taskName,
            endpoint: path,
            requestJson,
            responseJson: null,
            responseStatus: null,
            ok: false,
            errorText: error instanceof Error ? error.message : "unknown_dspy_request_error",
            startedAt,
            completedAt: new Date().toISOString()
          });
        }
        attempt += 1;
        if (attempt > this.settings.retryCount) {
          this.openCircuit();
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }

    return null;
  }

  private isCircuitOpen(): boolean {
    return Date.now() < this.circuitOpenedUntil;
  }

  private openCircuit(): void {
    this.circuitOpenedUntil = Date.now() + 30_000;
  }
}
