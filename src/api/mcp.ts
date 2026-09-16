// MCP Settings API — Bossmode-managed pi-mcp-adapter config
import { getDatabase } from "../data/database.js";
import { updateMcpSettings, SettingsValidationError } from "../services/settings-service.js";
import { addRoute, parseBody, sendJson } from "./index.js";
import { readConfig } from "../config/config.js";
import {
  configFingerprint,
  getMcpServersObject,
  listMcpServers,
  parseMcpConfigText,
  readMcpConfigText,
  readMcpStatusCache,
  readRedactedMcpConfigText,
  writeMcpStatusCache,
} from "../shared/mcp-settings.js";
import { checkMcpServerAvailability } from "../agent/tools/mcp-availability.js";
import { getRoomMembers, listRooms } from "../chat/room-store.js";

function assignedServerCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const room of listRooms()) {
    const roomMembers = getRoomMembers(room.id);
    if (roomMembers.length > 0) {
      for (const member of roomMembers) {
        for (const name of member.config?.mcpServers || []) counts[name] = (counts[name] || 0) + 1;
      }
    } else {
      for (const override of Object.values(room.memberOverrides || {})) {
        for (const name of override.mcpServers || []) counts[name] = (counts[name] || 0) + 1;
      }
    }
  }
  return counts;
}

function readParsedMcpConfig(): Record<string, unknown> {
  return parseMcpConfigText(readMcpConfigText());
}

function mcpStatus(enabled: boolean) {
  const configPath = getDatabase().path;
  const redacted = readRedactedMcpConfigText();
  const parsed = readParsedMcpConfig();
  const availability = readMcpStatusCache();
  const servers = listMcpServers(parsed, availability, assignedServerCounts());
  return {
    enabled,
    configPath,
    configText: redacted.configText,
    serverCount: redacted.serverCount,
    servers,
    availability: Object.fromEntries(servers.map((server) => [server.name, server.availability])),
    sources: [
      {
        id: "bossmode-global",
        label: "Bossmode database",
        path: configPath,
        exists: redacted.exists,
        serverCount: redacted.serverCount,
      },
    ],
  };
}

addRoute("GET", "/api/settings/mcp", async (_req, res) => {
  try {
    const config = readConfig();
    sendJson(res, 200, mcpStatus(config.mcp?.enabled === true));
  } catch (err: any) {
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

addRoute("POST", "/api/settings/mcp/check", async (req, res) => {
  const body = (await parseBody(req)) as { server?: string; timeoutMs?: number };
  try {
    const parsed = readParsedMcpConfig();
    const servers = getMcpServersObject(parsed);
    const names = typeof body.server === "string" && body.server.trim() ? [body.server.trim()] : Object.keys(servers);
    const timeoutMs = typeof body.timeoutMs === "number" && Number.isFinite(body.timeoutMs) ? Math.max(1000, Math.min(30000, body.timeoutMs)) : undefined;
    const cache = readMcpStatusCache();
    const results = [];
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(servers, name)) {
        results.push({ name, status: "invalid-config" as const, checkedAt: Date.now(), error: "MCP server not found" });
        continue;
      }
      const result = await checkMcpServerAvailability(name, servers[name], timeoutMs);
      cache[name] = { ...result, configHash: configFingerprint(servers[name]) };
      results.push(result);
    }
    writeMcpStatusCache(cache);
    sendJson(res, 200, { results, ...mcpStatus(readConfig().mcp?.enabled === true) });
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

addRoute("PUT", "/api/settings/mcp", async (req, res) => {
  const body = (await parseBody(req)) as { enabled?: boolean; configText?: string };
  try {
    const result = updateMcpSettings(body);
    sendJson(res, 200, {...mcpStatus(result.enabled), ...(result.savedServerCount !== undefined ? {savedServerCount: result.savedServerCount} : {})});
  } catch (error) {
    sendJson(res, error instanceof SettingsValidationError ? 400 : 500, {error: error instanceof SettingsValidationError ? error.message : "Unable to update MCP settings"});
  }
});
