import type { CapabilityResult, ExecutionContext } from "../../domain/contracts";
import type { DspyBridge, LlmProvider } from "../../domain/ports";

export async function runActionCapability(
  context: ExecutionContext,
  llmProvider: LlmProvider,
  dspyBridge: DspyBridge
): Promise<{ result: CapabilityResult; usedDspy: boolean }> {
  const dspyResult = await dspyBridge.predictReply?.("action", context);
  if (dspyResult) {
    return { result: dspyResult, usedDspy: true };
  }

  return {
    result: await llmProvider.generateReply("action", context),
    usedDspy: false
  };
}
