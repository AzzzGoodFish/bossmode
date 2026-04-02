import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { BossmodeConfig } from "./types.js";
import { logger } from "../foundation/logger.js";

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

// Seed from templates on first run
export function seedTemplates(distDir: string): void {
  // distDir is e.g. dist/server — templates live at repo root
  let templatesDir = join(distDir, "../templates");
  if (!existsSync(templatesDir)) {
    templatesDir = join(distDir, "../../templates");
  }
  if (!existsSync(templatesDir)) return;

  const agentsDir = join(BOSSMODE_DIR, "agents");
  const skillsDir = join(BOSSMODE_DIR, "skills");

  // Agents: per-file check — skip existing, seed missing
  const agentsSrc = join(templatesDir, "agents");
  if (existsSync(agentsSrc)) {
    mkdirSync(agentsDir, { recursive: true });
    let seeded = 0;
    for (const f of readdirSync(agentsSrc).filter((f) => f.endsWith(".md"))) {
      const dest = join(agentsDir, f);
      if (!existsSync(dest)) {
        copyFileSync(join(agentsSrc, f), dest);
        seeded++;
      }
    }
    if (seeded > 0) {
      logger.info("seed", `seeded ${seeded} missing agent template(s)`);
    }
  }

  // Skills: per-directory check — skip existing, seed missing
  const skillsSrc = join(templatesDir, "skills");
  if (existsSync(skillsSrc)) {
    mkdirSync(skillsDir, { recursive: true });
    let seeded = 0;
    for (const d of readdirSync(skillsSrc)) {
      const dest = join(skillsDir, d);
      if (!existsSync(dest)) {
        cpSync(join(skillsSrc, d), dest, { recursive: true });
        seeded++;
      }
    }
    if (seeded > 0) {
      logger.info("seed", `seeded ${seeded} missing skill template(s)`);
    }
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
  return JSON.parse(raw) as BossmodeConfig;
}

export function writeConfig(config: BossmodeConfig): void {
  ensureBossmodeDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
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
