import { describe, expect, it } from "vitest";
import { logConfigurationDiagnostics } from "../../src/config/configuration-logger.js";
import type { ConfigDiagnostics } from "../../src/config/env.js";

describe("logConfigurationDiagnostics", () => {
  it("eksik .env ve defaults kullanımını değerleri sızdırmadan uyarır", () => {
    const info: string[] = [];
    const warnings: string[] = [];
    const diagnostics: ConfigDiagnostics = {
      envFile: { path: "C:/project/.env", found: false },
      sources: {
        NODE_ENV: "default",
        API_HOST: "default",
        API_PORT: "process_environment",
        API_VERSION: "default",
        LOG_LEVEL: "default",
        MONGODB_URI: "default",
        MONGODB_DATABASE: "default",
        AUTH_TOKEN_SECRET: "default",
        CORS_ORIGIN: "default"
      },
      defaultedKeys: ["NODE_ENV", "API_HOST", "API_VERSION", "LOG_LEVEL", "MONGODB_URI", "MONGODB_DATABASE", "AUTH_TOKEN_SECRET", "CORS_ORIGIN"]
    };

    logConfigurationDiagnostics(diagnostics, {
      info: (message) => info.push(message),
      warn: (message) => warnings.push(message)
    });

    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("configuration.env_file_missing");
    expect(warnings.join(" ")).toContain("configuration.defaults_in_use");
    expect(info).toHaveLength(1);
    expect(JSON.parse(info[0] ?? "{}").sources.API_PORT).toBe("process_environment");
  });
});
