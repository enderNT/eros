import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationalLogger } from "../src/core/services/operational-logger";
import { buildTestSettings } from "./test-settings";

const createdDirs: string[] = [];

afterEach(async () => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("OperationalLogger", () => {
  it("rotates operational log files as a bounded ring", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stateful-logger-"));
    createdDirs.push(directory);

    const logger = new OperationalLogger(
      buildTestSettings({
        logging: {
          backend: "file",
          consoleEnabled: false,
          directory,
          fileName: "app.log",
          maxFiles: 2,
          maxLinesPerFile: 12,
          instanceId: "",
          containerName: "",
          containerId: "",
          hostName: "test-host"
        }
      })
    );

    const execution = await logger.startRun({
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "Hola",
      rawPayload: { text: "Hola" },
      receivedAt: new Date().toISOString()
    });

    for (let index = 0; index < 8; index += 1) {
      await execution.tool(`step_${index}`, {
        component: "test",
        request: { index },
        response: { ok: true },
        status: "ok"
      });
    }
    await execution.end({ status: "ok", summary: "test", result: "completed" });

    const files = await readdir(directory);
    expect(files.filter((file) => /^app(\.\d+)?\.log$/.test(file)).length).toBeLessThanOrEqual(2);

    const baseLog = await readFile(join(directory, "app.log"), "utf8");
    expect(baseLog).toContain("RUN");
  });

  it("persists operational logs into postgres using tracing connection settings", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];

    const logger = new OperationalLogger(
      buildTestSettings({
        logging: {
          backend: "postgres",
          consoleEnabled: false,
          directory: "./tmp-test-logs",
          fileName: "app.log",
          maxFiles: 2,
          maxLinesPerFile: 12,
          instanceId: "",
          containerName: "",
          containerId: "",
          hostName: "test-host"
        },
        trace: {
          backend: "postgres",
          postgres: {
            connectionString: "postgres://example/test",
            schema: "tracing",
            connectTimeoutMs: 100,
            queryTimeoutMs: 100,
            healthTimeoutMs: 100
          }
        }
      }),
      {
        createPostgresClient: () => ({
          async connect() {},
          async query(text: string, values?: unknown[]) {
            queries.push({
              text: text.replace(/\s+/g, " ").trim(),
              values
            });
            return {};
          },
          async end() {}
        })
      }
    );

    await logger.logStartup({ feature: "postgres_logger" });

    const execution = await logger.startRun({
      sessionId: "session-1",
      actorId: "user-1",
      channel: "test",
      text: "Hola",
      rawPayload: { text: "Hola", apiKey: "secret" },
      receivedAt: new Date().toISOString()
    });

    await execution.tool("lookup", {
      component: "test",
      request: { token: "secret-token" },
      response: { ok: true },
      status: "ok"
    });
    await execution.end({ status: "ok", summary: "done", result: "completed" });
    await logger.close();

    expect(queries.some(({ text }) => text.includes("create schema if not exists"))).toBe(true);
    expect(queries.some(({ text }) => text.includes("create table if not exists \"tracing\".\"operational_log_runs\""))).toBe(true);
    expect(queries.some(({ text }) => text.includes("create table if not exists \"tracing\".\"operational_log_entries\""))).toBe(true);
    expect(queries.some(({ text }) => text.includes("insert into \"tracing\".\"operational_log_runs\""))).toBe(true);
    expect(queries.some(({ text }) => text.includes("update \"tracing\".\"operational_log_runs\""))).toBe(true);

    const systemEntryInsert = queries.find(({ text, values }) =>
      text.includes("insert into \"tracing\".\"operational_log_entries\"")
      && values?.[0] === null
      && values?.[3] === "SYSTEM EVENT"
    );
    expect(systemEntryInsert).toBeDefined();

    const runEntryInsert = queries.find(({ text, values }) =>
      text.includes("insert into \"tracing\".\"operational_log_entries\"")
      && values?.[3] === "01.INPUT"
    );
    expect(runEntryInsert).toBeDefined();
    expect(String(runEntryInsert?.values?.[8])).toContain("[redacted]");

    const runEndUpdate = queries.find(({ text }) => text.includes("update \"tracing\".\"operational_log_runs\""));
    expect(runEndUpdate?.values?.[2]).toBe("ok");
  });
});
