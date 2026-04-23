import { afterEach, describe, expect, test } from "bun:test";
import { loadSettings } from "../src/config";

const DSPY_ENV_KEYS = ["DSPY_ENABLED", "DSPY_TASK_TRACE_BACKEND", "DSPY_TASK_TRACE_POSTGRES_SCHEMA"] as const;

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
});
