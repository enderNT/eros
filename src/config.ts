export interface AppSettings {
  app: {
    env: string;
    name: string;
    host: string;
    port: number;
    logLevel: string;
    locale: string;
    timezone: string;
  };
  logging: {
    consoleEnabled: boolean;
    fileEnabled: boolean;
    directory: string;
    fileName: string;
    maxFiles: number;
    maxLinesPerFile: number;
    instanceId: string;
    containerName: string;
    containerId: string;
    hostName: string;
  };
  llm: {
    provider: string;
    apiKey?: string;
    baseUrl?: string;
    model: string;
    timeoutMs: number;
    temperature?: number;
  };
  router: {
    confidenceThreshold: number;
    knowledgeThreshold: number;
    inputDebug: boolean;
  };
  prompt: {
    memoryMaxItems: number;
    memoryBudgetChars: number;
    recentTurnsLimit: number;
    summarizeOnOverflow: boolean;
  };
  state: {
    refreshTurnThreshold: number;
    refreshCharThreshold: number;
  };
  memory: {
    provider: string;
    enabled: boolean;
    agentId: string;
    topK: number;
    scoreThreshold: number;
    mem0: {
      baseUrl: string;
      apiKey?: string;
      authMode: "token" | "x-api-key" | "auto";
      orgId?: string;
      projectId?: string;
      searchPath: string;
      addPath: string;
    };
  };
  knowledge: {
    provider: string;
    enabled: boolean;
    topK: number;
    timeoutMs: number;
  };
  clinic: {
    configPath: string;
    bookingUrl: string;
  };
  qdrant: {
    enabled: boolean;
    simulate: boolean;
    baseUrl?: string;
    apiKey?: string;
    collectionName: string;
    timeoutMs: number;
    topK: number;
    vectorSize: number;
    embeddingModel: string;
  };
  channel: {
    provider: string;
    replyEnabled: boolean;
    accountId?: string;
    chatwoot: {
      baseUrl: string;
      apiAccessToken?: string;
    };
  };
  trace: {
    backend: string;
    appKey: string;
    projectorsEnabled: boolean;
    storeRawRecall: boolean;
    storePromptDigest: boolean;
  };
  dspy: {
    enabled: boolean;
    serviceUrl: string;
    timeoutMs: number;
    retryCount: number;
    model: string;
    apiBase?: string;
    apiKey?: string;
    artifactsDir: string;
    datasetsDir: string;
    optimizationEnabled: boolean;
  };
}

function readString(name: string, fallback: string): string {
  return globalThis.Bun?.env[name] ?? process.env[name] ?? fallback;
}

