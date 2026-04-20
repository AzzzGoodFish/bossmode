// Engine API routes — Runtime status/capabilities
import { addRoute, sendJson, parseBody } from "./index.js";
import { getRegistry } from "../engine/agent-manager.js";
import { readConfig, writeConfig } from "../shared/config.js";

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

// GET /api/settings/runtime — runtime behavior settings
addRoute("GET", "/api/settings/runtime", async (_req, res) => {
  try {
    const config = readConfig();
    sendJson(res, 200, {
      sessionResume: config.runtime?.sessionResume !== false,
    });
  } catch {
    sendJson(res, 200, { sessionResume: true });
  }
});

// PUT /api/settings/runtime — update runtime behavior settings
addRoute("PUT", "/api/settings/runtime", async (req, res) => {
  const body = (await parseBody(req)) as { sessionResume?: boolean };
  try {
    const config = readConfig();
    config.runtime = {
      ...(config.runtime || {}),
      sessionResume: body.sessionResume !== false,
    };
    writeConfig(config);
    sendJson(res, 200, config.runtime);
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});
