import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BossmodeConfig } from "./types.js";

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

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

export function readConfig(): BossmodeConfig {
  if (!configExists()) {
    throw new Error(`Config not found at ${CONFIG_PATH}. Run 'bossmode on' to set up.`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw) as BossmodeConfig & { sessionResume?: boolean };
  // Backward compatibility: old config.json files may not have runtime.sessionResume
  const legacySessionResume = parsed.sessionResume;
  parsed.runtime = {
    ...(parsed.runtime || {}),
    sessionResume: (parsed.runtime?.sessionResume ?? legacySessionResume) !== false,
  };
  return parsed;
}

export function writeConfig(config: BossmodeConfig): void {
  ensureBossmodeDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort */ }
}

// Password hashing: SHA-256 with salt
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expectedHash] = stored.split(":");
  if (!salt || !expectedHash) return false;
  const hash = createHash("sha256").update(salt + password).digest("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// API key resolution: env var first, config fallback
export function resolveApiKey(provider: string, config?: BossmodeConfig): string | undefined {
  const envKey = `${provider.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envKey];
  if (fromEnv) return fromEnv;

  if (config) {
    return config.apiKeys[provider];
  }

  try {
    const cfg = readConfig();
    return cfg.apiKeys[provider];
  } catch {
    return undefined;
  }
}

export function getDefaultConfig(): BossmodeConfig {
  return {
    auth: { username: "", passwordHash: "" },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: 8080 },
    runtime: { sessionResume: true, codexTransport: "auto", websocketConnectTimeoutMs: 60000 },
    mcp: { enabled: false },
  };
}

// PID file management
const PID_PATH = join(BOSSMODE_DIR, "bossmode.pid");

export function writePidFile(pid: number): void {
  ensureBossmodeDir();
  writeFileSync(PID_PATH, String(pid), "utf-8");
}

export function readPidFile(): number | null {
  try {
    const raw = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    // ignore
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
