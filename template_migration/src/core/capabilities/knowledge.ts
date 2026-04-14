import type { CapabilityResult, ExecutionContext } from "../../domain/contracts";
import type { DspyBridge, LlmProvider } from "../../domain/ports";

export async function runKnowledgeCapability(
  context: ExecutionContext,
  llmProvider: LlmProvider,
  dspyBridge: DspyBridge
): Promise<{ result: CapabilityResult; usedDspy: boolean }> {
  const dspyResult = await dspyBridge.predictReply?.("knowledge", context);
  if (dspyResult) {
    return { result: dspyResult, usedDspy: true };
  }

  return {
    result: await llmProvider.generateReply("knowledge", context),
    usedDspy: false
  };
}
