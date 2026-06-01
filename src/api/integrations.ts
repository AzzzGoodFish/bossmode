import { addRoute, parseBody, sendJson } from "./index.js";
import { LinearClient } from "../integrations/linear-client.js";
import { clearLinearApiKey, getLinearApiKey, setLinearApiKey } from "../integrations/linear-settings.js";
import { clearLinearIntegrationsForAllRooms } from "../workspace/room-store.js";

async function linearSummary(apiKey: string) {
  const viewer = await new LinearClient(apiKey).viewer();
  return { connected: true, viewer };
}

addRoute("GET", "/api/integrations/linear", async (_req, res) => {
  const apiKey = getLinearApiKey();
  if (!apiKey) { sendJson(res, 200, { connected: false }); return; }
  try { sendJson(res, 200, await linearSummary(apiKey)); }
  catch (err: any) { sendJson(res, 200, { connected: false, error: err.message || String(err) }); }
});

addRoute("PUT", "/api/integrations/linear", async (req, res) => {
  const body = (await parseBody(req)) as any;
  const apiKey = String(body?.apiKey || "").trim();
  if (!apiKey) { sendJson(res, 400, { error: "apiKey is required" }); return; }
  try {
    const summary = await linearSummary(apiKey);
    setLinearApiKey(apiKey);
    sendJson(res, 200, summary);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

addRoute("DELETE", "/api/integrations/linear", async (_req, res) => {
  clearLinearApiKey();
  const clearedRooms = clearLinearIntegrationsForAllRooms();
  sendJson(res, 200, { ok: true, clearedRooms });
});
