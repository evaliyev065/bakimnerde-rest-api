import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotEnv } from "dotenv";

export type AppEnvironment = "development" | "test" | "production";

export interface AppConfig {
  readonly environment: AppEnvironment;
  readonly host: string;
  readonly port: number;
  readonly apiVersion: string;
  readonly logLevel: string;
  readonly mongodbUri: string;
  readonly mongodbDatabase: string;
  readonly authTokenSecret: string;
  readonly corsOrigin: string;
}

export const CONFIG_KEYS = [
  "NODE_ENV",
  "API_HOST",
  "API_PORT",
  "API_VERSION",
  "LOG_LEVEL",
  "MONGODB_URI",
  "MONGODB_DATABASE",
  "AUTH_TOKEN_SECRET",
  "CORS_ORIGIN"
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigValueSource = "process_environment" | "env_file" | "default";

export interface ConfigDiagnostics {
  readonly envFile: {
    readonly path: string;
    readonly found: boolean;
  };
  readonly sources: Readonly<Record<ConfigKey, ConfigValueSource>>;
  readonly defaultedKeys: readonly ConfigKey[];
}

export interface LoadedConfiguration {
  readonly config: AppConfig;
  readonly diagnostics: ConfigDiagnostics;
}

export interface LoadConfigOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function parsePort(rawValue: string | undefined): number {
  const port = Number(rawValue ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("API_PORT 1 ile 65535 arasında bir tam sayı olmalıdır.");
  }
  return port;
}

function parseEnvironment(rawValue: string | undefined): AppEnvironment {
  const value = rawValue ?? "development";
  if (value !== "development" && value !== "test" && value !== "production") {
    throw new Error("NODE_ENV development, test veya production olmalıdır.");
  }
  return value;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfiguration {
  const runtimeEnv = { ...(options.env ?? process.env) };
  const processEnvironmentKeys = new Set(Object.keys(runtimeEnv));
  const envFilePath = resolve(options.cwd ?? process.cwd(), ".env");
  const envFileFound = existsSync(envFilePath);
  const parsedKeys = new Set<string>();

  if (envFileFound) {
    const result = loadDotEnv({
      path: envFilePath,
      processEnv: runtimeEnv,
      override: false,
      quiet: true
    });
    if (result.error !== undefined) {
      throw new Error(`.env dosyası okunamadı: ${envFilePath}`, { cause: result.error });
    }
    Object.keys(result.parsed ?? {}).forEach((key) => parsedKeys.add(key));
  }

  const sources = Object.fromEntries(CONFIG_KEYS.map((key) => {
    const source: ConfigValueSource = processEnvironmentKeys.has(key)
      ? "process_environment"
      : parsedKeys.has(key)
        ? "env_file"
        : "default";
    return [key, source];
  })) as Record<ConfigKey, ConfigValueSource>;

  const config: AppConfig = {
    environment: parseEnvironment(runtimeEnv.NODE_ENV),
    host: runtimeEnv.API_HOST ?? "127.0.0.1",
    port: parsePort(runtimeEnv.API_PORT),
    apiVersion: runtimeEnv.API_VERSION ?? "1",
    logLevel: runtimeEnv.LOG_LEVEL ?? "info",
    mongodbUri: runtimeEnv.MONGODB_URI ?? "mongodb://127.0.0.1:27017",
    mongodbDatabase: runtimeEnv.MONGODB_DATABASE ?? "bakimnerde",
    authTokenSecret: runtimeEnv.AUTH_TOKEN_SECRET ?? "development-only-change-this-secret",
    corsOrigin: runtimeEnv.CORS_ORIGIN ?? "http://127.0.0.1:4173,http://127.0.0.1:4174,http://127.0.0.1:4175,http://localhost:4173,http://localhost:4174,http://localhost:4175,https://localhost"
  };

  return {
    config,
    diagnostics: {
      envFile: { path: envFilePath, found: envFileFound },
      sources,
      defaultedKeys: CONFIG_KEYS.filter((key) => sources[key] === "default")
    }
  };
}
