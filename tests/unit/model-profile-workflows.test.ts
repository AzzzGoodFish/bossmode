import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import * as credentials from "../../src/engine/model-credentials.js";
import { ModelCredentialsRepository } from "../../src/data/repositories/model-settings.js";
import { commitRemoteCatalog, commitProviderOverlays, clearRemoteCatalogMemoryForTests } from "../../src/engine/model-catalog.js";
import type { ModelCredentialProfile } from "../../src/kernel/types.js";
let f: ReturnType<typeof coreFixture>;
beforeEach(() => { f = coreFixture(); clearRemoteCatalogMemoryForTests(); setCatalog([]); });
afterEach(() => { credentials.setPiCatalogModelsForTests(null); clearRemoteCatalogMemoryForTests(); f.close(); });
const base = {
  name: "Fixture", providerSlug: "proxy", protocol: "openai-responses" as const, baseUrl: "https://example.test/v1",
  authType: "api_key" as const, apiKey: "fixture-secret", requestProfile: "standard" as const, enabled: true, isDefault: true,
  models: [{ id: "model", contextWindow: 20000, maxTokens: 4000, input: ["text" as const] }],
};
const catalog = [
  { provider: "anthropic", id: "model", name: "Model", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "xhigh" } },
  { provider: "anthropic", id: "other", name: "Other", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, maxTokens: 64000, input: ["text"] },
];
function setCatalog(models: any[]) {
  const complete = models.map(model => ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, ...model }));
  const now = Date.now();
  commitRemoteCatalog(complete, now);
  commitProviderOverlays(credentials.buildProviderOverlaysFromFetch(complete, new Map(), now));
}
function native(profile: { id: string; providerSlug: string }) {
  return credentials.createDatabaseModelRuntime(credentials.createCredentialStore(profile), profile.id);
}

it("keeps omitted/blank secrets, redacts public data, and clears active credentials when auth is disabled", async () => {
  const saved = credentials.saveModelCredentialProfile(base);
  for (const apiKey of [undefined, ""]) {
    credentials.saveModelCredentialProfile({ ...base, id: saved.id, name: "Edited", apiKey });
    expect(credentials.getModelCredentialProfile(saved.id)?.apiKey).toBe("fixture-secret");
  }
  const publicText = JSON.stringify(credentials.listPublicModelCredentialProfiles());
  expect(publicText).not.toContain("fixture-secret");
  expect(credentials.listPublicModelCredentialProfiles()[0].hasSecret).toBe(true);
  const runtime = await native(saved);
  expect(JSON.stringify(runtime.getRegisteredProviderConfig("proxy"))).not.toContain("fixture-secret");
  expect(await runtime.getAuth(runtime.getModel("proxy", "model")!)).toMatchObject({ auth: { apiKey: "fixture-secret" } });
  credentials.saveModelCredentialProfile({ ...base, id: saved.id, authType: "none", apiKey: undefined });
  expect(credentials.getModelCredentialProfile(saved.id)?.apiKey).toBeUndefined();
  expect(credentials.listPublicModelCredentialProfiles()[0].hasSecret).toBe(false);
  await credentials.refreshDatabaseModelRuntime(runtime, saved.id);
  expect(runtime.getModel("proxy", "model")).toBeTruthy();
  expect(existsSync(join(f.root, "model-credentials.json"))).toBe(false);
});

it("delivers catalog image/thinking metadata and explicit capacity edits to the real native SDK model", async () => {
  setCatalog(catalog);
  const saved = credentials.saveModelCredentialProfile({ ...base, protocol: "anthropic-messages", models: [{ id: "model" }] });
  const runtime = await native(saved);
  expect(runtime.getModel("proxy", "model")).toMatchObject({ contextWindow: 1000000, maxTokens: 128000, input: ["text", "image"], reasoning: true, compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "xhigh" } });
  credentials.saveModelCredentialProfile({ ...base, id: saved.id, protocol: "anthropic-messages", apiKey: "", models: [{ id: "model", contextWindow: 500000, maxTokens: 64000, input: ["text", "image"] }] });
  await credentials.refreshDatabaseModelRuntime(runtime, saved.id);
  expect(runtime.getModel("proxy", "model")).toMatchObject({ contextWindow: 500000, maxTokens: 64000, input: ["text", "image"] });
  const unknown = credentials.saveModelCredentialProfile({ ...base, providerSlug: "unknown-proxy", models: [{ id: "unknown" }] });
  expect(unknown.models[0].contextWindow).toBeUndefined();
  expect(credentials.listConfiguredModels().find(model => model.profileId === unknown.id)?.contextWindow).toBeUndefined();
  const unknownRuntime = await native(unknown);
  expect(unknownRuntime.getModel("unknown-proxy", "unknown")).toMatchObject({ contextWindow: 128000, input: ["text"] });
});

it("keeps the chosen account and model reference on its profile ID across provider rename", async () => {
  const first = credentials.saveModelCredentialProfile(base);
  const second = credentials.saveModelCredentialProfile({ ...base, providerSlug: "other-proxy", name: "Other account", apiKey: "other-secret" });
  const runtime = await native(second);
  expect(await runtime.getAuth(runtime.getModel("other-proxy", "model")!)).toMatchObject({ auth: { apiKey: "other-secret" } });
  const renamed = credentials.saveModelCredentialProfile({ ...base, id: second.id, providerSlug: "renamed-proxy", apiKey: "" });
  const reference = credentials.exportPiConfigForMember({ roomId: "room", memberName: "member", modelRef: "proxy/model", credentialId: second.id });
  expect(reference?.profile).toMatchObject({ id: second.id, providerSlug: "renamed-proxy" });
  const renamedRuntime = await native(renamed);
  expect(renamedRuntime.getModel("renamed-proxy", "model")).toBeTruthy();
  expect(credentials.getModelCredentialProfile(first.id)?.apiKey).toBe("fixture-secret");
  expect(credentials.getModelCredentialProfile(second.id)?.apiKey).toBe("other-secret");
  for (const file of ["models.json", "auth.json"]) expect(existsSync(join(reference!.agentDir, file))).toBe(false);
});

