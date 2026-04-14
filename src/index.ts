import { buildApp } from "./app";
import { loadSettings } from "./config";
import { OperationalLogger } from "./core/services/operational-logger";

const settings = loadSettings();
const { app, shutdown } = buildApp();
const logger = new OperationalLogger(settings);

const server = app.listen({
  port: settings.app.port,
  hostname: settings.app.host
});

await logger.logStartup({
  dspy_enabled: settings.dspy.enabled,
  trace_backend: settings.trace.backend
});

let stopping = false;

async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;

  await logger.logSystemError("shutdown", "process", new Error(`Received ${signal}`), {
    signal
  });

  await shutdown();
  if (typeof (server as { stop?: () => void }).stop === "function") {
    (server as { stop: () => void }).stop();
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  void stop("SIGTERM");
});

process.on("SIGINT", () => {
  void stop("SIGINT");
});
