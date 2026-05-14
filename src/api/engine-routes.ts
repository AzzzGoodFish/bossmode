// Engine API routes — Runtime status/capabilities
import { addRoute, sendJson, parseBody } from "./index.js";
import { getRegistry } from "../engine/agent-manager.js";
import { readConfig, writeConfig } from "../shared/config.js";
import {
  cancelOAuthLoginJob,
  deleteModelCredentialProfile,
  discoverModelCredentialModels,
  getOAuthLoginJob,
  listConfiguredModels,
  listPublicModelCredentialProfiles,
  saveModelCredentialProfile,
  startOAuthLoginJob,
  submitOAuthLoginJobInput,
} from "../engine/model-credentials.js";

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

// GET /api/model-credential-profiles — sanitized credential-backed model catalog profiles
addRoute("GET", "/api/model-credential-profiles", async (_req, res) => {
  sendJson(res, 200, listPublicModelCredentialProfiles());
});

// Backward-compatible alias while UI copy settles on Model Credentials.
addRoute("GET", "/api/model-providers", async (_req, res) => {
  sendJson(res, 200, listPublicModelCredentialProfiles());
});

async function createModelCredentialProfileRoute(req: any, res: any): Promise<void> {
  try {
    const body = (await parseBody(req)) as any;
    sendJson(res, 200, saveModelCredentialProfile(body));
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("POST", "/api/model-credential-profiles", createModelCredentialProfileRoute);
addRoute("POST", "/api/model-providers", createModelCredentialProfileRoute);

async function discoverModelsRoute(req: any, res: any): Promise<void> {
  try {
    const body = (await parseBody(req)) as any;
    sendJson(res, 200, await discoverModelCredentialModels(body));
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("POST", "/api/model-credential-profiles/discover-models", discoverModelsRoute);
addRoute("POST", "/api/model-providers/discover-models", discoverModelsRoute);

async function startOAuthLoginRoute(req: any, res: any): Promise<void> {
  try {
    const body = (await parseBody(req)) as any;
    sendJson(res, 200, await startOAuthLoginJob(body));
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("POST", "/api/model-credential-profiles/oauth-login/start", startOAuthLoginRoute);
addRoute("POST", "/api/model-providers/oauth-login/start", startOAuthLoginRoute);

async function getOAuthLoginRoute(_req: any, res: any, params: Record<string, string>): Promise<void> {
  const job = getOAuthLoginJob(params.id);
  if (!job) { sendJson(res, 404, { error: "OAuth login job not found" }); return; }
  sendJson(res, 200, job);
}

addRoute("GET", "/api/model-credential-profiles/oauth-login/:id", getOAuthLoginRoute);
addRoute("GET", "/api/model-providers/oauth-login/:id", getOAuthLoginRoute);

async function submitOAuthLoginInputRoute(req: any, res: any, params: Record<string, string>): Promise<void> {
  try {
    const body = (await parseBody(req)) as any;
    const job = await submitOAuthLoginJobInput(params.id, body);
    if (!job) { sendJson(res, 404, { error: "OAuth login job not found" }); return; }
    sendJson(res, 200, job);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("POST", "/api/model-credential-profiles/oauth-login/:id/input", submitOAuthLoginInputRoute);
addRoute("POST", "/api/model-providers/oauth-login/:id/input", submitOAuthLoginInputRoute);

async function cancelOAuthLoginRoute(_req: any, res: any, params: Record<string, string>): Promise<void> {
  const job = cancelOAuthLoginJob(params.id);
  if (!job) { sendJson(res, 404, { error: "OAuth login job not found" }); return; }
  sendJson(res, 200, job);
}

addRoute("POST", "/api/model-credential-profiles/oauth-login/:id/cancel", cancelOAuthLoginRoute);
addRoute("POST", "/api/model-providers/oauth-login/:id/cancel", cancelOAuthLoginRoute);

async function updateModelCredentialProfileRoute(req: any, res: any, params: Record<string, string>): Promise<void> {
  try {
    const body = (await parseBody(req)) as any;
    sendJson(res, 200, saveModelCredentialProfile({ ...body, id: params.id }));
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("PUT", "/api/model-credential-profiles/:id", updateModelCredentialProfileRoute);
addRoute("PUT", "/api/model-providers/:id", updateModelCredentialProfileRoute);

async function deleteModelCredentialProfileRoute(_req: any, res: any, params: Record<string, string>): Promise<void> {
  if (!deleteModelCredentialProfile(params.id)) {
    sendJson(res, 404, { error: "Model credential profile not found" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

addRoute("DELETE", "/api/model-credential-profiles/:id", deleteModelCredentialProfileRoute);
addRoute("DELETE", "/api/model-providers/:id", deleteModelCredentialProfileRoute);

// GET /api/models — credential-backed model options for member picker
addRoute("GET", "/api/models", async (_req, res) => {
  sendJson(res, 200, listConfiguredModels());
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
