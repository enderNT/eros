import type { AppSettings } from "../../config";
import type { ClinicDspyBridge } from "../../domain/ports";
import type { GeneratedReply, RoutingPacket, StateRoutingDecision } from "../../domain/contracts";

export class ClinicDspyHttpBridge implements ClinicDspyBridge {
  private circuitOpenedUntil = 0;

  constructor(private readonly settings: AppSettings["dspy"]) {}

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
    while (attempt <= this.settings.retryCount) {
      try {
        const response = await fetch(`${this.settings.serviceUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.settings.timeoutMs)
        });

        if (!response.ok) {
          if (response.status >= 500) {
            throw new Error(`DSPy transient failure ${response.status}`);
          }
          return null;
        }

        const result = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (!result || typeof result !== "object") {
          return null;
        }

        if (path === "/predict/state-router") {
          return typeof result.next_node === "string" ? (result as T) : null;
        }

        const replyMode = typeof result.reply_mode === "string" ? result.reply_mode : "";
        const responseText = typeof result.response_text === "string" ? result.response_text.trim() : "";
        if (replyMode !== "llm" || !responseText) {
          return null;
        }

        return result as T;
      } catch {
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
