import type { AppSettings } from "../../config";
import type { MemoryHit, PromptMemorySelection } from "../../domain/contracts";
import type { LlmProvider } from "../../domain/ports";

export async function buildPromptMemorySelection(
  query: string,
  memories: MemoryHit[],
  llmProvider: LlmProvider,
  settings: AppSettings["prompt"]
): Promise<PromptMemorySelection> {
  const selected = memories.slice(0, settings.memoryMaxItems);
  const rawDigest = selected.map((memory) => memory.memory).join(" | ");

  if (rawDigest.length <= settings.memoryBudgetChars || !settings.summarizeOnOverflow) {
    return {
      rawRecall: selected,
      promptDigest: rawDigest.slice(0, settings.memoryBudgetChars)
    };
  }

  return {
    rawRecall: selected,
    promptDigest: await llmProvider.summarizeMemories({
      query,
      memories: selected,
      budgetChars: settings.memoryBudgetChars
    })
  };
}
