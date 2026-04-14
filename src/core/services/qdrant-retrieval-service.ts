import type { AppSettings } from "../../config";
import type { ClinicConfigProvider, ClinicKnowledgeContext, ClinicKnowledgeProvider } from "../../domain/ports";

interface QdrantPoint {
  id?: string | number;
  score?: number;
  payload?: Record<string, unknown>;
}

function shorten(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3)}...`;
}

export class QdrantRetrievalService implements ClinicKnowledgeProvider {
  private readonly chatCompletionsUrl: string | null;

  constructor(
    private readonly settings: AppSettings,
    private readonly fallbackConfigProvider?: ClinicConfigProvider
  ) {
    const trimmedBaseUrl = settings.llm.baseUrl?.trim();
    if (!trimmedBaseUrl) {
      this.chatCompletionsUrl = null;
    } else if (trimmedBaseUrl.endsWith("/embeddings")) {
      this.chatCompletionsUrl = trimmedBaseUrl;
    } else if (trimmedBaseUrl.endsWith("/chat/completions")) {
      this.chatCompletionsUrl = trimmedBaseUrl.replace(/\/chat\/completions$/, "/embeddings");
    } else {
      this.chatCompletionsUrl = `${trimmedBaseUrl.replace(/\/$/, "")}/embeddings`;
    }
  }

  private get ready(): boolean {
    return Boolean(this.settings.qdrant.enabled && this.settings.qdrant.baseUrl && this.settings.qdrant.collectionName);
  }

  async buildContext(query: string, contactId: string, memories: string[]): Promise<ClinicKnowledgeContext> {
    if (this.settings.qdrant.simulate) {
      const simulated = this.simulate(query, contactId);
      return {
        text: this.renderContext(query, memories, simulated),
        backend: "simulate",
        status: "simulated",
        resultCount: simulated.length,
        fallbackUsed: false
      };
    }

    if (!this.ready) {
      return this.buildFallbackOrUnavailableContext(query, memories, "qdrant_unavailable");
    }

    const results = await this.search(query, contactId);
    if (results === null) {
      return this.buildFallbackOrUnavailableContext(query, memories, "qdrant_unavailable");
    }

    if (results.length > 0) {
      return {
        text: this.renderContext(query, memories, results),
        backend: "qdrant",
        status: "ok",
        resultCount: results.length,
        fallbackUsed: false
      };
    }

    return this.buildFallbackOrUnavailableContext(query, memories, "no_results");
  }

  private async loadFallbackContext(): Promise<string> {
    if (!this.fallbackConfigProvider) {
      return "";
    }

    try {
      return (await this.fallbackConfigProvider.toContextText()).trim();
    } catch {
      return "";
    }
  }

  private async search(query: string, contactId: string): Promise<QdrantPoint[] | null> {
    try {
      const vector = await this.embed(query);
      const response = await fetch(
        `${this.settings.qdrant.baseUrl!.replace(/\/$/, "")}/collections/${this.settings.qdrant.collectionName}/points/search`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.settings.qdrant.apiKey ? { "api-key": this.settings.qdrant.apiKey } : {})
          },
          body: JSON.stringify({
            limit: this.settings.qdrant.topK,
            with_payload: true,
            with_vector: false,
            vector
          }),
          signal: AbortSignal.timeout(this.settings.qdrant.timeoutMs)
        }
      );
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as { result?: QdrantPoint[] };
      return payload.result?.slice(0, this.settings.qdrant.topK) ?? [];
    } catch {
      return null;
    }
  }

  private async buildFallbackOrUnavailableContext(
    query: string,
    memories: string[],
    status: "qdrant_unavailable" | "no_results"
  ): Promise<ClinicKnowledgeContext> {
    const fallbackContext = await this.loadFallbackContext();
    if (fallbackContext) {
      return {
        text: this.renderFallbackContext(query, memories, fallbackContext, status),
        backend: "clinic_config",
        status,
        resultCount: 0,
        fallbackUsed: true
      };
    }

    return {
      text: this.renderEmptyContext(query, memories, status),
      backend: "qdrant",
      status,
      resultCount: 0,
      fallbackUsed: false
    };
  }

  private renderContext(query: string, memories: string[], results: QdrantPoint[]): string {
    const chunks = [
      `Consulta RAG ejecutada en Qdrant para: ${query}`,
      "",
      "Memoria conversacional relevante:",
      memories.length > 0 ? memories.map((memory) => `- ${memory}`).join("\n") : "- Sin memorias",
      "",
      "Fragmentos recuperados desde Qdrant:"
    ];

    for (const result of results) {
      const source = String(result.payload?.source_file ?? result.payload?.source ?? "unknown");
      const text = String(result.payload?.text ?? "");
      chunks.push(`- [${String(result.id ?? "unknown")}] score=${Number(result.score ?? 0).toFixed(3)} source=${source} text=${shorten(text, 240)}`);
    }

    return chunks.join("\n");
  }

  private renderFallbackContext(
    query: string,
    memories: string[],
    fallbackContext: string,
    status: "qdrant_unavailable" | "no_results"
  ): string {
    const title = status === "qdrant_unavailable"
      ? "Qdrant no disponible. Usando respaldo de clinic.json."
      : "Qdrant sin resultados. Usando respaldo de clinic.json.";

    return [
      title,
      `Consulta original: ${query}`,
      "",
      "Memoria conversacional relevante:",
      memories.length > 0 ? memories.map((memory) => `- ${memory}`).join("\n") : "- Sin memorias",
      "",
      "Contexto base de respaldo desde clinic.json:",
      fallbackContext
    ].join("\n");
  }

  private renderEmptyContext(
    query: string,
    memories: string[],
    status: "qdrant_unavailable" | "no_results"
  ): string {
    const title = status === "qdrant_unavailable"
      ? "Qdrant no disponible y no hay respaldo local."
      : "Qdrant no devolvio resultados y no hay respaldo local.";

    return [
      title,
      `Consulta original: ${query}`,
      "",
      "Memoria conversacional relevante:",
      memories.length > 0 ? memories.map((memory) => `- ${memory}`).join("\n") : "- Sin memorias",
      "",
      "Fragmentos recuperados desde Qdrant:",
      "- Sin resultados"
    ].join("\n");
  }

  private async embed(query: string): Promise<number[]> {
    if (!this.chatCompletionsUrl || !this.settings.llm.apiKey) {
      throw new Error("Missing embedding configuration");
    }

    const response = await fetch(this.chatCompletionsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.settings.llm.apiKey}`
      },
      body: JSON.stringify({
        model: this.settings.qdrant.embeddingModel,
        input: [query]
      }),
      signal: AbortSignal.timeout(this.settings.llm.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    return payload.data?.[0]?.embedding?.map((value) => Number(value)) ?? [];
  }

  private simulate(query: string, contactId: string): QdrantPoint[] {
    const seed = `${contactId}:${query}`;
    return Array.from({ length: Math.min(3, this.settings.qdrant.topK) }).map((_, index) => ({
      id: `sim-${seed.slice(0, 12)}-${index + 1}`,
      score: 0.93 - index * 0.11,
      payload: {
        text: `Simulacion Qdrant para '${query}'`,
        source: "simulated-vector-store",
        contact_id: contactId,
        rank: index + 1
      }
    }));
  }
}
