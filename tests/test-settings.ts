import type { AppSettings } from "../src/config";

export function buildTestSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  const base: AppSettings = {
    app: {
      env: "test",
      name: "test-app",
      host: "0.0.0.0",
      port: 3000,
      locale: "es-MX",
      timezone: "America/Mexico_City",
      shutdownGraceMs: 200
    },
    logging: {
      consoleEnabled: false,
      fileEnabled: false,
      directory: "./tmp-test-logs",
      fileName: "app.log",
      maxFiles: 3,
      maxLinesPerFile: 200,
      instanceId: "",
      containerName: "",
      containerId: "",
      hostName: "test-host"
    },
    llm: { provider: "local", apiKey: "", baseUrl: "", model: "test-model", timeoutMs: 1000, temperature: 0 },
    router: { confidenceThreshold: 0.62, knowledgeThreshold: 0.58 },
    prompt: { memoryMaxItems: 3, memoryBudgetChars: 1200, recentTurnsLimit: 4, summarizeOnOverflow: true },
    state: {
      backend: "in_memory",
      refreshTurnThreshold: 2,
      refreshCharThreshold: 900,
      checkpointNamespace: "test:clinic_state"
    },
    memory: {
      provider: "in_memory",
      enabled: true,
      agentId: "test-agent",
      topK: 5,
      scoreThreshold: 0,
      mem0: {
        baseUrl: "",
        apiKey: "",
        authMode: "auto",
        orgId: "",
        projectId: "",
        searchPath: "/v1/memories/search",
        addPath: "/v1/memories"
      }
    },
    qdrant: {
      enabled: false,
      simulate: true,
      baseUrl: "",
      apiKey: "",
      collectionName: "clinic_knowledge",
      timeoutMs: 1000,
      topK: 3,
      vectorSize: 1536,
      embeddingModel: "text-embedding-3-small"
    },
    channel: {
      provider: "none",
      replyEnabled: false,
      chatwoot: {
        baseUrl: "",
        apiAccessToken: ""
      }
    },
    trace: {
      backend: "in_memory",
      appKey: "test",
      projectorsEnabled: true,
      storeRawRecall: true,
      storePromptDigest: true,
      flushTimeoutMs: 500,
      recentLimit: 20,
      projectorVersion: "test-v1",
      postgres: {
        connectionString: "",
        schema: "tracing",
        connectTimeoutMs: 100,
        queryTimeoutMs: 100,
        healthTimeoutMs: 100
      }
    },
    dspy: {
      enabled: false,
      serviceUrl: "http://localhost:8001",
      timeoutMs: 100,
      retryCount: 0,
      model: "test-model",
      apiBase: "",
      apiKey: "",
      artifactsDir: "./tmp-dspy-artifacts",
      datasetsDir: "./tmp-dspy-datasets",
      optimizationEnabled: false
    }
  };

  return {
    ...base,
    ...overrides,
    logging: {
      ...base.logging,
      ...overrides.logging
    },
    llm: {
      ...base.llm,
      ...overrides.llm
    },
    memory: {
      ...base.memory,
      ...overrides.memory,
      mem0: {
        ...base.memory.mem0,
        ...overrides.memory?.mem0
      }
    },
    qdrant: {
      ...base.qdrant,
      ...overrides.qdrant
    },
    channel: {
      ...base.channel,
      ...overrides.channel,
      chatwoot: {
        ...base.channel.chatwoot,
        ...overrides.channel?.chatwoot
      }
    },
    trace: {
      ...base.trace,
      ...overrides.trace
    },
    dspy: {
      ...base.dspy,
      ...overrides.dspy
    }
  };
}
