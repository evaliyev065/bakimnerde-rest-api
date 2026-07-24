import { createApp } from "./app.js";
import { createContainer } from "./bootstrap/container.js";
import { logConfigurationDiagnostics } from "./config/configuration-logger.js";
import { loadConfig } from "./config/env.js";

const loadedConfiguration = loadConfig();
logConfigurationDiagnostics(loadedConfiguration.diagnostics);
const { config } = loadedConfiguration;
const container = createContainer(config);
const app = createApp(config, container);
const server = app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    level: "info",
    event: "api.started",
    host: config.host,
    port: config.port,
    environment: config.environment,
    apiVersion: config.apiVersion
  }));
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: "info", event: "api.stopping", signal }));
  server.close(async (error) => {
    if (error) {
      console.error(JSON.stringify({ level: "error", event: "api.stop_failed" }));
      process.exitCode = 1;
      return;
    }
    await container.database.close();
    console.log(JSON.stringify({ level: "info", event: "api.stopped" }));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
