import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "bakimnerde-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true, force: true });
  });
});

describe("loadConfig", () => {
  it(".env yokken varsayılanları ve kaynaklarını açıkça raporlar", () => {
    const loaded = loadConfig({ cwd: createTemporaryDirectory(), env: {} });

    expect(loaded.config).toEqual({
      environment: "development",
      host: "127.0.0.1",
      port: 3000,
      apiVersion: "1",
      logLevel: "info",
      mongodbUri: "mongodb://127.0.0.1:27017",
      mongodbDatabase: "bakimnerde",
      authTokenSecret: "development-only-change-this-secret",
      corsOrigin: "http://127.0.0.1:4173"
    });
    expect(loaded.diagnostics.envFile.found).toBe(false);
    expect(loaded.diagnostics.defaultedKeys).toEqual([
      "NODE_ENV",
      "API_HOST",
      "API_PORT",
      "API_VERSION",
      "LOG_LEVEL",
      "MONGODB_URI",
      "MONGODB_DATABASE",
      "AUTH_TOKEN_SECRET",
      "CORS_ORIGIN"
    ]);
  });

  it(".env üzerinden gelen anahtarları env_file olarak işaretler", () => {
    const cwd = createTemporaryDirectory();
    writeFileSync(join(cwd, ".env"), "API_PORT=4100\nLOG_LEVEL=debug\n", "utf8");

    const loaded = loadConfig({ cwd, env: {} });

    expect(loaded.config.port).toBe(4100);
    expect(loaded.config.logLevel).toBe("debug");
    expect(loaded.diagnostics.sources.API_PORT).toBe("env_file");
    expect(loaded.diagnostics.sources.LOG_LEVEL).toBe("env_file");
    expect(loaded.diagnostics.sources.API_HOST).toBe("default");
  });

  it("process environment değerine .env üzerinde öncelik verir", () => {
    const cwd = createTemporaryDirectory();
    writeFileSync(join(cwd, ".env"), "API_PORT=4100\n", "utf8");

    const loaded = loadConfig({ cwd, env: { API_PORT: "4200" } });

    expect(loaded.config.port).toBe(4200);
    expect(loaded.diagnostics.sources.API_PORT).toBe("process_environment");
  });

  it("geçersiz portu fail-fast reddeder", () => {
    expect(() => loadConfig({
      cwd: createTemporaryDirectory(),
      env: { API_PORT: "abc" }
    })).toThrow("API_PORT 1 ile 65535 arasında bir tam sayı olmalıdır.");
  });
});
