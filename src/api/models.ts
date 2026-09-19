import { addRoute, HttpError, parseBody, requestValue, sendJson } from "./http.js";
import { invalidateModelCredentialProfile } from "../agent/controls.js";
import { cancelOAuthLoginJob, getOAuthLoginJob, startNativeOAuthConnection, submitOAuthLoginJobInput } from "../config/oauth.js";
import { connectBuiltinProviderApiKey, deleteModelCredentialProfile, discoverModelCredentialModels, getModelCredentialProfile, listAvailableModels, listPublicModelCredentialProfiles, refreshBuiltinCatalog, saveModelCredentialProfile } from "../config/models.js";
import { getCatalogAutoRefreshIntervalDays, getCatalogSettingsPublic, listBuiltinModelProviders, setCatalogAutoRefreshIntervalDays } from "../config/catalog.js";

async function body(request: Parameters<typeof parseBody>[0]): Promise<any> {
  return parseBody(request);
}
async function ok(response: Parameters<typeof sendJson>[0], action: () => unknown | Promise<unknown>): Promise<void> {
  sendJson(response, 200, await requestValue(action));
}
function oauthJob(id: string) {
  const job = getOAuthLoginJob(id);
  if (!job) throw new HttpError(404, "not_found", "OAuth login job not found");
  return job;
}
async function saveProfile(input: any): Promise<unknown> {
  const profile = saveModelCredentialProfile(input);
  await invalidateModelCredentialProfile(profile.id, profile.providerSlug, "profileUpdated");
  return profile;
}

addRoute("GET", "/api/model-provider-catalog", async (_request, response) => {
  sendJson(response, 200, listBuiltinModelProviders());
});
addRoute("GET", "/api/model-credential-profiles", async (_request, response) => {
  sendJson(response, 200, listPublicModelCredentialProfiles());
});
addRoute("POST", "/api/model-credential-profiles/connect-api-key", async (request, response) => {
  await ok(response, async () => {
    const profile = connectBuiltinProviderApiKey(await body(request));
    await invalidateModelCredentialProfile(profile.id, profile.providerSlug, "profileUpdated");
    return profile;
  });
});
addRoute("POST", "/api/model-credential-profiles", async (request, response) => {
  await ok(response, async () => saveProfile(await body(request)));
});
addRoute("PUT", "/api/model-credential-profiles/:id", async (request, response, params) => {
  await ok(response, async () => saveProfile({ ...await body(request), id: params.id }));
});
addRoute("POST", "/api/model-credential-profiles/discover-models", async (request, response) => {
  await ok(response, async () => discoverModelCredentialModels(await body(request)));
});
addRoute("POST", "/api/model-credential-profiles/oauth/start", async (request, response) => {
  await ok(response, async () => startNativeOAuthConnection(await body(request)));
});
const oauthPath = "/api/model-credential-profiles/oauth/:id";
addRoute("GET", oauthPath, async (_request, response, params) => { sendJson(response, 200, oauthJob(params.id)); });
addRoute("POST", `${oauthPath}/input`, async (request, response, params) => {
  await ok(response, async () => await submitOAuthLoginJobInput(params.id, await body(request)) || oauthJob(params.id));
});
addRoute("POST", `${oauthPath}/cancel`, async (_request, response, params) => {
  sendJson(response, 200, cancelOAuthLoginJob(params.id) || oauthJob(params.id));
});
addRoute("DELETE", "/api/model-credential-profiles/:id", async (_request, response, params) => {
  const profile = getModelCredentialProfile(params.id);
  if (!deleteModelCredentialProfile(params.id)) throw new HttpError(404, "not_found", "Model credential profile not found");
  if (profile) await invalidateModelCredentialProfile(profile.id, profile.providerSlug, "profileDeleted");
  sendJson(response, 200, { ok: true });
});
addRoute("GET", "/api/available-models", async (_request, response) => {
  sendJson(response, 200, listAvailableModels());
});
addRoute("GET", "/api/model-catalog/status", async (_request, response) => {
  const settings = getCatalogSettingsPublic();
  sendJson(response, 200, { ...settings.status, autoRefreshIntervalDays: settings.autoRefreshIntervalDays, refreshDue: settings.refreshDue });
});
addRoute("PUT", "/api/model-catalog/settings", async (request, response) => {
  await ok(response, async () => {
    const input = await body(request);
    if (input.autoRefreshIntervalDays == null) throw new HttpError(400, "invalid_request", "autoRefreshIntervalDays is required (number, 0 = off)");
    const previous = getCatalogAutoRefreshIntervalDays();
    const current = setCatalogAutoRefreshIntervalDays(Number(input.autoRefreshIntervalDays));
    if (current > 0 && current !== previous) void refreshBuiltinCatalog("settings-changed").catch(() => {});
    return getCatalogSettingsPublic();
  });
});
addRoute("POST", "/api/model-catalog/refresh", async (_request, response) => {
  await ok(response, async () => refreshBuiltinCatalog("manual"));
});
