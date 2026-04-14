import { buildApp } from "./app";
import { loadSettings } from "./config";
import { OperationalLogger } from "./core/services/operational-logger";

const settings = loadSettings();
const app = buildApp();
const logger = new OperationalLogger(settings);

app.listen({
  port: settings.app.port,
  hostname: settings.app.host
});

await logger.logStartup({
  dspy_enabled: settings.dspy.enabled,
  trace_backend: settings.trace.backend
});
