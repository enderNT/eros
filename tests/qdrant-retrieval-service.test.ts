import { describe, expect, test } from "bun:test";
import { QdrantRetrievalService } from "../src/core/services/qdrant-retrieval-service";
import { buildTestSettings } from "./test-settings";

describe("QdrantRetrievalService", () => {
  test("reports qdrant_unavailable and uses clinic.json fallback when qdrant is not ready", async () => {
    const settings = buildTestSettings({
      qdrant: {
        enabled: true,
        simulate: false,
        baseUrl: "",
        apiKey: "",
        collectionName: "clinic_knowledge",
        timeoutMs: 1000,
        topK: 3,
        vectorSize: 1536,
        embeddingModel: "text-embedding-3-small"
      }
    });

    const service = new QdrantRetrievalService(settings, {
      load: async () => ({
        clinic_name: "Eros",
        timezone: "America/Mexico_City",
        services: [],
        doctors: [],
        hours: {},
        policies: {}
      }),
      toContextText: async () => "Clinica: Eros\nServicios:\n- Consulta inicial"
    });

    const context = await service.buildContext("quiero informacion", "contact-1", ["memoria breve"]);

    expect(context.status).toBe("qdrant_unavailable");
    expect(context.backend).toBe("clinic_config");
    expect(context.fallbackUsed).toBe(true);
    expect(context.text).toContain("Contexto base de respaldo desde clinic.json:");
    expect(context.text).toContain("Clinica: Eros");
  });

  test("reports no_results and uses clinic.json fallback when qdrant returns an empty result set", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/embeddings")) {
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("/points/search")) {
        return new Response(
          JSON.stringify({ result: [] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response("not-found", { status: 404 });
    }) as typeof fetch;

    const settings = buildTestSettings({
      llm: {
        provider: "openai_compatible",
        apiKey: "secret",
        baseUrl: "https://llm.example.com/v1/chat/completions",
        model: "test-model",
        timeoutMs: 1000,
        temperature: 0
      },
      qdrant: {
        enabled: true,
        simulate: false,
        baseUrl: "https://qdrant.example.com",
        apiKey: "",
        collectionName: "clinic_knowledge",
        timeoutMs: 1000,
        topK: 3,
        vectorSize: 1536,
        embeddingModel: "text-embedding-3-small"
      }
    });

    const service = new QdrantRetrievalService(settings, {
      load: async () => ({
        clinic_name: "Eros",
        timezone: "America/Mexico_City",
        services: [],
        doctors: [],
        hours: {},
        policies: {}
      }),
      toContextText: async () => "Clinica: Eros\nServicios:\n- Consulta inicial"
    });

    try {
      const context = await service.buildContext("quiero informacion", "contact-1", ["memoria breve"]);

      expect(context.status).toBe("no_results");
      expect(context.backend).toBe("clinic_config");
      expect(context.fallbackUsed).toBe(true);
      expect(context.text).toContain("Qdrant sin resultados. Usando respaldo de clinic.json.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
