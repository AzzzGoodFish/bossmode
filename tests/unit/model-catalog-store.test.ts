/**
 * Last-good, SQL restart hydration, freshness and credential consumers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import * as mod from "../../src/config/model-catalog.js";
import { CatalogRepository } from "../../src/config/pi-adapt/models-store.js";

let fixture: ReturnType<typeof coreFixture>;

describe("CatalogStore SQL authority", () => {
  beforeEach(() => {
    fixture = coreFixture();
    mod.clearRemoteCatalogMemoryForTests();
    mod.setPiCatalogModelsForTests(null);
  });
  afterEach(() => {
    mod.clearRemoteCatalogMemoryForTests();
    mod.setPiCatalogModelsForTests(null);
    mod.setCatalogNetworkRefreshForTests(null);
    mod.setBundledCatalogLoader(() => []);
    vi.restoreAllMocks();
    fixture.close();
  });

  it("getCatalog falls back to bundled when no remote", async () => {
    mod.clearRemoteCatalogMemoryForTests();
    mod.setBundledCatalogLoader(() => [
      { provider: "anthropic", id: "claude-a" },
    ]);
    const snap = mod.getCatalog();
    expect(snap.source).toBe("bundled");
    expect(snap.models.map((m: any) => m.id)).toEqual(["claude-a"]);
    expect(snap.fetchedAt).toBeNull();
    expect(mod.formatCatalogFreshness(snap)).toMatch(/packaged/i);
  });

  it("commitRemoteCatalog persists ordered SQL rows and serves remote", async () => {
    mod.clearRemoteCatalogMemoryForTests();
    mod.setBundledCatalogLoader(() => [{ provider: "x", id: "old" }]);
    mod.commitRemoteCatalog([
      { provider: "kimi-coding", id: "k3-256k" },
      { provider: "kimi-coding", id: "k2" },
    ], 1_700_000_000_000);

    const snap = mod.getCatalog();
    expect(snap.source).toBe("remote");
    expect(snap.modelCount).toBe(2);
    expect(snap.fetchedAt).toBe(1_700_000_000_000);
    expect(snap.models.some((m: any) => m.id === "k3-256k")).toBe(true);

    const stored = new CatalogRepository(fixture.db).remote()!;
    expect(stored.models.map((m) => m.id)).toEqual(["k3-256k", "k2"]);
    expect(stored.fetchedAt).toBe(1_700_000_000_000);
    expect(stored.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(existsSync(join(fixture.root, "pi-catalog-remote.json"))).toBe(false);
  });

  it("retainLastGoodCatalog never clears remote on failure", async () => {
    mod.clearRemoteCatalogMemoryForTests();
    mod.setBundledCatalogLoader(() => [{ provider: "x", id: "bundled-only" }]);
    mod.commitRemoteCatalog([{ provider: "kimi-coding", id: "k3-256k" }], Date.now());

    const kept = mod.retainLastGoodCatalog("no_provider_data", "ECONNREFUSED");
    expect(kept.source).toBe("remote");
    expect(kept.models.some((m: any) => m.id === "k3-256k")).toBe(true);
    expect(mod.getCatalog().source).toBe("remote");
  });

  it("hydrate entry point restores SQL last-good after reopen, ignoring legacy files", () => {
    const legacyPath = join(fixture.root, "pi-catalog-remote.json");
    writeFileSync(legacyPath, "malformed legacy cache");
    mod.commitRemoteCatalog([{ provider: "kimi-coding", id: "k3-256k" }], 1_700_000_100_000);
    mod.clearRemoteCatalogMemoryForTests();
    fixture.reopen();
    mod.hydrateCatalogFromDisk();
    expect(mod.getCatalog()).toMatchObject({
      source: "remote", models: [{ provider: "kimi-coding", id: "k3-256k" }],
      fetchedAt: 1_700_000_100_000,
    });
    expect(readFileSync(legacyPath, "utf8")).toBe("malformed legacy cache");
  });

  it("rejects malformed replacement atomically and ignores empty refresh", () => {
    mod.commitRemoteCatalog([{ provider: "anthropic", id: "claude-x" }], 100);
    expect(() => mod.commitRemoteCatalog([
      { provider: "anthropic", id: "partial" }, { id: "invalid-no-provider" },
    ], 200)).toThrow("identity");
    mod.commitRemoteCatalog([], 300);
    fixture.reopen();
    expect(mod.getCatalog()).toMatchObject({
      models: [{ provider: "anthropic", id: "claude-x" }], fetchedAt: 100,
    });
  });

  it("dropdown === validation: listAvailableModels sees new models after refresh", async () => {
    const cred = await import("../../src/config/model-credentials.js"); const credBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");

    mod.commitRemoteCatalog([
      { provider: "kimi-coding", id: "k2", name: "K2", api: "anthropic-messages", baseUrl: "https://api.kimi.com", contextWindow: 128000, input: ["text"] },
    ]);

    const profile = cred.connectBuiltinProviderApiKey({ providerSlug: "kimi-coding", apiKey: "sk-kimi" });
    expect(credBridge.listAvailableModels().map((m) => m.ref)).toContain("kimi-coding/k2");
    expect(credBridge.listAvailableModels().map((m) => m.ref)).not.toContain("kimi-coding/k3-256k");

    cred.setCatalogNetworkRefreshForTests(async () => {
      mod.commitRemoteCatalog([
        { provider: "kimi-coding", id: "k2", name: "K2", api: "anthropic-messages", baseUrl: "https://api.kimi.com", contextWindow: 128000, input: ["text"] },
        { provider: "kimi-coding", id: "k3-256k", name: "K3 256k", api: "anthropic-messages", baseUrl: "https://api.kimi.com", contextWindow: 256000, input: ["text"] },
      ]);
      return { source: "remote" };
    });

    const refreshed = await cred.refreshModelCredentialProfileModels(profile.id);
    expect(refreshed.catalogSource).toBe("remote");

    fixture.reopen();
    expect(new CatalogRepository(fixture.db).remote()?.models.map((m) => m.id)).toContain("k3-256k");
    const available = credBridge.listAvailableModels().map((m) => m.ref);
    expect(available).toContain("kimi-coding/k3-256k");
    expect(credBridge.isModelAvailable("kimi-coding/k3-256k")).toBe(true);

    cred.setCatalogNetworkRefreshForTests(null);
    cred.setPiCatalogModelsForTests(null);
  });

  it("failed network refresh keeps prior remote overlay", async () => {
    const cat = await import("../../src/config/model-catalog.js");
    const cred = await import("../../src/config/model-credentials.js"); const credBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");

    cat.clearRemoteCatalogMemoryForTests();
    cat.setBundledCatalogLoader(() => [
      { provider: "kimi-coding", id: "k2", contextWindow: 128000 },
    ]);
    cat.commitRemoteCatalog([
      { provider: "kimi-coding", id: "k3-256k", contextWindow: 256000 },
    ], Date.now());
    cat.setPiCatalogModelsForTests(null);
    cred.setPiCatalogModelsForTests(null);
    cat.setCatalogNetworkRefreshForTests(null);

    expect(cat.getCatalog().models.some((m: any) => m.id === "k3-256k")).toBe(true);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;

    try {
      const result = await cred.refreshPiCatalogFromNetwork({ timeoutMs: 500 });
      expect(cat.getCatalog().models.some((m: any) => m.id === "k3-256k")).toBe(true);
      expect(cat.getCatalog().source).toBe("remote");
      expect(result.error).toContain("ECONNREFUSED");
      fixture.reopen();
      expect(cat.getCatalog().models.map((m) => m.id)).toEqual(["k3-256k"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("builtin discover serves catalog without hitting provider /models", async () => {
    const cred = await import("../../src/config/model-credentials.js"); const credBridge = await import("../../src/config/pi-adapt/runtime-bridge.js");
    mod.commitRemoteCatalog([
      { provider: "anthropic", id: "claude-fable-5", name: "Fable", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, input: ["text"] },
    ]);

    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("should not fetch");
    }) as typeof fetch;

    try {
      const result = await cred.discoverModelCredentialModels({
        profileKind: "builtin_provider",
        providerSlug: "anthropic",
        protocol: "anthropic-messages",
        authType: "api_key",
        apiKey: "sk-ant",
      });
      expect(fetchCalled).toBe(false);
      expect(result.models.map((m) => m.id)).toContain("claude-fable-5");
    } finally {
      globalThis.fetch = originalFetch;
      cred.setPiCatalogModelsForTests(null);
    }
  });
});
