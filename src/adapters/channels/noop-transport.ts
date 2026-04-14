import type { InboundMessage, TurnOutcome } from "../../domain/contracts";
import type { OutboundTransport } from "../../domain/ports";

export class NoopTransport implements OutboundTransport {
  async emit(outcome: TurnOutcome, inbound: InboundMessage): Promise<{
    status: string;
    destination: string;
    response: Record<string, unknown>;
  }> {
    return {
      status: "skipped",
      destination: inbound.channel,
      response: {
        provider: "noop",
        delivered: false,
        preview: outcome.responseText.slice(0, 80)
      }
    };
  }
}
