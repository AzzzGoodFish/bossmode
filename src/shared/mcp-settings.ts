import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "./config.js";

const SECRET_KEY_RE = /(?:token|secret|password|api[_-]?key|apikey|authorization|bearer)/i;
const SECRET_OBJECT_KEYS = new Set(["env", "headers"]);

export interface BossmodeMcpSettingsStatus {
  enabled: boolean;
  configPath: string;
  configText: string;
  serverCount: number;
  exists: boolean;
}

export function getBossmodeMcpDir(): string {
  return join(getBossmodeDir(), "mcp");
}

export function getBossmodeMcpConfigPath(): string {
  return join(getBossmodeMcpDir(), "mcp.json");
}

export function getBossmodeMcpRuntimeDir(): string {
  return join(getBossmodeMcpDir(), "runtime");
}

export function ensureBossmodeMcpDirs(): void {
  mkdirSync(getBossmodeMcpDir(), { recursive: true });
  mkdirSync(getBossmodeMcpRuntimeDir(), { recursive: true });
}

export function parseMcpConfigText(text: string): Record<string, unknown> {
  const normalized = text.trim() ? text : "{\n  \"mcpServers\": {}\n}";
  const parsed = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP config must be a JSON object");
  }
  const config = parsed as Record<string, unknown>;
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    throw new Error("MCP config mcpServers must be an object");
  }
  return config;
}

export function countMcpServers(config: unknown): number {
  if (!config || typeof config !== "object" || Array.isArray(config)) return 0;
  const servers = (config as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return 0;
  return Object.keys(servers).length;
}

export function readMcpConfigText(): string {
  const path = getBossmodeMcpConfigPath();
  if (!existsSync(path)) return "{\n  \"mcpServers\": {}\n}";
  return readFileSync(path, "utf-8");
}

export function writeMcpConfig(config: Record<string, unknown>): void {
  ensureBossmodeMcpDirs();
  const path = getBossmodeMcpConfigPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_OBJECT_KEYS.has(key)) return "[REDACTED]";
  if (key && SECRET_KEY_RE.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

export function redactMcpConfig(config: unknown): unknown {
  return redactValue(config);
}

export function readRedactedMcpConfigText(): { configText: string; serverCount: number; exists: boolean } {
  const path = getBossmodeMcpConfigPath();
  const exists = existsSync(path);
  const raw = readMcpConfigText();
  try {
    const parsed = parseMcpConfigText(raw);
    return {
      configText: `${JSON.stringify(redactMcpConfig(parsed), null, 2)}\n`,
      serverCount: countMcpServers(parsed),
      exists,
    };
  } catch {
    return { configText: raw, serverCount: 0, exists };
  }
}
