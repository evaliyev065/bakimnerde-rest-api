import type { ConfigDiagnostics } from "./env.js";

export interface ConfigurationLogger {
  info(message: string): void;
  warn(message: string): void;
}

export function logConfigurationDiagnostics(
  diagnostics: ConfigDiagnostics,
  logger: ConfigurationLogger = console
): void {
  if (!diagnostics.envFile.found) {
    logger.warn(JSON.stringify({
      level: "warn",
      event: "configuration.env_file_missing",
      message: ".env dosyası bulunamadı; tanımlanmayan ayarlar development varsayılanlarını kullanacak.",
      path: diagnostics.envFile.path
    }));
  }

  if (diagnostics.defaultedKeys.length > 0) {
    logger.warn(JSON.stringify({
      level: "warn",
      event: "configuration.defaults_in_use",
      message: "Bazı ayarlar yerleşik development varsayılanlarından alındı.",
      keys: diagnostics.defaultedKeys
    }));
  }

  logger.info(JSON.stringify({
    level: "info",
    event: "configuration.loaded",
    envFile: diagnostics.envFile,
    sources: diagnostics.sources
  }));
}
