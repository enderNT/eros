import type { AppSettings } from "../../config";
import type {
  Capability,
  CapabilityResult,
  ExecutionContext,
  InboundMessage,
  RouteDecision,
  ShortTermState
} from "../../domain/contracts";
import type { DspyBridge } from "../../domain/ports";

export class HttpDspyBridge implements DspyBridge {
  private circuitOpenedUntil = 0;

  constructor(private readonly settings: AppSettings["dspy"]) {}

  async health(): Promise<boolean> {
    if (!this.settings.enabled || this.isCircuitOpen()) {
      return false;
    }

    try {
      const response = await fetch(`${this.settings.serviceUrl}/health`, { signal: AbortSignal.timeout(this.settings.timeoutMs) });
      return response.ok;
    } catch {
      this.openCircuit();
      return false;
    }
  }

  async predictRouteDecision(payload: { inbound: InboundMessage; state: ShortTermState; promptDigest: string }): Promise<RouteDecision | null> {
    if (!this.settings.enabled || !this.settings.routeDecisionEnabled || this.isCircuitOpen()) {
      return null;
    }
    return this.post<RouteDecision>("/predict/route-decision", payload);
  }

  async predictReply(capability: Capability, context: ExecutionContext): Promise<CapabilityResult | null> {
    if (!this.settings.enabled || this.isCircuitOpen()) {
      return null;
    }

    const enabledByCapability = {
      conversation: this.settings.conversationReplyEnabled,
      knowledge: this.settings.knowledgeReplyEnabled,
      action: this.settings.actionReplyEnabled
    } satisfies Record<Capability, boolean>;

    if (!enabledByCapability[capability]) {
      return null;
    }

    return this.post<CapabilityResult>(`/predict/${capability}-reply`, context);
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
            throw new Error(`DSPy bridge transient failure: ${response.status}`);
          }
          return null;
        }

        return (await response.json()) as T;
      } catch (error) {
        attempt += 1;
        if (attempt > this.settings.retryCount) {
          this.openCircuit();
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
        if (error instanceof Error && /4\d\d/.test(error.message)) {
          return null;
        }
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
