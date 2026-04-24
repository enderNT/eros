import type { AppSettings } from "../../config";
import type { AddMemoryResult, MemoryHit, TurnRecord } from "../../domain/contracts";
import type { MemoryProvider } from "../../domain/ports";

export class Mem0MemoryProvider implements MemoryProvider {
  constructor(
    private readonly settings: AppSettings["memory"],
    private readonly consoleEnabled = true
  ) {}

  async addTurn(
    messages: TurnRecord[],
    actorId: string,
    agentId: string,
    sessionId: string,
    metadata: Record<string, unknown>
  ): Promise<AddMemoryResult> {
    const url = resolveMem0Url(this.settings.mem0.baseUrl, this.settings.mem0.addPath);
    if (!url || !this.settings.mem0.apiKey) {
      this.log("save_skip", {
        reason: !url ? "missing_base_url" : "missing_api_key",
        user_id: actorId,
        agent_id: agentId,
        session_id: sessionId
      }, true);
      return { stored: false, count: 0 };
    }

    const pairText = messages.map((message) => `${message.role}: ${message.text}`).join("\n");
    const authMode = this.settings.mem0.authMode === "auto"
      ? inferAuthMode(this.settings.mem0.baseUrl)
      : this.settings.mem0.authMode;
    this.log("save_request", {
      user_id: actorId,
      agent_id: agentId,
      session_id: sessionId,
      messages: messages.length,
      auth_mode: authMode,
      url,
      pair_preview: compact(pairText, 160)
    });

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

      const responseText = await response.text();
      const payload = parseJsonText(responseText);
      const ids = extractMem0Ids(payload);
      const reportedCount = extractMem0Count(payload);

      if (!response.ok) {
        this.log("save_response", {
          user_id: actorId,
          agent_id: agentId,
          session_id: sessionId,
          status: response.status,
          stored: false,
          ids: ids.join(",") || "none",
          reported_count: reportedCount ?? "unknown",
          preview: compact(responseText, 220)
        }, true);
        return { stored: false, count: 0 };
      }

      const count = ids.length > 0
        ? ids.length
        : reportedCount !== null
          ? reportedCount
          : messages.length;
      const stored = count > 0;
      this.log("save_response", {
        user_id: actorId,
        agent_id: agentId,
        session_id: sessionId,
        status: response.status,
        stored,
        ids: ids.join(",") || "none",
        reported_count: reportedCount ?? "unknown",
        preview: compact(responseText, 220)
      }, !stored);

      return { stored, count };
    } catch (error) {
      this.log("save_error", {
        user_id: actorId,
        agent_id: agentId,
        session_id: sessionId,
        error: error instanceof Error ? error.message : "unknown_mem0_save_error"
      }, true);
      return { stored: false, count: 0 };
    }
  }

  async search(query: string, actorId: string, agentId: string, topK: number, threshold: number): Promise<MemoryHit[]> {
    const url = resolveMem0Url(this.settings.mem0.baseUrl, this.settings.mem0.searchPath);
    if (!url || !this.settings.mem0.apiKey) {
      this.log("search_skip", {
        reason: !url ? "missing_base_url" : "missing_api_key",
        user_id: actorId,
        agent_id: agentId
      }, true);
      return [];
    }

    this.log("search_request", {
      user_id: actorId,
      agent_id: agentId,
      top_k: topK,
      threshold,
      url,
      query: compact(query, 120)
    });

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

      const responseText = await response.text();
      if (!response.ok) {
        this.log("search_response", {
          user_id: actorId,
          agent_id: agentId,
          status: response.status,
          hits: 0,
          ids: "none",
          preview: compact(responseText, 220)
        }, true);
        return [];
      }

      const payload = parseJsonText(responseText) as { memories?: unknown[]; results?: unknown[] } | null;
      const candidates = Array.isArray(payload?.memories)
        ? payload.memories
        : Array.isArray(payload?.results)
          ? payload.results
          : [];

      const results = candidates
        .map((item) => normalizeMemoryHit(item))
        .filter((item): item is MemoryHit => Boolean(item))
        .filter((item) => item.score >= threshold)
        .slice(0, topK);
      this.log("search_response", {
        user_id: actorId,
        agent_id: agentId,
        status: response.status,
        hits: results.length,
        ids: results.map((item) => item.id).join(",") || "none",
        memories: results.map((item) => compact(item.memory, 80)).join(" | ") || "none"
      });
      return results;
    } catch (error) {
      this.log("search_error", {
        user_id: actorId,
        agent_id: agentId,
        error: error instanceof Error ? error.message : "unknown_mem0_search_error"
      }, true);
      return [];
    }
  }

  private log(event: string, details: Record<string, unknown>, isError = false): void {
    if (!this.consoleEnabled) {
      return;
    }

    const formatted = Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== "")
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    const line = formatted ? `[MEM0] ${event} ${formatted}` : `[MEM0] ${event}`;
    if (isError) {
      console.error(line);
      return;
    }
    console.info(line);
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

function parseJsonText(value: string): Record<string, unknown> | null {
  if (!value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function extractMem0Ids(payload: Record<string, unknown> | null): string[] {
  if (!payload) {
    return [];
  }

  const buckets = [
    payload.memories,
    payload.results,
    payload.data,
    payload.items
  ];
  const ids: string[] = [];

  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const id = record.id ?? record.memory_id ?? record.uuid;
      if (id !== undefined && id !== null && String(id).trim()) {
        ids.push(String(id));
      }
    }
  }

  return ids;
}

function extractMem0Count(payload: Record<string, unknown> | null): number | null {
  if (!payload) {
    return null;
  }

  const numericCandidates = [
    payload.count,
    payload.memory_count,
    payload.memories_added,
    payload.added,
    payload.inserted
  ];
  for (const candidate of numericCandidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  const arrayCandidates = [
    payload.memories,
    payload.results,
    payload.data,
    payload.items
  ];
  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }

  return null;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
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
