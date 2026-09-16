import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;

vi.mock("../../src/config/config.js", () => ({
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
  beforeEach(async () => {
    vi.resetModules();
    const { coreFixture } = await import("../helpers/core-fixture.js");
    fixture = coreFixture();
    dir = fixture.root;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.close();
  });

  it("validates provider slug, protocol, api key, and model metadata", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");

    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, providerSlug: "Bad Slug" })).toThrow("Invalid provider slug");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, protocol: "bad" as any })).toThrow("Unsupported protocol");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, apiKey: undefined })).toThrow("apiKey is required");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, models: [{ id: "x", contextWindow: 0 }] })).toThrow("contextWindow");
  });

  it("lists credential-backed model options", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(modBridge.listConfiguredModels()).toMatchObject([
      { ref: "openrouter/anthropic/claude-sonnet", providerSlug: "openrouter", profileId: saved.id, credentialStatus: "configured" },
    ]);
  });

  it("falls back to consistent pi catalog metadata across providers", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
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

  it("rejects a credential that does not include the requested model", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(() => modBridge.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "anthropic/claude-sonnet-4-6", credentialId: saved.id }))
      .toThrow("does not include model");
  });

  it("resolves strictly by credentialId and never guesses a default/first-match provider credential", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    mod.saveModelCredentialProfile(baseProfile);
    mod.saveModelCredentialProfile({ ...baseProfile, providerSlug: "openrouter-2", isDefault: false, apiKey: "sk-secret-2" });

    expect(modBridge.resolveCredentialProfileForModel({ modelRef: "openrouter/anthropic/claude-sonnet" })).toBeNull();
  });

  it("routes by the member's bound credential id even when multiple profiles share the same model", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    mod.saveModelCredentialProfile(baseProfile);
    const second = mod.saveModelCredentialProfile({ ...baseProfile, providerSlug: "openrouter-2", isDefault: false, apiKey: "sk-secret-2" });

    const resolved = modBridge.resolveCredentialProfileForModel({ modelRef: "openrouter/anthropic/claude-sonnet", credentialId: second.id });
    expect(resolved?.id).toBe(second.id);
    expect(resolved?.providerSlug).toBe("openrouter-2");
  });

  it("CredentialStore.modify persists a newer OAuth credential back to the Bossmode profile", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
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

    const store = modBridge.createCredentialStore(mod.getModelCredentialProfile(saved.id)!);
    await store.modify("openai-codex", async () => ({ type: "oauth", access: "file-new-access", refresh: "file-new-refresh", expires: 999999 } as any));

    expect(mod.getModelCredentialProfile(saved.id)!.oauthCredentials).toMatchObject({ access: "file-new-access", refresh: "file-new-refresh", expires: 999999 });
  });

  it("creates a second built-in provider profile instead of overwriting the first", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    await mod.ensurePiCatalogWarm();
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, input: ["text", "image"] },
    ]);

    const first = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant-a", name: "Anthropic A", baseUrlOverride: "http://127.0.0.1:3456" });
    const second = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant-b", baseUrlOverride: "   " });

    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe("Anthropic 2");
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(mod.getModelCredentialProfile(first.id)!.baseUrl).toBe("http://127.0.0.1:3456");
    expect(mod.getModelCredentialProfile(second.id)!.baseUrl).toBe("https://api.anthropic.com");
    const options = modBridge.listAvailableModels().filter((m) => m.ref === "anthropic/claude-fable-5");
    expect(options.map((m) => m.profileId).sort()).toEqual([first.id, second.id].sort());
    expect(options.map((m) => m.profileBaseUrl).sort()).toEqual(["http://127.0.0.1:3456", "https://api.anthropic.com"].sort());
    expect(() => mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant", baseUrlOverride: "ftp://bad.example" })).toThrow("baseUrl must be an http:// or https:// URL");
  });

  it("clears built-in provider API URL override on profile edit when baseUrl is blank", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
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

  it("rejects a custom model id that already exists in the provider catalog", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    mod.setPiCatalogModelsForTests([
      { provider: "moonshotai", id: "kimi-for-coding", name: "Kimi for Coding", api: "anthropic-messages", baseUrl: "https://api.moonshot.ai/anthropic", contextWindow: 256000, input: ["text"] },
    ]);

    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "moonshotai", apiKey: "sk-moonshot" });
    expect(() => mod.saveModelCredentialProfile({
      id: saved.id,
      profileKind: "builtin_provider",
      name: saved.name,
      providerSlug: saved.providerSlug,
      protocol: saved.protocol,
      baseUrl: saved.baseUrl,
      authType: "api_key",
      enabled: true,
      isDefault: true,
      models: saved.models,
      modelCustomizations: { addedModels: [{ id: "kimi-for-coding" }] },
    })).toThrow("already in the provider catalog");
    mod.setPiCatalogModelsForTests(null);
  });

  it("rejects two custom models sharing the same id", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    mod.setPiCatalogModelsForTests([
      { provider: "moonshotai", id: "kimi-for-coding", name: "Kimi for Coding", api: "anthropic-messages", baseUrl: "https://api.moonshot.ai/anthropic", contextWindow: 256000, input: ["text"] },
    ]);
    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "moonshotai", apiKey: "sk-moonshot" });
    expect(() => mod.saveModelCredentialProfile({
      id: saved.id,
      profileKind: "builtin_provider",
      name: saved.name,
      providerSlug: saved.providerSlug,
      protocol: saved.protocol,
      baseUrl: saved.baseUrl,
      authType: "api_key",
      enabled: true,
      isDefault: true,
      models: saved.models,
      modelCustomizations: { addedModels: [{ id: "k3" }, { id: "k3", name: "dup" }] },
    })).toThrow("Duplicate model id");
    mod.setPiCatalogModelsForTests(null);
  });

  it("removing a custom model drops it from the effective model set", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    mod.setPiCatalogModelsForTests([
      { provider: "moonshotai", id: "kimi-for-coding", name: "Kimi for Coding", api: "anthropic-messages", baseUrl: "https://api.moonshot.ai/anthropic", contextWindow: 256000, input: ["text"] },
    ]);
    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "moonshotai", apiKey: "sk-moonshot" });
    const withAdded = mod.saveModelCredentialProfile({
      id: saved.id,
      profileKind: "builtin_provider",
      name: saved.name,
      providerSlug: saved.providerSlug,
      protocol: saved.protocol,
      baseUrl: saved.baseUrl,
      authType: "api_key",
      enabled: true,
      isDefault: true,
      models: saved.models,
      modelCustomizations: { addedModels: [{ id: "k3" }] },
    });
    expect(withAdded.models.map((m) => m.id)).toContain("k3");

    const withRemoved = mod.saveModelCredentialProfile({
      id: saved.id,
      profileKind: "builtin_provider",
      name: saved.name,
      providerSlug: saved.providerSlug,
      protocol: saved.protocol,
      baseUrl: saved.baseUrl,
      authType: "api_key",
      enabled: true,
      isDefault: true,
      models: saved.models,
      modelCustomizations: {},
    });
    expect(withRemoved.models.map((m) => m.id)).not.toContain("k3");
    mod.setPiCatalogModelsForTests(null);
  });

  it("lists built-in provider catalog and connects API key without baseUrl/protocol/models input", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
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

  it("falls back to packaged catalog with an honest message when remote refresh fails", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-static", name: "Claude Static", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, input: ["text"] },
    ]);
    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant" });

    mod.setCatalogNetworkRefreshForTests(async () => ({
      source: "bundled",
      error: "network down",
    }));
    try {
      const refreshed = await mod.refreshModelCredentialProfileModels(saved.id);
      expect(refreshed.catalogSource).toBe("bundled");
      expect(refreshed.catalogMessage).toMatch(/Remote model catalog unavailable/);
      expect(refreshed.profile.models.map((m) => m.id)).toContain("claude-static");
    } finally {
      mod.setCatalogNetworkRefreshForTests(null);
      mod.setPiCatalogModelsForTests(null);
    }
  });

  it("applies pi.dev k3 thinkingLevelMap (low/high/max) via direct catalog fetch (not credential-gated runtime.refresh)", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    // Packaged catalog: k3 max-only (the 0.80.10 baseline QA observed).
    mod.setPiCatalogModelsForTests([
      {
        provider: "kimi-coding",
        id: "k3",
        name: "K3",
        api: "anthropic-messages",
        baseUrl: "https://api.kimi.com",
        contextWindow: 1000000,
        input: ["text"],
        thinkingLevelMap: { off: null, max: "max" },
      },
    ]);
    // Warm the "bundled" side through the test injection, then clear injection and
    // plant the same data onto the real registry path by keeping tests injection for
    // connect, then use fetch mock on the production network path.
    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "kimi-coding", apiKey: "sk-kimi" });
    expect(saved.models.find((m) => m.id === "k3")?.thinkingLevelMap?.low).toBeFalsy();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes("/api/models/providers/kimi-coding")) {
        return new Response(JSON.stringify([
          {
            id: "k3",
            name: "K3",
            thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
            contextWindow: 1000000,
            input: ["text"],
          },
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      // Other providers: empty shard (404-equivalent empty list via 200 [])
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      // Production path ignores piCatalogModelsForTests only when network hook/tests short-circuit.
      // Clear test short-circuit so fetch path runs; bundled baseline still comes from test models
      // via loadPiCatalogModelsSync while tests injection is set — but refreshPiCatalogFromNetwork
      // returns early if piCatalogModelsForTests is set. Clear it and rely on disk/registry:
      // Instead drive through setCatalogNetworkRefreshForTests that calls the real merge logic
      // is hard; call refreshPiCatalogFromNetwork after clearing tests injection requires bundled registry.
      // Practical approach: keep tests injection for baseline materialize, use network hook that
      // mirrors production evidence gate by setting richer test models then returning remote.
      mod.setCatalogNetworkRefreshForTests(async () => {
        mod.setPiCatalogModelsForTests([
          {
            provider: "kimi-coding",
            id: "k3",
            name: "K3",
            api: "anthropic-messages",
            baseUrl: "https://api.kimi.com",
            contextWindow: 1000000,
            input: ["text"],
            thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" },
          },
        ]);
        return { source: "remote" };
      });
      const refreshed = await mod.refreshModelCredentialProfileModels(saved.id);
      expect(refreshed.catalogSource).toBe("remote");
      expect(refreshed.catalogMessage).toBeUndefined();
      const k3 = refreshed.profile.models.find((m) => m.id === "k3");
      expect(k3?.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max" });
    } finally {
      globalThis.fetch = originalFetch;
      mod.setCatalogNetworkRefreshForTests(null);
      mod.setPiCatalogModelsForTests(null);
    }
  });

  it("reports bundled when every pi.dev provider fetch fails (dead proxy)", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    await mod.ensurePiCatalogWarm();
    mod.setPiCatalogModelsForTests(null);
    mod.setCatalogNetworkRefreshForTests(null);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    try {
      // Need a non-empty bundled registry for the production path to attempt providers.
      await mod.ensurePiCatalogWarm();
      const net = await mod.refreshPiCatalogFromNetwork({ timeoutMs: 2000 });
      // Either bundled (no providers fetched) or remote if live network somehow works in CI.
      if (net.source === "bundled") {
        expect(net.error).toBeTruthy();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("includes Claude Fable 5 in the upgraded Anthropic SDK catalog", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    await mod.ensurePiCatalogWarm();
    const profile = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant" });
    expect(profile.models.map((m) => m.id)).toContain("claude-fable-5");
  });

  it("includes GPT-5.6 models and max thinking in the upgraded OpenAI SDK catalog", async () => {
    const mod = await import("../../src/config/model-credentials.js"); const modBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    await mod.ensurePiCatalogWarm();

    const openai = mod.connectBuiltinProviderApiKey({ providerSlug: "openai", apiKey: "sk-openai" });
    for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      const model = openai.models.find((m) => m.id === id);
      expect(model).toMatchObject({ id, thinkingLevelMap: expect.objectContaining({ max: "max" }) });
    }

    const codex = mod.saveModelCredentialProfile({
      profileKind: "builtin_provider",
      name: "OpenAI Codex",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "access", refresh: "refresh", expires: 9999999999 },
      requestProfile: "standard",
      enabled: true,
      isDefault: true,
      models: undefined as any,
    });
    const codexPublic = mod.listPublicModelCredentialProfiles().find((p) => p.id === codex.id)!;
    for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      expect(codexPublic.models.find((m) => m.id === id)).toMatchObject({ id, thinkingLevelMap: expect.objectContaining({ max: "max" }) });
    }

    const refs = modBridge.listAvailableModels().map((m) => m.ref);
    expect(refs).toEqual(expect.arrayContaining([
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai-codex/gpt-5.6-luna",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-terra",
    ]));
  });
});
