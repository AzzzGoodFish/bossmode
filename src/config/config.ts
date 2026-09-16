import { getDatabase } from "../data/database.js";
import { SettingsRepository } from "../data/repositories/settings.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BossmodeConfig } from "../kernel/types.js";

const BOSSMODE_DIR = process.env.BOSSMODE_DIR || join(homedir(), ".bossmode");
const CONFIG_PATH = join(BOSSMODE_DIR, "config.json");

export function getBossmodeDir(): string {
  return BOSSMODE_DIR;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function ensureBossmodeDir(): void {
  if (!existsSync(BOSSMODE_DIR)) {
    mkdirSync(BOSSMODE_DIR, { recursive: true });
  }
}

export function configExists(): boolean { return new SettingsRepository(getDatabase()).exists(); }

export function readConfig(): BossmodeConfig {
  const config = new SettingsRepository(getDatabase()).read();
  if (!config) throw new Error("Application configuration is not initialized");
  return config;
}

export function writeConfig(config: BossmodeConfig): void {
  new SettingsRepository(getDatabase()).importConfig(config);
}

// Password hashing moved to api/auth-service.ts (P9).

// API key resolution: env var first, config fallback
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

// PID file management moved to app/pid.ts (P9).
