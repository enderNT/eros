import { afterEach, describe, expect, test } from "bun:test";
import { loadSettings } from "../src/config";

const DSPY_ENV_KEYS = [
  "DSPY_ENABLED",
  "DSPY_TASK_TRACE_BACKEND",
  "DSPY_TASK_TRACE_POSTGRES_SCHEMA",
  "DSPY_SERVICE_URL",
  "DSPY_SERVICE_URL_FALLBACKS",
  "DOCKER_DSPY_PORT",
  "DSPY_TIMEOUT_MS",
  "DSPY_HEALTH_TIMEOUT_MS",
  "DSPY_MODEL"
] as const;

afterEach(() => {
  for (const key of DSPY_ENV_KEYS) {
    delete process.env[key];
  }
});

describe("dspy config inheritance", () => {
  test("uses DSPY_ENABLED as the only switch", () => {
    process.env.DSPY_ENABLED = "true";
    const settings = loadSettings();

    expect(settings.dspy.enabled).toBe(true);
  });

  test("loads the dedicated DSPy task trace config", () => {
    process.env.DSPY_TASK_TRACE_BACKEND = "postgres";
    process.env.DSPY_TASK_TRACE_POSTGRES_SCHEMA = "custom_dspy_tasks";

    const settings = loadSettings();

    expect(settings.dspy.taskTrace.backend).toBe("postgres");
    expect(settings.dspy.taskTrace.postgres.schema).toBe("custom_dspy_tasks");
  });

  test("normalizes DSPy service URLs and derives local fallbacks", () => {
    process.env.DSPY_SERVICE_URL = "dspy-service:8001";
    process.env.DOCKER_DSPY_PORT = "8020";

    const settings = loadSettings();

    expect(settings.dspy.serviceUrl).toBe("http://dspy-service:8001");
    expect(settings.dspy.serviceUrlFallbacks).toEqual([
      "http://127.0.0.1:8020",
      "http://localhost:8020",
      "http://host.docker.internal:8020"
    ]);
  });

  test("uses a safer DSPy timeout floor for GPT-5 models", () => {
    process.env.DSPY_MODEL = "gpt-5-mini";
    process.env.DSPY_TIMEOUT_MS = "4000";

    const settings = loadSettings();

    expect(settings.dspy.timeoutMs).toBe(12000);
    expect(settings.dspy.healthTimeoutMs).toBe(2000);
  });
});
