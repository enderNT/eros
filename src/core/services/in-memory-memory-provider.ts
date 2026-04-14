import type { AddMemoryResult, MemoryHit, TurnRecord } from "../../domain/contracts";
import type { MemoryProvider } from "../../domain/ports";

interface StoredMemory extends MemoryHit {
  actorId: string;
  agentId: string;
  sessionId: string;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9áéíóúñü]+/i)
      .filter(Boolean)
  );
}

function scoreMatch(query: string, memory: string): number {
  const queryTokens = tokenize(query);
  const memoryTokens = tokenize(memory);
  if (queryTokens.size === 0 || memoryTokens.size === 0) return 0;

  let overlaps = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) overlaps += 1;
  }

  return overlaps / queryTokens.size;
}

export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly memories: StoredMemory[] = [];

  async addTurn(messages: TurnRecord[], actorId: string, agentId: string, sessionId: string, metadata: Record<string, unknown>): Promise<AddMemoryResult> {
    const userFacts = messages
      .filter((message) => message.role === "user")
      .map((message) => message.text.trim())
      .filter((message) => message.length > 0);

    const timestamp = new Date().toISOString();
    for (const fact of userFacts) {
      this.memories.push({
        id: crypto.randomUUID(),
        actorId,
        agentId,
        sessionId,
        memory: fact,
        score: 1,
        metadata,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    return { stored: userFacts.length > 0, count: userFacts.length };
  }

  async search(query: string, actorId: string, agentId: string, topK: number, threshold: number): Promise<MemoryHit[]> {
    return this.memories
      .filter((memory) => memory.actorId === actorId && memory.agentId === agentId)
      .map((memory) => ({ ...memory, score: scoreMatch(query, memory.memory) }))
      .filter((memory) => memory.score >= threshold)
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, topK);
  }
}