it("applies and clears built-in model visibility, capacity and API URL customizations without file exports", async () => {
  setCatalog(catalog);
  const profile = credentials.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "fixture-key", baseUrlOverride: "https://proxy.example.test" });
  const runtime = await native(profile);
  expect(runtime.getModel("anthropic", "model")?.baseUrl).toBe("https://proxy.example.test");
  const edited = credentials.saveModelCredentialProfile({ ...profile, apiKey: "", models: [{ id: "model", contextWindow: 500000, input: ["text", "image"] }] });
  expect(edited.modelCustomizations).toMatchObject({ disabled: ["other"], contextWindowOverride: { model: 500000 } });
  expect(credentials.listAvailableModels().map(model => model.ref)).toEqual(["anthropic/model"]);
  await credentials.refreshDatabaseModelRuntime(runtime, profile.id);
  expect(runtime.getModel("anthropic", "model")).toMatchObject({ contextWindow: 500000, maxTokens: 128000 });
  const restored = credentials.saveModelCredentialProfile({ ...profile, apiKey: "", baseUrl: "", models: profile.models });
  expect(restored.modelCustomizations).toBeUndefined();
  await credentials.refreshDatabaseModelRuntime(runtime, profile.id);
  expect(runtime.getModel("anthropic", "model")).toMatchObject({ contextWindow: 1000000, baseUrl: "https://api.anthropic.com" });
  expect(credentials.listAvailableModels().map(model => model.ref)).toEqual(["anthropic/model", "anthropic/other"]);
});

it("rotates API keys and OAuth data in SQL while preserving the selected profile", async () => {
  const first = credentials.saveModelCredentialProfile(base);
  const store = credentials.createCredentialStore(first);
  await store.modify("proxy", async () => ({ type: "api_key", key: "rotated-key" }));
  expect(credentials.getModelCredentialProfile(first.id)?.apiKey).toBe("rotated-key");
  const repo = new ModelCredentialsRepository(f.db);
  const oauth: ModelCredentialProfile = { ...credentials.getModelCredentialProfile(first.id)!, authType: "oauth", apiKey: undefined, oauthCredentials: { access: "old", refresh: "old-refresh", expires: 1 } };
  repo.importProfile(oauth);
  await store.modify("proxy", async () => ({ type: "oauth", access: "new", refresh: "new-refresh", expires: Date.now() + 3600000 }));
  expect(credentials.getModelCredentialProfile(first.id)?.oauthCredentials).toMatchObject({ access: "new", refresh: "new-refresh" });
  expect(existsSync(join(f.root, "model-credentials.json"))).toBe(false);
});

it("normalizes legacy metadata only in the explicit importer, retaining source bytes and migration markers", () => {
  setCatalog(catalog);
  const legacy = { profiles: [{ ...base, id: "legacy", requestProfile: "anthropic_proxy_claude_code", providerSlug: "anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: [{ id: "model", input: ["text"] }], createdAt: 1, updatedAt: 2 }], migrations: ["existing-marker"] };
  const before = JSON.stringify(legacy);
  f.db.close();
  const normalized = credentials.normalizeLegacyCredentialImport(legacy as any, catalog as any);
  expect(normalized.profiles[0].requestProfile).toBe("standard");
  expect(normalized.profiles[0].profileKind).toBeUndefined();
  expect(normalized.profiles[0].models).toContainEqual(expect.objectContaining({ id: "model", input: ["text", "image"] }));
  expect(JSON.stringify(legacy)).toBe(before);
  f.reopen();
  expect(normalized.migrations).toContain("existing-marker");
  const repo = new ModelCredentialsRepository(f.db);
  repo.replace(normalized);
  const revision = repo.revision("legacy");
  credentials.loadModelCredentialProfiles();
  expect(repo.revision("legacy")).toBe(revision);
  expect(repo.read().migrations).toContain("existing-marker");
  credentials.saveModelCredentialProfile({ ...credentials.getModelCredentialProfile("legacy")!, name: "Edited import" });
  expect(repo.read().migrations).toContain("existing-marker");
  credentials.deleteModelCredentialProfile("legacy");
  expect(repo.read().migrations).toContain("existing-marker");
});

it("keeps user-added image models across catalog changes without getter writes or duplicate effective IDs", async () => {
  setCatalog(catalog);
  const profile = credentials.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "fixture-key" });
  const edited = credentials.saveModelCredentialProfile({ ...profile, apiKey: "", modelCustomizations: { addedModels: [{ id: "custom", contextWindow: 32000, input: ["text", "image"] }] } });
  const runtime = await native(edited);
  expect(runtime.getModel("anthropic", "custom")).toMatchObject({ contextWindow: 32000, input: ["text", "image"] });
  const before = credentials.getModelCredentialProfile(profile.id);
  setCatalog([...catalog, { ...catalog[0], id: "custom", contextWindow: 64000 }]);
  expect(credentials.getModelCredentialProfile(profile.id)).toEqual(before);
  expect(credentials.listConfiguredModels().filter(model => model.ref === "anthropic/custom")).toHaveLength(1);
  await credentials.refreshDatabaseModelRuntime(runtime, profile.id);
  expect(runtime.getModel("anthropic", "custom")).toBeTruthy();
});
