// MCP Settings API — Bossmode-managed pi-mcp-adapter config
import { existsSync } from "node:fs";
import { addRoute, parseBody, sendJson } from "./index.js";
import { readConfig, writeConfig } from "../shared/config.js";
import {
  countMcpServers,
  getBossmodeMcpConfigPath,
  parseMcpConfigText,
  readRedactedMcpConfigText,
  writeMcpConfig,
} from "../shared/mcp-settings.js";

function mcpStatus(enabled: boolean) {
  const configPath = getBossmodeMcpConfigPath();
  const redacted = readRedactedMcpConfigText();
  return {
    enabled,
    configPath,
    configText: redacted.configText,
    serverCount: redacted.serverCount,
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

addRoute("PUT", "/api/settings/mcp", async (req, res) => {
  const body = (await parseBody(req)) as { enabled?: boolean; configText?: string };
  try {
    let parsedConfig: Record<string, unknown> | undefined;
    if (body.configText !== undefined) {
      parsedConfig = parseMcpConfigText(body.configText);
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
