import { describe, expect, test } from "bun:test";
import { QdrantRetrievalService } from "../src/core/services/qdrant-retrieval-service";
import { buildTestSettings } from "./test-settings";

describe("QdrantRetrievalService", () => {
  test("uses clinic.json fallback only when qdrant has no retrieval context", async () => {
    const settings = buildTestSettings({
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

    const context = await service.buildContext("quiero informacion", "contact-1", ["memoria breve"]);

    expect(context).toContain("Contexto base de respaldo desde clinic.json:");
    expect(context).toContain("Clinica: Eros");
    expect(context).not.toContain("Fragmentos recuperados desde Qdrant:\n- [");
  });
});
