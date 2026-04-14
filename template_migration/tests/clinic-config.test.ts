import { afterEach, describe, expect, test } from "bun:test";
import { loadSettings } from "../src/config";

const DSPY_ENV_KEYS = ["DSPY_ENABLED"] as const;

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
});
