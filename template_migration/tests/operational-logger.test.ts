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
          consoleEnabled: false,
          fileEnabled: true,
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
});
