export interface AppSettings {
  app: {
    env: string;
    name: string;
    host: string;
    port: number;
    locale: string;
    timezone: string;
    shutdownGraceMs: number;
  };
  logging: {
    backend: "file" | "postgres" | "disabled";
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
  };
  prompt: {
    memoryMaxItems: number;
    memoryBudgetChars: number;
    recentTurnsLimit: number;
    summarizeOnOverflow: boolean;
  };
  state: {
    backend: string;
    refreshTurnThreshold: number;
    refreshCharThreshold: number;
    checkpointNamespace: string;
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
    webhookAsync: {
      callbackSecret?: string;
    };
  };
  trace: {
    backend: string;
    appKey: string;
    projectorsEnabled: boolean;
    storeRawRecall: boolean;
    storePromptDigest: boolean;
    flushTimeoutMs: number;
    recentLimit: number;
    projectorVersion: string;
    postgres: {
      connectionString: string;
      schema: string;
      connectTimeoutMs: number;
      queryTimeoutMs: number;
      healthTimeoutMs: number;
    };
  };
  dspy: {
    enabled: boolean;
    serviceUrl: string;
    serviceUrlFallbacks: string[];
    timeoutMs: number;
    healthTimeoutMs: number;
    retryCount: number;
    model: string;
    apiBase?: string;
    apiKey?: string;
    artifactsDir: string;
    datasetsDir: string;
    optimizationEnabled: boolean;
    taskTrace: {
      backend: string;
      postgres: {
        connectionString: string;
        schema: string;
        connectTimeoutMs: number;
        queryTimeoutMs: number;
        healthTimeoutMs: number;
      };
    };
  };
}

