// Internal API routes — tool callback endpoint for agent runtimes
import { addRoute, sendJson, parseBody } from "./index.js";
import { handleToolCallback } from "../engine/tools.js";
import { logger } from "../foundation/logger.js";

addRoute("POST", "/internal/tool-callback", async (req, res) => {
  // No auth — internal only, called by pi extension / claude MCP server
  const body = (await parseBody(req)) as {
    tool?: string; room?: string; agent?: string; params?: Record<string, any>;
  };

  if (!body.tool || !body.room || !body.agent) {
    sendJson(res, 400, { error: "tool, room, agent required" });
    return;
  }

  try {
    const result = await handleToolCallback(body.tool, body.room, body.agent, body.params || {});
    sendJson(res, 200, result);
  } catch (err: any) {
    logger.error("callback", "tool-callback error", { tool: body.tool, error: String(err) });
    sendJson(res, 400, { error: err.message || String(err) });
  }
});
