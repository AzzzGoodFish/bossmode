// Engine API routes — Runtime status/capabilities
import { addRoute, sendJson, parseBody } from "./index.js";
import {
  getRegistry,
  invalidateModelCredentialProfile,
} from "../engine/agent-manager.js";
import { readConfig, writeConfig } from "../shared/config.js";
import { getEnvironmentCommunicationAsset, saveEnvironmentCommunication, resetEnvironmentCommunication } from "../workspace/environment-communication-asset.js";
import { getMemoryBudgets, normalizeMemoryBudgetsInput } from "../workspace/memory-budgets.js";
import type { PiTransportSetting } from "../shared/types.js";
import {
  cancelOAuthLoginJob,
  connectBuiltinProviderApiKey,
  deleteModelCredentialProfile,
  discoverModelCredentialModels,
  getModelCredentialProfile,
  getOAuthLoginJob,
  listAvailableModels,
  listBuiltinModelProviders,
  listPublicModelCredentialProfiles,
  getCatalogStatus,
  getCatalogSettingsPublic,
  getCatalogAutoRefreshIntervalDays,
  setCatalogAutoRefreshIntervalDays,
  refreshBuiltinCatalog,
  refreshModelCredentialProfileModels,
  saveModelCredentialProfile,
  startNativeOAuthConnection,
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

// GET /api/model-provider-catalog — built-in provider catalog for Connect Provider flow
addRoute("GET", "/api/model-provider-catalog", async (_req, res) => {
  sendJson(res, 200, listBuiltinModelProviders());
});

async function connectApiKeyRoute(req: any, res: any): Promise<void> {
  try {
    const body = (await parseBody(req)) as any;
    const profile = connectBuiltinProviderApiKey(body);
    await invalidateModelCredentialProfile(profile.id, profile.providerSlug, "profileUpdated");
    sendJson(res, 200, profile);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("POST", "/api/model-credential-profiles/connect-api-key", connectApiKeyRoute);

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
    const profile = saveModelCredentialProfile(body);
    await invalidateModelCredentialProfile(profile.id, profile.providerSlug, "profileUpdated");
    sendJson(res, 200, profile);
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

addRoute("POST", "/api/model-credential-profiles/oauth/start", async (req, res) => {
  try {
    const body = (await parseBody(req)) as any;
    sendJson(res, 200, await startNativeOAuthConnection(body));
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

addRoute("POST", "/api/model-credential-profiles/oauth-login/start", startOAuthLoginRoute);
addRoute("POST", "/api/model-providers/oauth-login/start", startOAuthLoginRoute);

async function getOAuthLoginRoute(_req: any, res: any, params: Record<string, string>): Promise<void> {
  const job = getOAuthLoginJob(params.id);
  if (!job) { sendJson(res, 404, { error: "OAuth login job not found" }); return; }
  sendJson(res, 200, job);
}

addRoute("GET", "/api/model-credential-profiles/oauth/:id", getOAuthLoginRoute);
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

addRoute("POST", "/api/model-credential-profiles/oauth/:id/input", submitOAuthLoginInputRoute);
addRoute("POST", "/api/model-credential-profiles/oauth-login/:id/input", submitOAuthLoginInputRoute);
addRoute("POST", "/api/model-providers/oauth-login/:id/input", submitOAuthLoginInputRoute);

async function cancelOAuthLoginRoute(_req: any, res: any, params: Record<string, string>): Promise<void> {
  const job = cancelOAuthLoginJob(params.id);
  if (!job) { sendJson(res, 404, { error: "OAuth login job not found" }); return; }
  sendJson(res, 200, job);
}

addRoute("POST", "/api/model-credential-profiles/oauth/:id/cancel", cancelOAuthLoginRoute);
addRoute("POST", "/api/model-credential-profiles/oauth-login/:id/cancel", cancelOAuthLoginRoute);
addRoute("POST", "/api/model-providers/oauth-login/:id/cancel", cancelOAuthLoginRoute);

async function updateModelCredentialProfileRoute(req: any, res: any, params: Record<string, string>): Promise<void> {
  try {
    const body = (await parseBody(req)) as any;
    const profile = saveModelCredentialProfile({ ...body, id: params.id });
    await invalidateModelCredentialProfile(profile.id, profile.providerSlug, "profileUpdated");
    sendJson(res, 200, profile);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("PUT", "/api/model-credential-profiles/:id", updateModelCredentialProfileRoute);
addRoute("PUT", "/api/model-providers/:id", updateModelCredentialProfileRoute);

async function refreshModelCredentialProfileModelsRoute(_req: any, res: any, params: Record<string, string>): Promise<void> {
  try {
    const result = await refreshModelCredentialProfileModels(params.id);
    await invalidateModelCredentialProfile(result.profile.id, result.profile.providerSlug, "profileUpdated");
    sendJson(res, 200, result);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
}

addRoute("POST", "/api/model-credential-profiles/:id/refresh-models", refreshModelCredentialProfileModelsRoute);
addRoute("POST", "/api/model-providers/:id/refresh-models", refreshModelCredentialProfileModelsRoute);

async function deleteModelCredentialProfileRoute(_req: any, res: any, params: Record<string, string>): Promise<void> {
  const existing = getModelCredentialProfile(params.id);
  if (!deleteModelCredentialProfile(params.id)) {
    sendJson(res, 404, { error: "Model credential profile not found" });
    return;
  }
  if (existing) await invalidateModelCredentialProfile(existing.id, existing.providerSlug, "profileDeleted");
  sendJson(res, 200, { ok: true });
}

addRoute("DELETE", "/api/model-credential-profiles/:id", deleteModelCredentialProfileRoute);
addRoute("DELETE", "/api/model-providers/:id", deleteModelCredentialProfileRoute);

// GET /api/available-models — Bossmode-owned available model options for member picker
addRoute("GET", "/api/available-models", async (_req, res) => {
  sendJson(res, 200, listAvailableModels());
});

// GET /api/models — backward-compatible alias
addRoute("GET", "/api/models", async (_req, res) => {
  sendJson(res, 200, listAvailableModels());
});

// GET /api/model-catalog/status — CatalogStore freshness + auto-refresh settings
addRoute("GET", "/api/model-catalog/status", async (_req, res) => {
  const settings = getCatalogSettingsPublic();
  sendJson(res, 200, {
    source: settings.status.source,
    fetchedAt: settings.status.fetchedAt,
    fetchedAtIso: settings.status.fetchedAtIso,
    modelCount: settings.status.modelCount,
    freshnessLabel: settings.status.freshnessLabel,
    autoRefreshIntervalDays: settings.autoRefreshIntervalDays,
    refreshDue: settings.refreshDue,
  });
});

// PUT /api/model-catalog/settings — update auto-refresh interval; changing triggers async refresh
addRoute("PUT", "/api/model-catalog/settings", async (req, res) => {
  try {
    const body = (await parseBody(req)) as { autoRefreshIntervalDays?: number };
    if (body.autoRefreshIntervalDays === undefined || body.autoRefreshIntervalDays === null) {
      sendJson(res, 400, { error: "autoRefreshIntervalDays is required (number, 0 = off)" });
      return;
    }
    const prev = getCatalogAutoRefreshIntervalDays();
    const next = setCatalogAutoRefreshIntervalDays(Number(body.autoRefreshIntervalDays));
    // Changing the interval (and any save while auto-refresh is on) kicks an async refresh.
    if (next > 0 && next !== prev) {
      void refreshBuiltinCatalog("settings-changed").catch(() => {});
    }
    sendJson(res, 200, getCatalogSettingsPublic());
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

// POST /api/model-catalog/refresh — manual global sync of the built-in provider catalog
addRoute("POST", "/api/model-catalog/refresh", async (_req, res) => {
  try {
    const result = await refreshBuiltinCatalog("manual");
    sendJson(res, 200, result);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

const VALID_PI_TRANSPORTS = new Set<PiTransportSetting>(["auto", "websocket", "websocket-cached", "sse"]);

function normalizeRuntimeSettings(runtime: any = {}) {
  const transport = VALID_PI_TRANSPORTS.has(runtime.codexTransport) ? runtime.codexTransport : "auto";
  const websocketConnectTimeoutMs = typeof runtime.websocketConnectTimeoutMs === "number" && Number.isFinite(runtime.websocketConnectTimeoutMs) && runtime.websocketConnectTimeoutMs >= 0
    ? Math.floor(runtime.websocketConnectTimeoutMs)
    : 15000;
  const httpIdleTimeoutMs = typeof runtime.httpIdleTimeoutMs === "number" && Number.isFinite(runtime.httpIdleTimeoutMs) && runtime.httpIdleTimeoutMs >= 0
    ? Math.floor(runtime.httpIdleTimeoutMs)
    : undefined;
  return {
    sessionResume: runtime.sessionResume !== false,
    topicSeedMode: runtime.topicSeedMode === "fresh" ? "fresh" : "fork",
    codexTransport: transport,
    websocketConnectTimeoutMs,
    ...(httpIdleTimeoutMs !== undefined ? { httpIdleTimeoutMs } : {}),
  };
}

// GET /api/settings/runtime — runtime behavior settings
addRoute("GET", "/api/settings/runtime", async (_req, res) => {
  try {
    const config = readConfig();
    sendJson(res, 200, normalizeRuntimeSettings(config.runtime));
  } catch {
    sendJson(res, 200, normalizeRuntimeSettings());
  }
});

// PUT /api/settings/runtime — update runtime behavior settings
addRoute("PUT", "/api/settings/runtime", async (req, res) => {
  const body = (await parseBody(req)) as {
    sessionResume?: boolean;
    topicSeedMode?: "fork" | "fresh";
    codexTransport?: PiTransportSetting;
    websocketConnectTimeoutMs?: number | null;
    httpIdleTimeoutMs?: number | null;
  };
  try {
    const config = readConfig();
    const runtime = {
      ...(config.runtime || {}),
      sessionResume: body.sessionResume === undefined ? config.runtime?.sessionResume !== false : body.sessionResume !== false,
      topicSeedMode: (body.topicSeedMode === undefined
        ? config.runtime?.topicSeedMode === "fresh"
        : body.topicSeedMode === "fresh") ? "fresh" as const : "fork" as const,
    };
    if (body.codexTransport !== undefined) {
      if (!VALID_PI_TRANSPORTS.has(body.codexTransport)) {
        sendJson(res, 400, { error: "Invalid codexTransport" });
        return;
      }
      runtime.codexTransport = body.codexTransport;
    }
    for (const field of ["websocketConnectTimeoutMs", "httpIdleTimeoutMs"] as const) {
      if (body[field] !== undefined) {
        if (body[field] === null) {
          delete runtime[field];
          continue;
        }
        if (typeof body[field] !== "number" || !Number.isFinite(body[field]) || body[field] < 0) {
          sendJson(res, 400, { error: `Invalid ${field}` });
          return;
        }
        runtime[field] = Math.floor(body[field]);
      }
    }
    config.runtime = runtime;
    writeConfig(config);
    sendJson(res, 200, normalizeRuntimeSettings(config.runtime));
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// GET /api/settings/environment-communication — global user-editable prompt
// asset (0.20 experience ③). Returns current content + source + updatedAt.
addRoute("GET", "/api/settings/environment-communication", async (_req, res) => {
  try {
    sendJson(res, 200, getEnvironmentCommunicationAsset());
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// PUT /api/settings/environment-communication — materialize the user file.
addRoute("PUT", "/api/settings/environment-communication", async (req, res) => {
  try {
    const body = (await parseBody(req)) as { content?: unknown };
    if (typeof body?.content !== "string" || !body.content.trim()) {
      sendJson(res, 400, { error: "content is required and cannot be empty" });
      return;
    }
    sendJson(res, 200, saveEnvironmentCommunication(body.content));
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// DELETE /api/settings/environment-communication — restore the product default.
addRoute("DELETE", "/api/settings/environment-communication", async (_req, res) => {
  try {
    sendJson(res, 200, resetEnvironmentCommunication());
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// GET /api/settings/memory-budgets — memory asset character budgets
// (0.20 experience ①). Single source: memory-budgets module (config.json).
addRoute("GET", "/api/settings/memory-budgets", async (_req, res) => {
  try {
    sendJson(res, 200, getMemoryBudgets());
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// PUT /api/settings/memory-budgets — update one or more budgets.
addRoute("PUT", "/api/settings/memory-budgets", async (req, res) => {
  try {
    const body = (await parseBody(req)) as Record<string, unknown>;
    const next = normalizeMemoryBudgetsInput(body || {});
    const config = readConfig();
    config.memoryBudgets = next;
    writeConfig(config);
    sendJson(res, 200, next);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message });
  }
});