function readLoggingBackend(): AppSettings["logging"]["backend"] {
  const configured = readString("APP_LOG_BACKEND", "").trim().toLowerCase();
  if (configured === "file" || configured === "postgres" || configured === "disabled") {
    return configured;
  }

  return readBoolean("APP_LOG_TO_FILE", true) ? "file" : "disabled";
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

function readStringList(name: string): string[] {
  const rawValue = globalThis.Bun?.env[name] ?? process.env[name] ?? "";
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeServiceUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/g, "");
  if (!trimmed) {
    return trimmed;
  }
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

function isGpt5Model(model: string): boolean {
  const normalized = (model.toLowerCase().split("/").at(-1) ?? model.toLowerCase()).trim();
  return normalized.startsWith("gpt-5");
}

function normalizeTimeoutMs(configuredTimeoutMs: number, model: string): number {
  const safeTimeoutMs = configuredTimeoutMs > 0 ? configuredTimeoutMs : 4000;
  if (!isGpt5Model(model)) {
    return safeTimeoutMs;
  }
  return Math.max(safeTimeoutMs, 12000);
}

function buildDspyServiceUrlFallbacks(primaryServiceUrl: string, configuredFallbacks: string[], dockerDspyPort: string): string[] {
  const normalizedPrimary = normalizeServiceUrl(primaryServiceUrl);
  const fallbacks = new Set<string>(
    configuredFallbacks
      .map((value) => normalizeServiceUrl(value))
      .filter((value) => value && value !== normalizedPrimary)
  );

  try {
    const parsed = new URL(normalizedPrimary);
    const protocol = parsed.protocol || "http:";
    const port =
      dockerDspyPort.trim()
      || parsed.port
      || (protocol === "https:" ? "443" : "80");

    if (parsed.hostname === "dspy-service") {
      for (const host of ["127.0.0.1", "localhost", "host.docker.internal"]) {
        const candidate = `${protocol}//${host}:${port}`;
        if (candidate !== normalizedPrimary) {
          fallbacks.add(candidate);
        }
      }
    }

    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      const candidate = `${protocol}//dspy-service:${parsed.port || port}`;
      if (candidate !== normalizedPrimary) {
        fallbacks.add(candidate);
      }
    }
  } catch {
    return [...fallbacks];
  }

  return [...fallbacks];
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
  const loggingBackend = readLoggingBackend();
  const dspyEnabled = readBoolean("DSPY_ENABLED", false);
  const dspyModel = readString("DSPY_MODEL", "gpt-4o-mini");
  const dspyServiceUrl = normalizeServiceUrl(readString("DSPY_SERVICE_URL", "http://dspy-service:8001"));
  const dspyTimeoutMs = normalizeTimeoutMs(readNumber("DSPY_TIMEOUT_MS", 4000), dspyModel);

  return {
    app: {
      env,
      name: readString("APP_NAME", "stateful-assistant"),
      host: readString("APP_HOST", "0.0.0.0"),
      port: readNumber("APP_PORT", 3000),
      locale: readString("APP_DEFAULT_LOCALE", "es-MX"),
      timezone: readString("APP_DEFAULT_TIMEZONE", "America/Mexico_City"),
      shutdownGraceMs: readNumber("APP_SHUTDOWN_GRACE_MS", 5000)
    },
    logging: {
      backend: loggingBackend,
      consoleEnabled: readBoolean("APP_LOG_TO_CONSOLE", true),
      fileEnabled: loggingBackend === "file",
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
      knowledgeThreshold: readNumber("ROUTER_KNOWLEDGE_THRESHOLD", 0.58)
    },
    prompt: {
      memoryMaxItems: readNumber("PROMPT_MEMORY_MAX_ITEMS", 3),
      memoryBudgetChars: readNumber("PROMPT_MEMORY_BUDGET_CHARS", 1200),
      recentTurnsLimit: readNumber("PROMPT_RECENT_TURNS_LIMIT", 5),
      summarizeOnOverflow: readBoolean("PROMPT_SUMMARIZE_ON_OVERFLOW", true)
    },
    state: {
      backend: readString("STATE_BACKEND", "in_memory"),
      refreshTurnThreshold: readNumber("STATE_SUMMARY_REFRESH_TURN_THRESHOLD", 4),
      refreshCharThreshold: readNumber("STATE_SUMMARY_REFRESH_CHAR_THRESHOLD", 900),
      checkpointNamespace: readString("STATE_CHECKPOINT_NAMESPACE", `${readString("TRACE_APP_KEY", "stateful-assistant")}:clinic_state`)
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
      },
      webhookAsync: {
        callbackSecret: readString("CHAT_WEBHOOK_CALLBACK_SECRET", "")
      }
    },
    trace: {
      backend: readString("TRACE_BACKEND", "in_memory"),
      appKey: readString("TRACE_APP_KEY", "stateful-assistant"),
      projectorsEnabled: readBoolean("TRACE_PROJECTORS_ENABLED", true),
      storeRawRecall: readBoolean("TRACE_STORE_RAW_RECALL", true),
      storePromptDigest: readBoolean("TRACE_STORE_PROMPT_DIGEST", true),
      flushTimeoutMs: readNumber("TRACE_FLUSH_TIMEOUT_MS", 5000),
      recentLimit: readNumber("TRACE_RECENT_LIMIT", 200),
      projectorVersion: readString("TRACE_PROJECTOR_VERSION", "v1"),
      postgres: {
        connectionString: readString("TRACE_POSTGRES_URL", ""),
        schema: readString("TRACE_POSTGRES_SCHEMA", "tracing"),
        connectTimeoutMs: readNumber("TRACE_POSTGRES_CONNECT_TIMEOUT_MS", 3000),
        queryTimeoutMs: readNumber("TRACE_POSTGRES_QUERY_TIMEOUT_MS", 5000),
        healthTimeoutMs: readNumber("TRACE_POSTGRES_HEALTH_TIMEOUT_MS", 2000)
      }
    },
    dspy: {
      enabled: dspyEnabled,
      serviceUrl: dspyServiceUrl,
      serviceUrlFallbacks: buildDspyServiceUrlFallbacks(
        dspyServiceUrl,
        readStringList("DSPY_SERVICE_URL_FALLBACKS"),
        readString("DOCKER_DSPY_PORT", "")
      ),
      timeoutMs: dspyTimeoutMs,
      healthTimeoutMs: readNumber("DSPY_HEALTH_TIMEOUT_MS", Math.min(dspyTimeoutMs, 2000)),
      retryCount: readNumber("DSPY_RETRY_COUNT", 1),
      model: dspyModel,
      apiBase: readString("DSPY_API_BASE", ""),
      apiKey: readString("DSPY_API_KEY", ""),
      artifactsDir: readString("DSPY_ARTIFACTS_DIR", "./dspy_service/artifacts"),
      datasetsDir: readString("DSPY_DATASETS_DIR", "./dspy_service/datasets"),
      optimizationEnabled: readBoolean("DSPY_OPTIMIZATION_ENABLED", false),
      taskTrace: {
        backend: readString("DSPY_TASK_TRACE_BACKEND", "disabled"),
        postgres: {
          connectionString: readString("DSPY_TASK_TRACE_POSTGRES_URL", readString("TRACE_POSTGRES_URL", "")),
          schema: readString("DSPY_TASK_TRACE_POSTGRES_SCHEMA", "dspy_task_traces"),
          connectTimeoutMs: readNumber("DSPY_TASK_TRACE_POSTGRES_CONNECT_TIMEOUT_MS", 3000),
          queryTimeoutMs: readNumber("DSPY_TASK_TRACE_POSTGRES_QUERY_TIMEOUT_MS", 5000),
          healthTimeoutMs: readNumber("DSPY_TASK_TRACE_POSTGRES_HEALTH_TIMEOUT_MS", 2000)
        }
      }
    }
  };
}
