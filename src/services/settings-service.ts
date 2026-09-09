import { getDatabase } from "../storage/database.js";
import { readConfig, writeConfig } from "../shared/config.js";
import { parseMcpConfigText, readMcpConfigText, restoreRedactedMcpConfig, writeMcpConfig, countMcpServers } from "../shared/mcp-settings.js";
import type { PiTransportSetting } from "../shared/types.js";

export class SettingsValidationError extends Error {}
const transports = new Set<PiTransportSetting>(["auto", "websocket", "websocket-cached", "sse"]);
export interface RuntimeSettingsPatch {
  sessionResume?: boolean;
  topicSeedMode?: "fork" | "fresh";
  codexTransport?: PiTransportSetting;
  websocketConnectTimeoutMs?: number | null;
  httpIdleTimeoutMs?: number | null;
}
export function normalizeRuntimeSettings(runtime: any = {}) {
  const transport = transports.has(runtime.codexTransport) ? runtime.codexTransport : "auto";
  const websocketConnectTimeoutMs = typeof runtime.websocketConnectTimeoutMs === "number" && Number.isFinite(runtime.websocketConnectTimeoutMs) && runtime.websocketConnectTimeoutMs >= 0 ? Math.floor(runtime.websocketConnectTimeoutMs) : 15000;
  const httpIdleTimeoutMs = typeof runtime.httpIdleTimeoutMs === "number" && Number.isFinite(runtime.httpIdleTimeoutMs) && runtime.httpIdleTimeoutMs >= 0 ? Math.floor(runtime.httpIdleTimeoutMs) : undefined;
  return { sessionResume: runtime.sessionResume !== false, topicSeedMode: runtime.topicSeedMode === "fresh" ? "fresh" : "fork", codexTransport: transport, websocketConnectTimeoutMs, ...(httpIdleTimeoutMs !== undefined ? {httpIdleTimeoutMs} : {}) };
}
export function updateRuntimeSettings(body: RuntimeSettingsPatch) {
  if (body.sessionResume !== undefined && typeof body.sessionResume !== "boolean") throw new SettingsValidationError("Invalid sessionResume");
  if (body.topicSeedMode !== undefined && body.topicSeedMode !== "fork" && body.topicSeedMode !== "fresh") throw new SettingsValidationError("Invalid topicSeedMode");
  if (body.codexTransport !== undefined && !transports.has(body.codexTransport)) throw new SettingsValidationError("Invalid codexTransport");
  for (const field of ["websocketConnectTimeoutMs", "httpIdleTimeoutMs"] as const) {
    const value = body[field];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new SettingsValidationError(`Invalid ${field}`);
  }
  return getDatabase().transaction(() => {
    const config = readConfig();
    const runtime = {...config.runtime, sessionResume: config.runtime?.sessionResume !== false};
    for (const field of ["sessionResume", "topicSeedMode", "codexTransport"] as const) if (body[field] !== undefined) (runtime as any)[field] = body[field];
    for (const field of ["websocketConnectTimeoutMs", "httpIdleTimeoutMs"] as const) {
      if (body[field] === null) delete runtime[field];
      else if (body[field] !== undefined) runtime[field] = Math.floor(body[field]!);
    }
    config.runtime = runtime;
    writeConfig(config);
    return normalizeRuntimeSettings(runtime);
  });
}
export function updateMcpSettings(body: {enabled?: boolean; configText?: string}): {enabled: boolean; savedServerCount?: number} {
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new SettingsValidationError("Invalid MCP enabled state");
  let submitted: Record<string, unknown> | undefined;
  if (body.configText !== undefined) {
    if (typeof body.configText !== "string") throw new SettingsValidationError("Invalid MCP configuration");
    try { submitted = parseMcpConfigText(body.configText); }
    catch { throw new SettingsValidationError("Invalid MCP configuration"); }
  }
  return getDatabase().transaction(() => {
    // Existing secrets and enabled state are read in the same snapshot as writes.
    const config = readConfig();
    let serverCount: number | undefined;
    if (submitted !== undefined) {
      const restored = restoreRedactedMcpConfig(submitted, parseMcpConfigText(readMcpConfigText())) as Record<string,unknown>;
      writeMcpConfig(restored); serverCount = countMcpServers(restored);
    }
    config.mcp = {...config.mcp, enabled: body.enabled ?? config.mcp?.enabled === true};
    writeConfig(config);
    return {enabled: config.mcp.enabled, ...(serverCount !== undefined ? {savedServerCount: serverCount} : {})};
  });
}
