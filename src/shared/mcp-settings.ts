import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { getDatabase } from "../data/database.js";
import { McpSettingsRepository } from "../data/repositories/mcp-settings.js";
function repository(): McpSettingsRepository { return new McpSettingsRepository(getDatabase()); }
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getBossmodeDir } from "../config/config.js";
import type { McpServerAvailability, McpServerSummary } from "../kernel/types.js";

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
  return JSON.stringify(repository().read(), null, 2);
}

export function writeMcpConfig(config: Record<string, unknown>): void {
  repository().importConfig(parseMcpConfigText(JSON.stringify(config)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Classify credential flags without treating ordinary positional/option values as secrets. */
function credentialArgument(value: unknown): { flag: string; secret?: string } | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(-{1,2}[^=\s]+)(?:=([\s\S]*))?$/);
  if (!match) return null;
  const flag = match[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const secretFlag = /(?:^|[-_])(?:api[-_]?key|private[-_]?key|access[-_]?key|token|secret|password|passwd|authorization|bearer|credentials?)$/.test(flag);
  return secretFlag ? { flag: match[1], secret: match[2] } : null;
}

function mapArgumentSecrets(args: unknown[], replace: (secret: string) => string): unknown[] {
  let secretNext = false;
  return args.map(arg => {
    if (secretNext) {
      secretNext = false;
      return typeof arg === "string" ? replace(arg) : arg;
    }
    const credential = credentialArgument(arg);
    if (!credential) return arg;
    if (credential.secret !== undefined) return `${credential.flag}=${replace(credential.secret)}`;
    secretNext = true;
    return arg;
  });
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SECRET_OBJECT_KEYS.has(key)) return MCP_REDACTED_VALUE;
  if (key && SECRET_KEY_RE.test(key)) return MCP_REDACTED_VALUE;
  if (Array.isArray(value)) return (key === "args" ? mapArgumentSecrets(value, () => MCP_REDACTED_VALUE) : value).map((item) => redactValue(item));
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
  const submittedArg = credentialArgument(submitted);
  const existingArg = credentialArgument(existing);
  if (submittedArg?.secret === MCP_REDACTED_VALUE && existingArg?.flag === submittedArg.flag) return existing;
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
  const exists = repository().exists();
  const raw = readMcpConfigText();
  try {
    const parsed = parseMcpConfigText(raw);
    return {
      configText: `${JSON.stringify(redactMcpConfig(parsed), null, 2)}\n`,
      serverCount: countMcpServers(parsed),
      exists,
    };
  } catch {
    // Never return unredacted source text if presentation validation fails.
    return { configText: "{}", serverCount: 0, exists };
  }
}

export function inferMcpServerTransport(entry: unknown): McpServerSummary["transport"] {
  if (!isRecord(entry)) return "invalid";
  if (typeof entry.url === "string" && entry.url.trim()) {
    try {
      const url = new URL(entry.url);
      return url.protocol === "http:" || url.protocol === "https:" ? "http" : "invalid";
    } catch {
      return "invalid";
    }
  }
  if (typeof entry.command === "string" && entry.command.trim()) return "stdio";
  return "invalid";
}

export function isAssignableMcpServerConfig(entry: unknown): boolean {
  return inferMcpServerTransport(entry) !== "invalid";
}

export function getAssignableMcpServerNames(config: unknown): string[] {
  const servers = getMcpServersObject(config);
  return getMcpServerNames(config).filter((name) => isAssignableMcpServerConfig(servers[name]));
}

export function configFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

export function readMcpStatusCache(): Record<string, McpServerAvailability & { configHash?: string }> {
  return repository().status();
}

export function writeMcpStatusCache(cache: Record<string, McpServerAvailability & { configHash?: string }>): void {
  repository().importStatus(cache);
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

const DEFERRED_MCP_CAPABILITY_KEYS = new Set(["sampling", "samplingautoapprove", "elicitation", "directtools"]);

export function disableDeferredMcpCapabilities(value: unknown, key?: string): unknown {
  if (key && DEFERRED_MCP_CAPABILITY_KEYS.has(key.toLowerCase())) return false;
  if (Array.isArray(value)) return value.map((item) => disableDeferredMcpCapabilities(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = disableDeferredMcpCapabilities(childValue, childKey);
  }
  return out;
}

/** Legacy import path only; live member MCP configuration is database-owned. */
export function getMemberMcpConfigPath(memberId: string): string {
  return join(getBossmodeDir(), "members", safeSegment(memberId), "mcp.json");
}

export function readMemberMcpConfig(memberId: string): Record<string, unknown> | null {
  const repo = new McpSettingsRepository(getDatabase(), `member:${memberId}`);
  return repo.exists() ? repo.read() : null;
}

export function writeMemberMcpConfig(memberId: string, config: Record<string, unknown>): void {
  new McpSettingsRepository(getDatabase()).importMemberConfig(memberId, config);
}

export interface MaterializedMcpConfig { configPath: string; serverNames: string[]; dispose(): void }
/** Restricted derived adapter input. Caller disposes after adapter shutdown. */
function materializeMcpConfig(config: Record<string, unknown>, serverNames: string[]): MaterializedMcpConfig {
  const dir = mkdtempSync(join(tmpdir(), "bossmode-mcp-runtime-"));
  try {
    const configPath = join(dir, "mcp.json");
    writeFileSync(configPath, JSON.stringify(filterMcpConfigForServers(config, serverNames)), {mode: 0o600});
    return {configPath, serverNames, dispose: () => rmSync(dir, {recursive: true, force: true})};
  } catch (error) { rmSync(dir, {recursive: true, force: true}); throw error; }
}

export function writeMemberScopedMcpConfig(args: { roomId: string; memberId: string }): MaterializedMcpConfig {
  const config = readMemberMcpConfig(args.memberId) ?? {mcpServers: {}};
  return materializeMcpConfig(config, getAssignableMcpServerNames(config));
}

export function filterMcpConfigForServers(config: unknown, serverNames: string[]): Record<string, unknown> {
  const servers = getMcpServersObject(config);
  const allowed = new Set(serverNames);
  const mcpServers: Record<string, unknown> = {};
  for (const name of getMcpServerNames(config)) {
    if (allowed.has(name)) mcpServers[name] = disableDeferredMcpCapabilities(servers[name]);
  }
  const out: Record<string, unknown> = { mcpServers };
  if (isRecord(config) && isRecord(config.settings)) out.settings = disableDeferredMcpCapabilities(config.settings);
  return out;
}

export function writeScopedMcpConfig(args: { roomId: string; memberId?: string; memberName?: string; serverNames: string[]; config?: Record<string, unknown> }): MaterializedMcpConfig {
  const config = args.config ?? parseMcpConfigText(readMcpConfigText());
  const names = getAssignableMcpServerNames(config).filter(name => args.serverNames.includes(name));
  return materializeMcpConfig(config, names);
}

function collectSecretLiterals(value: unknown, key?: string, out: string[] = []): string[] {
  if (typeof value === "string" && key && (SECRET_KEY_RE.test(key) || SECRET_OBJECT_KEYS.has(key))) out.push(value);
  if (Array.isArray(value)) {
    if (key === "args") mapArgumentSecrets(value, secret => { out.push(secret); return secret; });
    value.forEach((item) => collectSecretLiterals(item, key, out));
  }
  else if (isRecord(value)) {
    for (const [childKey, childValue] of Object.entries(value)) collectSecretLiterals(childValue, key && SECRET_OBJECT_KEYS.has(key) ? key : childKey, out);
  }
  return out;
}

export function sanitizeMcpError(error: unknown, serverConfig?: unknown): string {
  let text = error instanceof Error ? error.message : String(error ?? "Unknown MCP error");
  for (const secret of collectSecretLiterals(serverConfig).sort((a, b) => b.length - a.length)) {
    if (secret) text = text.split(secret).join(MCP_REDACTED_VALUE);
  }
  text = text.replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${MCP_REDACTED_VALUE}`);
  text = text.replace(/Authorization\s*[:=]\s*[^\n,;]+/gi, `Authorization: ${MCP_REDACTED_VALUE}`);
  return text.slice(0, 500);
}
