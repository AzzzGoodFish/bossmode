import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

const baseProfile = {
  name: "OpenRouter main",
  providerSlug: "openrouter",
  protocol: "openai-responses" as const,
  baseUrl: "https://openrouter.ai/api/v1",
  authType: "api_key" as const,
  apiKey: "sk-secret",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
  models: [{ id: "anthropic/claude-sonnet", contextWindow: 200000, maxTokens: 64000, input: ["text" as const] }],
};

describe("model credential profiles", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-model-creds-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores profiles in a private file and redacts secrets from public lists", async () => {
    const mod = await import("../../src/engine/model-credentials.js");

    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(saved.hasSecret).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("sk-secret");
    const store = join(dir, "model-credentials.json");
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(readFileSync(store, "utf-8")).toContain("sk-secret");
    expect(mod.listPublicModelCredentialProfiles()[0].modelRefs).toEqual(["openrouter/anthropic/claude-sonnet"]);
  });

  it("validates provider slug, protocol, api key, and model metadata", async () => {
    const mod = await import("../../src/engine/model-credentials.js");

    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, providerSlug: "Bad Slug" })).toThrow("Invalid provider slug");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, protocol: "bad" as any })).toThrow("Unsupported protocol");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, apiKey: undefined })).toThrow("apiKey is required");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, models: [{ id: "x", contextWindow: 0 }] })).toThrow("contextWindow");
  });

  it("preserves existing api key on update when omitted and clears it for no-auth", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    mod.saveModelCredentialProfile({ ...baseProfile, id: saved.id, name: "renamed", apiKey: undefined });
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).toContain("sk-secret");

    mod.saveModelCredentialProfile({ ...baseProfile, id: saved.id, authType: "none", apiKey: undefined });
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).not.toContain("sk-secret");
  });

  it("lists credential-backed model options", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(mod.listConfiguredModels()).toMatchObject([
      { ref: "openrouter/anthropic/claude-sonnet", providerSlug: "openrouter", profileId: saved.id, credentialStatus: "configured" },
    ]);
  });

  it("falls back to consistent pi catalog metadata across providers", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "cloud_a", id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
      { provider: "opencode", id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["image", "text"] },
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-opus-4-6" }] }),
    } as any);

    const result = await mod.discoverModelCredentialModels({
      name: "Cloud Open",
      providerSlug: "cloud_a",
      protocol: "anthropic-messages",
      baseUrl: "https://api.example.com/v1",
      authType: "api_key",
      apiKey: "sk-secret",
      requestProfile: "standard",
      enabled: true,
      isDefault: false,
      models: [{ id: "placeholder", contextWindow: 1 }],
    });

    expect(result.models).toEqual([
      expect.objectContaining({
        id: "claude-opus-4-6",
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoning: true,
        input: ["text", "image"],
      }),
    ]);

    fetchMock.mockRestore();
  });

  it("lets pi catalog fill image input when custom endpoint models omit input", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic-proxy", id: "claude-fable-5", contextWindow: 1000000, input: ["text", "image"] },
    ]);

    const saved = mod.saveModelCredentialProfile({
      ...baseProfile,
      providerSlug: "anthropic-proxy",
      protocol: "anthropic-messages",
      models: [{ id: "claude-fable-5" }],
    });

    expect(saved.models[0].input).toEqual(["text", "image"]);
    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "anthropic-proxy/claude-fable-5", credentialId: saved.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers["anthropic-proxy"].models[0].input).toEqual(["text", "image"]);
  });

  it("migrates stored custom endpoint text-only catalog models to image input", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic-proxy", id: "claude-fable-5", contextWindow: 1000000, input: ["text", "image"] },
    ]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model-credentials.json"), JSON.stringify({
      profiles: [{
        id: "p1",
        profileKind: "custom_endpoint",
        name: "Proxy",
        providerSlug: "anthropic-proxy",
        protocol: "anthropic-messages",
        baseUrl: "https://proxy.example/v1",
        authType: "api_key",
        apiKey: "sk-secret",
        requestProfile: "standard",
        enabled: true,
        isDefault: true,
        models: [{ id: "claude-fable-5", input: ["text"], metadataSource: "unknown" }],
        createdAt: 1,
        updatedAt: 1,
      }],
    }, null, 2));

    expect(mod.loadModelCredentialProfiles()[0].models[0].input).toEqual(["text", "image"]);
    const persisted = JSON.parse(readFileSync(join(dir, "model-credentials.json"), "utf-8"));
    expect(persisted.profiles[0].models[0].input).toEqual(["text", "image"]);
    expect(persisted.migrations).toContain("custom-endpoint-vision-v1");

    const afterFirstLoad = readFileSync(join(dir, "model-credentials.json"), "utf-8");
    expect(mod.loadModelCredentialProfiles()[0].models[0].input).toEqual(["text", "image"]);
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).toBe(afterFirstLoad);
  });

  it("preserves migration markers when saving and deleting profiles", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic-proxy", id: "claude-fable-5", contextWindow: 1000000, input: ["text", "image"] },
    ]);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model-credentials.json"), JSON.stringify({
      profiles: [{
        id: "p1",
        profileKind: "custom_endpoint",
        name: "Proxy",
        providerSlug: "anthropic-proxy",
        protocol: "anthropic-messages",
        baseUrl: "https://proxy.example/v1",
        authType: "api_key",
        apiKey: "sk-secret",
        requestProfile: "standard",
        enabled: true,
        isDefault: true,
        models: [{ id: "claude-fable-5", input: ["text"], metadataSource: "unknown" }],
        createdAt: 1,
        updatedAt: 1,
      }],
    }, null, 2));

    mod.loadModelCredentialProfiles();
    const afterMigration = JSON.parse(readFileSync(join(dir, "model-credentials.json"), "utf-8"));
    expect(afterMigration.migrations).toContain("custom-endpoint-vision-v1");

    const saved = mod.saveModelCredentialProfile({ ...baseProfile, providerSlug: "other-proxy", models: [{ id: "unknown-model" }] });
    let persisted = JSON.parse(readFileSync(join(dir, "model-credentials.json"), "utf-8"));
    expect(persisted.migrations).toContain("custom-endpoint-vision-v1");

    expect(mod.deleteModelCredentialProfile(saved.id)).toBe(true);
    persisted = JSON.parse(readFileSync(join(dir, "model-credentials.json"), "utf-8"));
    expect(persisted.migrations).toContain("custom-endpoint-vision-v1");
  });

  it("keeps non-catalog custom endpoint models text-only at runtime export", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([]);

    const saved = mod.saveModelCredentialProfile({ ...baseProfile, models: [{ id: "unknown-model" }] });

    expect(saved.models[0].input).toBeUndefined();
    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openrouter/unknown-model", credentialId: saved.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers.openrouter.models[0].input).toEqual(["text"]);
  });

  it("allows unknown public context metadata but applies internal pi export fallback", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({ ...baseProfile, models: [{ id: "unknown-model" }] });

    expect(mod.listPublicModelCredentialProfiles()[0].models[0].contextWindow).toBeUndefined();
    expect(mod.listConfiguredModels()[0].contextWindow).toBeUndefined();

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openrouter/unknown-model", credentialId: saved.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers.openrouter.models[0].contextWindow).toBe(128000);
  });

  it("preserves user-edited contextWindow and maxTokens through save and export", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "openrouter", id: "anthropic/claude-sonnet", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text"] },
    ]);

    const saved = mod.saveModelCredentialProfile({
      ...baseProfile,
      models: [{ id: "anthropic/claude-sonnet", contextWindow: 500000, maxTokens: 64000, metadataSource: "endpoint" }],
    });

    const listed = mod.listPublicModelCredentialProfiles().find((p) => p.id === saved.id)!;
    expect(listed.models[0]).toMatchObject({ contextWindow: 500000, maxTokens: 64000, metadataSource: "endpoint" });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openrouter/anthropic/claude-sonnet", credentialId: saved.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers.openrouter.models[0]).toMatchObject({ contextWindow: 500000, maxTokens: 64000 });
    mod.setPiCatalogModelsForTests(null);
  });

  it("exports agent-scoped pi models/auth without leaking api key into models.json", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    const exported = mod.exportPiConfigForMember({ roomId: "room/a", memberName: "dev", modelRef: "openrouter/anthropic/claude-sonnet", credentialId: saved.id });

    expect(exported?.agentDir).toContain(join("pi-agent", "runtime"));
    const modelsJson = readFileSync(join(exported!.agentDir, "models.json"), "utf-8");
    const authJson = readFileSync(join(exported!.agentDir, "auth.json"), "utf-8");
    expect(modelsJson).toContain("__bossmode_managed_key__");
    expect(modelsJson).not.toContain("sk-secret");
    expect(authJson).toContain("sk-secret");
    expect(statSync(join(exported!.agentDir, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("preserves an existing API key when editing a profile with blank apiKey", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    const updated = mod.saveModelCredentialProfile({
      ...baseProfile,
      id: saved.id,
      apiKey: "",
      models: [{ id: "anthropic/claude-sonnet", contextWindow: 500000, maxTokens: 64000, input: ["text"] }],
    });
    expect(updated.hasSecret).toBe(true);

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openrouter/anthropic/claude-sonnet", credentialId: saved.id });
    const authJson = readFileSync(join(exported!.agentDir, "auth.json"), "utf-8");
    expect(authJson).toContain("sk-secret");
    expect(JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8")).providers.openrouter.models[0]).toMatchObject({ contextWindow: 500000, maxTokens: 64000 });
  });

  it("rejects credential/model provider mismatch", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(() => mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "anthropic/claude-sonnet-4-6", credentialId: saved.id }))
      .toThrow("does not match model provider");
  });

  it("preserves SDK adaptive-thinking metadata for anthropic-proxy Claude Fable 5 export", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      {
        provider: "anthropic",
        id: "claude-fable-5",
        name: "Claude Fable 5",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoning: true,
        input: ["text", "image"],
        compat: { forceAdaptiveThinking: true },
        thinkingLevelMap: { xhigh: "xhigh" },
      },
    ]);
    const saved = mod.saveModelCredentialProfile({
      ...baseProfile,
      providerSlug: "anthropic-proxy",
      protocol: "anthropic-messages",
      requestProfile: "standard",
      baseUrl: "https://console.cloudrouter.online",
      models: [{ id: "claude-fable-5" }],
    });

    expect(saved.models[0]).toEqual(expect.objectContaining({
      id: "claude-fable-5",
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true,
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { xhigh: "xhigh" },
    }));

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "anthropic-proxy/claude-fable-5", credentialId: saved.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    const exportedModel = modelsJson.providers["anthropic-proxy"].models[0];
    expect(exportedModel.compat.forceAdaptiveThinking).toBe(true);
    expect(exportedModel.thinkingLevelMap.xhigh).toBe("xhigh");
    mod.setPiCatalogModelsForTests(null);
  });

  it("keeps newer file OAuth credentials during synced auth overlay and mirrors them to the profile", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "profile-access", refresh: "profile-refresh", expires: 10 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const authPath = join(dir, "runtime-auth.json");
    writeFileSync(authPath, JSON.stringify({
      "openai-codex": { type: "oauth", access: "file-new-access", refresh: "file-new-refresh", expires: 999999 },
    }, null, 2));

    const profile = mod.getModelCredentialProfile(saved.id)!;
    const authStorage = mod.createSyncedAuthStorage(authPath, profile);

    expect(authStorage.get("openai-codex")).toMatchObject({ access: "file-new-access", refresh: "file-new-refresh", expires: 999999 });
    expect(mod.getModelCredentialProfile(saved.id)!.oauthCredentials).toMatchObject({ access: "file-new-access", refresh: "file-new-refresh", expires: 999999 });
  });

  it("connects built-in provider API key with optional API URL override", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, input: ["text", "image"] },
    ]);

    const profile = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant", baseUrlOverride: "  http://127.0.0.1:3456  " });

    expect(profile.baseUrl).toBe("http://127.0.0.1:3456");
    expect(profile.catalogModels?.map((m) => m.id)).toContain("claude-fable-5");
    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "anthropic/claude-fable-5", credentialId: profile.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers.anthropic.baseUrl).toBe("http://127.0.0.1:3456");
    expect(modelsJson.providers.anthropic.models[0].id).toBe("claude-fable-5");
  });

  it("creates a second built-in provider profile instead of overwriting the first", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, input: ["text", "image"] },
    ]);

    const first = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant-a", name: "Anthropic A", baseUrlOverride: "http://127.0.0.1:3456" });
    const second = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant-b", baseUrlOverride: "   " });

    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe("Anthropic (Claude Pro/Max) 2");
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(mod.getModelCredentialProfile(first.id)!.baseUrl).toBe("http://127.0.0.1:3456");
    expect(mod.getModelCredentialProfile(second.id)!.baseUrl).toBe("https://api.anthropic.com");
    const options = mod.listAvailableModels().filter((m) => m.ref === "anthropic/claude-fable-5");
    expect(options.map((m) => m.profileId).sort()).toEqual([first.id, second.id].sort());
    expect(options.map((m) => m.profileBaseUrl).sort()).toEqual(["http://127.0.0.1:3456", "https://api.anthropic.com"].sort());
    expect(() => mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant", baseUrlOverride: "ftp://bad.example" })).toThrow("baseUrl must be an http:// or https:// URL");
  });

  it("clears built-in provider API URL override on profile edit when baseUrl is blank", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, input: ["text", "image"] },
    ]);

    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant", baseUrlOverride: "http://127.0.0.1:3456" });
    const edited = mod.saveModelCredentialProfile({
      id: saved.id,
      profileKind: "builtin_provider",
      name: saved.name,
      providerSlug: saved.providerSlug,
      protocol: saved.protocol,
      baseUrl: "   ",
      authType: "api_key",
      enabled: true,
      isDefault: true,
      models: saved.models,
    });

    expect(edited.baseUrl).toBe("https://api.anthropic.com");
    const stored = mod.getModelCredentialProfile(saved.id)!;
    expect(stored.baseUrl).toBe("https://api.anthropic.com");
  });

  it("lists built-in provider catalog and connects API key without baseUrl/protocol/models input", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "openai", id: "gpt-4.1", name: "GPT 4.1", api: "openai-responses", baseUrl: "https://api.openai.com/v1", contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
      { provider: "openai", id: "gpt-4.1-mini", name: "GPT 4.1 Mini", api: "openai-responses", baseUrl: "https://api.openai.com/v1", contextWindow: 1000000, input: ["text"] },
    ]);

    const catalog = mod.listBuiltinModelProviders();
    expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({
      providerSlug: "openai",
      authModes: expect.arrayContaining(["api_key"]),
      modelCount: 2,
      sampleModels: expect.arrayContaining(["gpt-4.1"]),
    })]));

    const profile = mod.connectBuiltinProviderApiKey({ providerSlug: "openai", apiKey: "sk-openai", isDefault: true });
    expect(profile.profileKind).toBe("builtin_provider");
    expect(profile.providerSlug).toBe("openai");
    expect(profile.protocol).toBe("openai-responses");
    expect(profile.baseUrl).toBe("https://api.openai.com/v1");
    expect(profile.models.map((m) => m.id)).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
    expect(profile.hasSecret).toBe(true);
    expect(JSON.stringify(profile)).not.toContain("sk-openai");
  });


  it("refreshes built-in provider model snapshots from the current SDK catalog", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-old", name: "Claude Old", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000, input: ["text"] },
    ]);
    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant" });
    expect(saved.models.map((m) => m.id)).toEqual(["claude-old"]);

    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-old", name: "Claude Old", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000, input: ["text"] },
      { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
    ]);

    const listed = mod.listPublicModelCredentialProfiles().find((p) => p.id === saved.id)!;
    expect(listed.models.map((m) => m.id)).toContain("claude-fable-5");
    expect(mod.listAvailableModels().map((m) => m.ref)).toContain("anthropic/claude-fable-5");
    const refreshed = mod.refreshModelCredentialProfileModels(saved.id);
    expect(refreshed.models.find((m) => m.id === "claude-fable-5")).toMatchObject({ contextWindow: 1000000, maxTokens: 128000, reasoning: true });
    mod.setPiCatalogModelsForTests(null);
  });

  it("includes Claude Fable 5 in the upgraded Anthropic SDK catalog", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const profile = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant" });
    expect(profile.models.map((m) => m.id)).toContain("claude-fable-5");
  });

  it("migrates legacy official Anthropic profiles to built-in provider and refreshes catalog models", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-old", name: "Claude Old", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000, input: ["text"] },
      { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
    ]);
    writeFileSync(join(dir, "model-credentials.json"), JSON.stringify({ profiles: [{
      id: "legacy-anthropic",
      name: "Anthropic (Claude Pro/Max)",
      providerSlug: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      authType: "api_key",
      apiKey: "sk-ant",
      requestProfile: "standard",
      enabled: true,
      isDefault: true,
      models: [{ id: "claude-old", contextWindow: 1000, input: ["text"] }],
      createdAt: 1,
      updatedAt: 1,
    }] }, null, 2));

    const listed = mod.listPublicModelCredentialProfiles()[0];
    expect(listed.profileKind).toBe("builtin_provider");
    expect(listed.models.map((m) => m.id)).toContain("claude-fable-5");
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).toContain("builtin_provider");
    mod.setPiCatalogModelsForTests(null);
  });

  it("does not export simplified model overrides for SDK built-in provider profiles", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const profile = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant" });
    expect(profile.models.map((m) => m.id)).toContain("claude-fable-5");

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "pm", modelRef: "anthropic/claude-fable-5", credentialId: profile.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers).toEqual({});
  });

  it("persists built-in provider disabled models and contextWindow overrides", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-a", name: "Claude A", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, maxTokens: 128000, input: ["text"] },
      { provider: "anthropic", id: "claude-b", name: "Claude B", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, maxTokens: 64000, input: ["text"] },
    ]);
    const profile = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant" });

    const edited = mod.saveModelCredentialProfile({
      ...profile,
      apiKey: "",
      models: [{ id: "claude-a", contextWindow: 500000, maxTokens: 64000, input: ["text"] }],
    });

    expect(edited.models.map((m) => m.id)).toEqual(["claude-a"]);
    expect(edited.modelCustomizations).toEqual({ disabled: ["claude-b"], contextWindowOverride: { "claude-a": 500000 } });
    expect(mod.listConfiguredModels().map((m) => m.ref)).toEqual(["anthropic/claude-a"]);
    expect(mod.listAvailableModels().map((m) => m.ref)).toEqual(["anthropic/claude-a"]);

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "pm", modelRef: "anthropic/claude-a", credentialId: profile.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers.anthropic.models.map((m: any) => m.id)).toEqual(["claude-a"]);
    expect(modelsJson.providers.anthropic.models[0]).toMatchObject({ contextWindow: 500000, maxTokens: 128000 });

    const reloaded = mod.listPublicModelCredentialProfiles().find((p) => p.id === profile.id)!;
    expect(reloaded.models.map((m) => m.id)).toEqual(["claude-a"]);
    expect(reloaded.models[0]).toMatchObject({ contextWindow: 500000, maxTokens: 128000 });
    mod.setPiCatalogModelsForTests(null);
  });

  it("restores built-in provider defaults when customizations are cleared", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-a", name: "Claude A", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, maxTokens: 128000, input: ["text"] },
      { provider: "anthropic", id: "claude-b", name: "Claude B", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, maxTokens: 64000, input: ["text"] },
    ]);
    const profile = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant" });
    mod.saveModelCredentialProfile({ ...profile, apiKey: "", models: [{ id: "claude-a", contextWindow: 500000, input: ["text"] }] });

    const restored = mod.saveModelCredentialProfile({ ...profile, apiKey: "", models: profile.models });
    expect(restored.modelCustomizations).toBeUndefined();
    expect(restored.models.map((m) => m.id)).toEqual(["claude-a", "claude-b"]);
    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "pm", modelRef: "anthropic/claude-a", credentialId: profile.id });
    expect(JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8")).providers).toEqual({});
    mod.setPiCatalogModelsForTests(null);
  });

  it("persists OAuth refreshes from runtime auth storage back to the Bossmode profile", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "old-access", refresh: "old-refresh", expires: 1 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });
    const profile = mod.getModelCredentialProfile(saved.id)!;
    const authStorage = mod.createSyncedAuthStorage(join(exported!.agentDir, "auth.json"), profile);

    authStorage.set("openai-codex", { type: "oauth", access: "new-access", refresh: "new-refresh", expires: 999999 });

    const stored = mod.getModelCredentialProfile(saved.id)!;
    expect(stored.oauthCredentials).toMatchObject({ access: "new-access", refresh: "new-refresh", expires: 999999 });
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).toContain("new-refresh");
  });

  it("overwrites stale per-member OAuth credentials when the profile has a newer reconnect token", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "profile-new-access", refresh: "profile-new-refresh", expires: 999999 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });
    writeFileSync(join(exported!.agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "runtime-old-access", refresh: "runtime-old-refresh", expires: 1 },
    }, null, 2));

    mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });

    const authJson = readFileSync(join(exported!.agentDir, "auth.json"), "utf-8");
    const stored = mod.getModelCredentialProfile(saved.id)!;
    expect(authJson).toContain("profile-new-refresh");
    expect(authJson).not.toContain("runtime-old-refresh");
    expect(stored.oauthCredentials).toMatchObject({ access: "profile-new-access", refresh: "profile-new-refresh", expires: 999999 });
  });

  it("does not overwrite newer per-member OAuth credentials with stale profile data on export", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "old-access", refresh: "old-refresh", expires: 1 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });
    writeFileSync(join(exported!.agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "runtime-access", refresh: "runtime-refresh", expires: 999999 },
    }, null, 2));

    mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });

    const authJson = readFileSync(join(exported!.agentDir, "auth.json"), "utf-8");
    const stored = mod.getModelCredentialProfile(saved.id)!;
    expect(authJson).toContain("runtime-refresh");
    expect(authJson).not.toContain("old-refresh");
    expect(stored.oauthCredentials).toMatchObject({ access: "runtime-access", refresh: "runtime-refresh", expires: 999999 });
  });
});
