import { afterEach, describe, expect, it } from "bun:test";
import { buildMem0Headers, Mem0MemoryProvider } from "../src/core/services/mem0-memory-provider";
import { buildTestSettings } from "./test-settings";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("Mem0MemoryProvider", () => {
  it("builds token auth headers when requested", () => {
    const headers = buildMem0Headers({
      baseUrl: "https://api.mem0.example.com",
      apiKey: "secret",
      authMode: "token",
      orgId: "org-1",
      projectId: "proj-1",
      searchPath: "/v1/search",
      addPath: "/v1/add"
    });

    expect(headers.authorization).toBe("Token secret");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-project-id"]).toBe("proj-1");
  });

  it("normalizes search results from Mem0 responses", async () => {
    const settings = buildTestSettings({
      memory: {
        provider: "mem0",
        enabled: true,
        agentId: "agent-1",
        topK: 5,
        scoreThreshold: 0.5,
        mem0: {
          baseUrl: "https://mem0.example.com",
          apiKey: "secret",
          authMode: "x-api-key",
          orgId: "",
          projectId: "",
          searchPath: "/v1/search",
          addPath: "/v1/add"
        }
      }
    });
    const provider = new Mem0MemoryProvider(settings.memory);

    global.fetch = ((async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: "memory-1",
              memory: "prefiere respuestas breves",
              score: 0.92,
              metadata: { channel: "chatwoot" },
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z"
            }
          ]
        })
      )) as unknown) as typeof fetch;

    const results = await provider.search("respuestas", "user-1", "agent-1", 5, 0.5);

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("memory-1");
    expect(results[0]?.metadata.channel).toBe("chatwoot");
  });

  it("uses the mem0 response body to determine whether addTurn really stored something", async () => {
    const settings = buildTestSettings({
      memory: {
        provider: "mem0",
        enabled: true,
        agentId: "agent-1",
        topK: 5,
        scoreThreshold: 0.5,
        mem0: {
          baseUrl: "https://mem0.example.com",
          apiKey: "secret",
          authMode: "x-api-key",
          orgId: "",
          projectId: "",
          searchPath: "/v1/search",
          addPath: "/v1/add"
        }
      }
    });
    const provider = new Mem0MemoryProvider(settings.memory, false);

    global.fetch = ((async () =>
      new Response(
        JSON.stringify({
          memories: [
            {
              id: "memory-42",
              memory: "prefiere horarios vespertinos"
            }
          ]
        }),
        { status: 200 }
      )) as unknown) as typeof fetch;

    const result = await provider.addTurn(
      [
        { role: "user", text: "Prefiero citas por la tarde", timestamp: "2026-01-01T00:00:00.000Z" },
        { role: "assistant", text: "Perfecto, lo tomo en cuenta", timestamp: "2026-01-01T00:00:01.000Z" }
      ],
      "user-1",
      "agent-1",
      "session-1",
      { route: "conversation" }
    );

    expect(result).toEqual({
      stored: true,
      count: 1
    });
  });
});
