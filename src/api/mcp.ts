// MCP Settings API — Bossmode-managed pi-mcp-adapter config
import { existsSync } from "node:fs";
import { addRoute, parseBody, sendJson } from "./index.js";
import { readConfig, writeConfig } from "../shared/config.js";
import {
  configFingerprint,
  countMcpServers,
  getBossmodeMcpConfigPath,
  getMcpServersObject,
  listMcpServers,
  parseMcpConfigText,
  readMcpConfigText,
  readMcpStatusCache,
  readRedactedMcpConfigText,
  restoreRedactedMcpConfig,
  writeMcpConfig,
  writeMcpStatusCache,
} from "../shared/mcp-settings.js";
import { checkMcpServerAvailability } from "../engine/mcp-availability.js";
import { listRooms } from "../workspace/room-store.js";

function assignedServerCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const room of listRooms()) {
    for (const override of Object.values(room.memberOverrides || {})) {
      for (const name of override.mcpServers || []) counts[name] = (counts[name] || 0) + 1;
    }
  }
  return counts;
}

function readParsedMcpConfig(): Record<string, unknown> {
  return parseMcpConfigText(readMcpConfigText());
}

function mcpStatus(enabled: boolean) {
  const configPath = getBossmodeMcpConfigPath();
  const redacted = readRedactedMcpConfigText();
  let parsed: Record<string, unknown> = { mcpServers: {} };
  try { parsed = readParsedMcpConfig(); } catch {}
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
        label: "Bossmode MCP config",
        path: configPath,
        exists: redacted.exists || existsSync(configPath),
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
    let parsedConfig: Record<string, unknown> | undefined;
    if (body.configText !== undefined) {
      const submittedConfig = parseMcpConfigText(body.configText);
      let existingConfig: Record<string, unknown> | undefined;
      try {
        existingConfig = parseMcpConfigText(readMcpConfigText());
      } catch {
        existingConfig = undefined;
      }
      parsedConfig = restoreRedactedMcpConfig(submittedConfig, existingConfig) as Record<string, unknown>;
    }

    const config = readConfig();
    config.mcp = {
      ...(config.mcp || { enabled: false }),
      enabled: body.enabled === undefined ? config.mcp?.enabled === true : body.enabled === true,
    };

    if (parsedConfig !== undefined) {
      writeMcpConfig(parsedConfig);
    }
    writeConfig(config);

    sendJson(res, 200, {
      ...mcpStatus(config.mcp.enabled),
      ...(parsedConfig !== undefined ? { savedServerCount: countMcpServers(parsedConfig) } : {}),
    });
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});
