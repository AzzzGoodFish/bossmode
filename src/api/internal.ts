// Internal API routes — tool callback endpoint for agent runtimes
import { addRoute, sendJson, parseBody } from "./index.js";
import { handleToolCallback as runToolCallback } from "../engine/tools.js";
import { logger } from "../foundation/logger.js";
import * as sessionStore from "../workspace/session-store.js";

export async function handleToolCallback(
  tool: string,
  room: string,
  agent: string,
  params: Record<string, any>,
): Promise<unknown> {
  return runToolCallback(tool, room, agent, params);
}

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

addRoute("POST", "/internal/session-hook", async (req, res) => {
  const body = (await parseBody(req)) as {
    session_id?: string;
    roomId?: string;
    agentName?: string;
  };

  if (!body.session_id || !body.roomId || !body.agentName) {
    sendJson(res, 400, { error: "session_id, roomId, agentName required" });
    return;
  }

  sessionStore.saveSession(body.roomId, body.agentName, {
    runtime: "claude-cli",
    sessionId: body.session_id,
  });

  sendJson(res, 200, { ok: true });
});
