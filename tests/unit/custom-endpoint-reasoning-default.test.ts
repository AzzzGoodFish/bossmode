import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { ModelCredentialsRepository } from "../../src/data/repositories/model-settings.js";
import * as catalog from "../../src/engine/model-catalog.js";

let fixture: ReturnType<typeof coreFixture>;

const customProfile = {
  name: "GLM CloudRouter",
  providerSlug: "qa-custom",
  protocol: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:9/v1",
  authType: "api_key" as const,
  apiKey: "sk-test",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
};

describe("custom endpoint reasoning default", () => {
  beforeEach(() => { fixture = coreFixture(); });
  afterEach(() => {
    catalog.setPiCatalogModelsForTests(null);
    catalog.setCatalogNetworkRefreshForTests(null);
    fixture.close();
  });

  it("save defaults missing reasoning to true", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      ...customProfile,
      models: [{ id: "glm5.3", thinkingLevelMap: { max: "high" } }],
    });
    expect(saved.models[0].reasoning).toBe(true);
  });

  it("save keeps explicit reasoning false", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      ...customProfile,
      models: [{ id: "glm5.3", reasoning: false }],
    });
    expect(saved.models[0].reasoning).toBe(false);
  });

  it("normalizes null/missing custom reasoning once during explicit import, preserving builtin flags", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const source = { profiles: [
      { ...customProfile, id: "cust1", profileKind: "custom_endpoint" as const,
        models: [
          { id: "glm5.3", reasoning: null, thinkingLevelMap: { max: "high" }, metadataSource: "unknown" },
          { id: "other", metadataSource: "unknown" },
          { id: "explicit-off", reasoning: false },
        ], createdAt: 1, updatedAt: 1 },
      { ...customProfile, id: "built1", profileKind: "builtin_provider" as const,
        providerSlug: "anthropic", protocol: "anthropic-messages" as const,
        models: [{ id: "claude-x", reasoning: false, metadataSource: "pi_catalog" }],
        createdAt: 1, updatedAt: 1 },
    ], migrations: [] };
    const original = structuredClone(source);
    const normalized = mod.normalizeLegacyCredentialImport(source as any, []);
    expect(source).toEqual(original);
    expect(normalized.profiles[0].models.map((m) => m.reasoning)).toEqual([true, true, false]);
    expect(normalized.profiles[0].models[0].thinkingLevelMap).toEqual({ max: "high" });
    expect(normalized.profiles[1].models[0].reasoning).toBe(false);
    expect(normalized.migrations).toContain("custom-endpoint-reasoning-default-v1");
    expect(mod.normalizeLegacyCredentialImport(normalized, [])).toEqual(normalized);
    const repo = new ModelCredentialsRepository(fixture.db);
    repo.replace(normalized);
    const revision = repo.revision("cust1");
    expect(mod.loadModelCredentialProfiles()).toEqual(normalized.profiles);
    expect(repo.revision("cust1")).toBe(revision);
    fixture.reopen();
    expect(mod.loadModelCredentialProfiles()).toEqual(normalized.profiles);
  });

  it("does not flip builtin catalog reasoning on refresh", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    await mod.ensurePiCatalogWarm();
    catalog.commitRemoteCatalog([
      { provider: "anthropic", id: "claude-x", name: "Claude X", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, reasoning: false, input: ["text"] },
    ]);
    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant", name: "Anthropic" });
    expect(saved.models.find((m) => m.id === "claude-x")?.reasoning).toBe(false);
    mod.setCatalogNetworkRefreshForTests(async () => ({ source: "remote" }));
    await mod.refreshModelCredentialProfileModels(saved.id);
    fixture.reopen();
    expect(mod.getModelCredentialProfile(saved.id)?.models.find((m) => m.id === "claude-x")?.reasoning).toBe(false);
    mod.setPiCatalogModelsForTests(null);
  });
});
