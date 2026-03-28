// Engine API routes — Runtime status/capabilities
import { addRoute, sendJson } from "./index.js";
import { getRegistry } from "../engine/agent-manager.js";

// GET /api/capabilities — runtime capabilities
addRoute("GET", "/api/capabilities", async (_req, res) => {
  const reg = getRegistry();
  if (!reg) {
    sendJson(res, 200, { runtimes: {} });
    return;
  }
  sendJson(res, 200, {
    runtimes: reg.getCapabilities(),
  });
});

// GET /api/runtimes — runtime detect results
addRoute("GET", "/api/runtimes", async (_req, res) => {
  const reg = getRegistry();
  if (!reg) { sendJson(res, 200, []); return; }
  const results = [];
  for (const rt of reg.getAll()) {
    const detect = await rt.detect();
    results.push({ name: rt.name, ...detect, capabilities: rt.capabilities });
  }
  sendJson(res, 200, results);
});