function readNumber(name: string, fallback: number): number {
  const value = globalThis.Bun?.env[name] ?? process.env[name];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = (globalThis.Bun?.env[name] ?? process.env[name])?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function defaultLogRotation(env: string): { maxFiles: number; maxLinesPerFile: number } {
  if (env === "production") {
    return { maxFiles: 10, maxLinesPerFile: 500 };
  }
  return { maxFiles: 3, maxLinesPerFile: 200 };
}

export function loadSettings(): AppSettings {
  const env = readString("APP_ENV", "development");
  const logRotation = defaultLogRotation(env);
  const dspyEnabled = readBoolean("DSPY_ENABLED", false);

  return {
    app: {
      env,
      name: readString("APP_NAME", "stateful-assistant"),
      host: readString("APP_HOST", "0.0.0.0"),
      port: readNumber("APP_PORT", 3000),
      logLevel: readString("APP_LOG_LEVEL", "INFO"),
      locale: readString("APP_DEFAULT_LOCALE", "es-MX"),
      timezone: readString("APP_DEFAULT_TIMEZONE", "America/Mexico_City")
    },
    logging: {
      consoleEnabled: readBoolean("APP_LOG_TO_CONSOLE", true),
      fileEnabled: readBoolean("APP_LOG_TO_FILE", true),
      directory: readString("APP_LOG_DIR", "./var/log/stateful-assistant"),
      fileName: readString("APP_LOG_FILE", "app.log"),
      maxFiles: readNumber("APP_LOG_MAX_FILES", logRotation.maxFiles),
      maxLinesPerFile: readNumber("APP_LOG_MAX_LINES", logRotation.maxLinesPerFile),
      instanceId: readString("APP_INSTANCE_ID", ""),
      containerName: readString("APP_CONTAINER_NAME", ""),
      containerId: readString("APP_CONTAINER_ID", ""),
      hostName: readString("APP_HOST_NAME", readString("HOSTNAME", ""))
    },
    llm: {
      provider: readString("LLM_PROVIDER", "local"),
      apiKey: readString("LLM_API_KEY", ""),
      baseUrl: readString("LLM_BASE_URL", ""),
      model: readString("LLM_MODEL", "gpt-5-mini"),
      timeoutMs: readNumber("LLM_TIMEOUT_MS", 30000),
      temperature: (() => {
        const raw = globalThis.Bun?.env.LLM_TEMPERATURE ?? process.env.LLM_TEMPERATURE;
        return raw ? Number(raw) : undefined;
      })()
    },
    router: {
      confidenceThreshold: readNumber("ROUTER_CONFIDENCE_THRESHOLD", 0.62),
      knowledgeThreshold: readNumber("ROUTER_KNOWLEDGE_THRESHOLD", 0.58),
      inputDebug: readBoolean("ROUTER_INPUT_DEBUG", false)
    },
    prompt: {
      memoryMaxItems: readNumber("PROMPT_MEMORY_MAX_ITEMS", 3),
      memoryBudgetChars: readNumber("PROMPT_MEMORY_BUDGET_CHARS", 1200),
      recentTurnsLimit: readNumber("PROMPT_RECENT_TURNS_LIMIT", 3),
      summarizeOnOverflow: readBoolean("PROMPT_SUMMARIZE_ON_OVERFLOW", true)
    },
    state: {
      refreshTurnThreshold: readNumber("STATE_SUMMARY_REFRESH_TURN_THRESHOLD", 4),
      refreshCharThreshold: readNumber("STATE_SUMMARY_REFRESH_CHAR_THRESHOLD", 900)
    },
    memory: {
      provider: readString("MEMORY_PROVIDER", "in_memory"),
      enabled: readBoolean("MEMORY_ENABLED", true),
      agentId: readString("MEMORY_AGENT_ID", "default-assistant"),
      topK: readNumber("MEMORY_TOP_K", 5),
      scoreThreshold: readNumber("MEMORY_SCORE_THRESHOLD", 0),
      mem0: {
        baseUrl: readString("MEM0_BASE_URL", ""),
        apiKey: readString("MEM0_API_KEY", ""),
        authMode: readString("MEM0_AUTH_MODE", "auto") as AppSettings["memory"]["mem0"]["authMode"],
        orgId: readString("MEM0_ORG_ID", ""),
        projectId: readString("MEM0_PROJECT_ID", ""),
        searchPath: readString("MEM0_SEARCH_PATH", "/v1/memories/search"),
        addPath: readString("MEM0_ADD_PATH", "/v1/memories")
      }
    },
    knowledge: {
      provider: readString("KNOWLEDGE_PROVIDER", "none"),
      enabled: readBoolean("KNOWLEDGE_ENABLED", false),
      topK: readNumber("KNOWLEDGE_TOP_K", 5),
      timeoutMs: readNumber("KNOWLEDGE_TIMEOUT_MS", 10000)
    },
    clinic: {
      configPath: readString("CLINIC_CONFIG_PATH", "./config/clinic.json"),
      bookingUrl: readString("CLINIC_BOOKING_URL", "https://calendly.com/gayagocr/new-meeting")
    },
    qdrant: {
      enabled: readBoolean("QDRANT_ENABLED", false),
      simulate: readBoolean("QDRANT_SIMULATE", true),
      baseUrl: readString("QDRANT_BASE_URL", ""),
      apiKey: readString("QDRANT_API_KEY", ""),
      collectionName: readString("QDRANT_COLLECTION_NAME", "clinic_knowledge"),
      timeoutMs: readNumber("QDRANT_TIMEOUT_MS", 10000),
      topK: readNumber("QDRANT_TOP_K", 5),
      vectorSize: readNumber("QDRANT_VECTOR_SIZE", 1536),
      embeddingModel: readString("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    },
    channel: {
      provider: readString("CHANNEL_PROVIDER", "none"),
      replyEnabled: readBoolean("CHANNEL_REPLY_ENABLED", false),
      accountId: readString("CHATWOOT_ACCOUNT_ID", ""),
      chatwoot: {
        baseUrl: readString("CHATWOOT_BASE_URL", ""),
        apiAccessToken: readString("CHATWOOT_API_ACCESS_TOKEN", "")
      }
    },
    trace: {
      backend: readString("TRACE_BACKEND", "in_memory"),
      appKey: readString("TRACE_APP_KEY", "stateful-assistant"),
      projectorsEnabled: readBoolean("TRACE_PROJECTORS_ENABLED", true),
      storeRawRecall: readBoolean("TRACE_STORE_RAW_RECALL", true),
      storePromptDigest: readBoolean("TRACE_STORE_PROMPT_DIGEST", true)
    },
    dspy: {
      enabled: dspyEnabled,
      serviceUrl: readString("DSPY_SERVICE_URL", "http://dspy-service:8001"),
      timeoutMs: readNumber("DSPY_TIMEOUT_MS", 4000),
      retryCount: readNumber("DSPY_RETRY_COUNT", 1),
      model: readString("DSPY_MODEL", "gpt-4o-mini"),
      apiBase: readString("DSPY_API_BASE", ""),
      apiKey: readString("DSPY_API_KEY", ""),
      artifactsDir: readString("DSPY_ARTIFACTS_DIR", "./dspy_service/artifacts"),
      datasetsDir: readString("DSPY_DATASETS_DIR", "./dspy_service/datasets"),
      optimizationEnabled: readBoolean("DSPY_OPTIMIZATION_ENABLED", false)
    }
  };
}
