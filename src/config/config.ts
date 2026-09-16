import { getDatabase } from "../data/database.js";
import { SettingsRepository } from "../data/repositories/settings.js";
import type { BossmodeConfig } from "../kernel/types.js";

export function configExists(): boolean { return new SettingsRepository(getDatabase()).exists(); }

export function readConfig(): BossmodeConfig {
  const config = new SettingsRepository(getDatabase()).read();
  if (!config) throw new Error("Application configuration is not initialized");
  return config;
}

export function writeConfig(config: BossmodeConfig): void {
  new SettingsRepository(getDatabase()).importConfig(config);
}

// API key resolution: env var first, config fallback.
export function resolveApiKey(provider: string, config?: BossmodeConfig): string | undefined {
  const envKey = `${provider.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;

  if (config) {
    return config.apiKeys[provider];
  }

  return readConfig().apiKeys[provider];
}

export function getDefaultConfig(): BossmodeConfig {
  return {
    auth: { username: "", passwordHash: "" },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: 8080 },
    mcp: { enabled: false },
  };
}
