import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { getBossmodeDir } from "./config.js";
import type { McpServerAvailability, McpServerSummary } from "./types.js";

export const MCP_REDACTED_VALUE = "[REDACTED]";

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

export function getBossmodeMcpStatusPath(): string {
  return join(getBossmodeMcpDir(), "status.json");
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

export function getMcpServersObject(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const servers = (config as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

export function countMcpServers(config: unknown): number {
  return Object.keys(getMcpServersObject(config)).length;
}

export function getMcpServerNames(config: unknown): string[] {
  return Object.keys(getMcpServersObject(config));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_OBJECT_KEYS.has(key)) return MCP_REDACTED_VALUE;
  if (key && SECRET_KEY_RE.test(key)) return MCP_REDACTED_VALUE;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

export function redactMcpConfig(config: unknown): unknown {
  return redactValue(config);
}

export function restoreRedactedMcpConfig(submitted: unknown, existing: unknown): unknown {
  if (submitted === MCP_REDACTED_VALUE && existing !== undefined) return existing;
  if (Array.isArray(submitted)) {
    const existingArray = Array.isArray(existing) ? existing : [];
    return submitted.map((item, index) => restoreRedactedMcpConfig(item, existingArray[index]));
  }
  if (isRecord(submitted)) {
    const existingRecord = isRecord(existing) ? existing : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(submitted)) {
      out[key] = restoreRedactedMcpConfig(value, existingRecord[key]);
    }
    return out;
  }
  return submitted;
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

export function inferMcpServerTransport(entry: unknown): McpServerSummary["transport"] {
  if (!isRecord(entry)) return "invalid";
  if (typeof entry.url === "string" && entry.url.trim()) return "http";
  if (typeof entry.command === "string" && entry.command.trim()) return "stdio";
  return "invalid";
}

export function configFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

export function readMcpStatusCache(): Record<string, McpServerAvailability & { configHash?: string }> {
  const path = getBossmodeMcpStatusPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isRecord(parsed) ? parsed as Record<string, McpServerAvailability & { configHash?: string }> : {};
  } catch {
    return {};
  }
}

export function writeMcpStatusCache(cache: Record<string, McpServerAvailability & { configHash?: string }>): void {
  ensureBossmodeMcpDirs();
  const path = getBossmodeMcpStatusPath();
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

export function listMcpServers(config: unknown, availabilityCache: Record<string, McpServerAvailability & { configHash?: string }> = {}, assignedCounts: Record<string, number> = {}): McpServerSummary[] {
  const servers = getMcpServersObject(config);
  return Object.entries(servers).map(([name, entry]) => {
    const hash = configFingerprint(entry);
    const cached = availabilityCache[name]?.configHash === hash ? availabilityCache[name] : undefined;
    const availability = cached
      ? ({ name: cached.name, status: cached.status, checkedAt: cached.checkedAt, toolCount: cached.toolCount, resourceCount: cached.resourceCount, error: cached.error } satisfies McpServerAvailability)
      : ({ name, status: "unchecked" } satisfies McpServerAvailability);
    return {
      name,
      transport: inferMcpServerTransport(entry),
      assignedCount: assignedCounts[name] || 0,
      availability,
    };
  });
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "_";
}

export function filterMcpConfigForServers(config: unknown, serverNames: string[]): Record<string, unknown> {
  const servers = getMcpServersObject(config);
  const allowed = new Set(serverNames);
  const mcpServers: Record<string, unknown> = {};
  for (const name of getMcpServerNames(config)) {
    if (allowed.has(name)) mcpServers[name] = servers[name];
  }
  const out: Record<string, unknown> = { mcpServers };
  if (isRecord(config) && isRecord(config.settings)) out.settings = config.settings;
  return out;
}

export function writeScopedMcpConfig(args: { roomId: string; memberName: string; serverNames: string[]; config?: Record<string, unknown> }): { configPath: string; serverNames: string[] } {
  const config = args.config ?? parseMcpConfigText(readMcpConfigText());
  const validNames = getMcpServerNames(config).filter((name) => args.serverNames.includes(name));
  const scoped = filterMcpConfigForServers(config, validNames);
  const dir = join(getBossmodeMcpRuntimeDir(), "scopes", safeSegment(args.roomId), safeSegment(args.memberName));
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "mcp.json");
  writeFileSync(configPath, `${JSON.stringify(scoped, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch { /* best effort */ }
  return { configPath, serverNames: validNames };
}

function collectSecretLiterals(value: unknown, key?: string, out: string[] = []): string[] {
  if (typeof value === "string" && key && (SECRET_KEY_RE.test(key) || SECRET_OBJECT_KEYS.has(key))) out.push(value);
  if (Array.isArray(value)) value.forEach((item) => collectSecretLiterals(item, key, out));
  else if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) collectSecretLiterals(childValue, childKey, out);
  }
  return out;
}

export function sanitizeMcpError(error: unknown, serverConfig?: unknown): string {
  let text = error instanceof Error ? error.message : String(error ?? "Unknown MCP error");
  for (const secret of collectSecretLiterals(serverConfig)) {
    if (secret) text = text.split(secret).join(MCP_REDACTED_VALUE);
  }
  text = text.replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${MCP_REDACTED_VALUE}`);
  text = text.replace(/Authorization\s*[:=]\s*[^\n,;]+/gi, `Authorization: ${MCP_REDACTED_VALUE}`);
  return text.slice(0, 500);
}
