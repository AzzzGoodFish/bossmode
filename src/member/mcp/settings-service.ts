import { getDatabase } from "../../data/database.js";
import { readConfig, writeConfig } from "../../config/config.js";
import { parseMcpConfigText, readMcpConfigText, restoreRedactedMcpConfig, writeMcpConfig, countMcpServers } from "./mcp-settings.js";

export class SettingsValidationError extends Error {}
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
