import type { AppSettings } from "../../config";
import type { AddMemoryResult, MemoryHit, TurnRecord } from "../../domain/contracts";
import type { MemoryProvider } from "../../domain/ports";

export class Mem0MemoryProvider implements MemoryProvider {
  constructor(private readonly settings: AppSettings["memory"]) {}

  async addTurn(
    messages: TurnRecord[],
    actorId: string,
    agentId: string,
    sessionId: string,
    metadata: Record<string, unknown>
  ): Promise<AddMemoryResult> {
    const url = resolveMem0Url(this.settings.mem0.baseUrl, this.settings.mem0.addPath);
    if (!url || !this.settings.mem0.apiKey) {
      return { stored: false, count: 0 };
    }

    const pairText = messages.map((message) => `${message.role}: ${message.text}`).join("\n");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildMem0Headers(this.settings.mem0),
        body: JSON.stringify({
          messages: messages.map((message) => ({
            role: message.role,
            content: message.text
          })),
          user_id: actorId,
          agent_id: agentId,
          session_id: sessionId,
          metadata: {
            ...metadata,
            pairText
          }
        })
      });

      if (!response.ok) {
        return { stored: false, count: 0 };
      }

      return { stored: true, count: messages.length };
    } catch {
      return { stored: false, count: 0 };
    }
  }

  async search(query: string, actorId: string, agentId: string, topK: number, threshold: number): Promise<MemoryHit[]> {
    const url = resolveMem0Url(this.settings.mem0.baseUrl, this.settings.mem0.searchPath);
    if (!url || !this.settings.mem0.apiKey) {
      return [];
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: buildMem0Headers(this.settings.mem0),
        body: JSON.stringify({
          query,
          version: "v2",
          top_k: topK,
          filters: {
            user_id: actorId,
            agent_id: agentId
          },
          threshold
        })
      });

      if (!response.ok) {
        return [];
      }

      const payload = (await response.json()) as { memories?: unknown[]; results?: unknown[] };
      const candidates = Array.isArray(payload.memories)
        ? payload.memories
        : Array.isArray(payload.results)
          ? payload.results
          : [];

      return candidates
        .map((item) => normalizeMemoryHit(item))
        .filter((item): item is MemoryHit => Boolean(item))
        .filter((item) => item.score >= threshold)
        .slice(0, topK);
    } catch {
      return [];
    }
  }
}

export function buildMem0Headers(mem0: AppSettings["memory"]["mem0"]): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };

  const authMode = mem0.authMode === "auto" ? inferAuthMode(mem0.baseUrl) : mem0.authMode;
  if (mem0.apiKey) {
    if (authMode === "token") {
      headers.authorization = `Token ${mem0.apiKey}`;
    } else {
      headers["x-api-key"] = mem0.apiKey;
    }
  }

  if (mem0.orgId) {
    headers["x-org-id"] = mem0.orgId;
  }
  if (mem0.projectId) {
    headers["x-project-id"] = mem0.projectId;
  }

  return headers;
}

function inferAuthMode(baseUrl: string): "token" | "x-api-key" {
  return /localhost|127\.0\.0\.1|mem0/i.test(baseUrl) ? "x-api-key" : "token";
}

function resolveMem0Url(baseUrl: string, path: string): string | null {
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function normalizeMemoryHit(value: unknown): MemoryHit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};

  return {
    id: String(record.id ?? record.memory_id ?? crypto.randomUUID()),
    memory: String(record.memory ?? record.text ?? record.content ?? ""),
    score: typeof record.score === "number" ? record.score : typeof record.similarity === "number" ? record.similarity : 0,
    metadata,
    createdAt: String(record.created_at ?? record.createdAt ?? new Date(0).toISOString()),
    updatedAt: String(record.updated_at ?? record.updatedAt ?? new Date(0).toISOString())
  };
}
