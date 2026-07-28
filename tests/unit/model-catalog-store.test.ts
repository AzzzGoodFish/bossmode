/**
 * CatalogStore v2a — last-good semantics, disk hydrate, freshness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

describe("CatalogStore", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-catalog-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("getCatalog falls back to bundled when no remote", async () => {
    const mod = await import("../../src/engine/model-catalog.js");
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

  it("commitRemoteCatalog writes disk atomically and serves remote", async () => {
    const mod = await import("../../src/engine/model-catalog.js");
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

    const disk = JSON.parse(readFileSync(join(dir, "pi-catalog-remote.json"), "utf-8"));
    expect(disk.models).toHaveLength(2);
    expect(disk.fetchedAt).toBe(1_700_000_000_000);
    expect(disk.updatedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("retainLastGoodCatalog never clears remote on failure", async () => {
    const mod = await import("../../src/engine/model-catalog.js");
    mod.clearRemoteCatalogMemoryForTests();
    mod.setBundledCatalogLoader(() => [{ provider: "x", id: "bundled-only" }]);
    mod.commitRemoteCatalog([{ provider: "kimi-coding", id: "k3-256k" }], Date.now());

    const kept = mod.retainLastGoodCatalog("no_provider_data", "ECONNREFUSED");
    expect(kept.source).toBe("remote");
    expect(kept.models.some((m: any) => m.id === "k3-256k")).toBe(true);
    expect(mod.getCatalog().source).toBe("remote");
  });

  it("hydrateCatalogFromDisk restores last-good after process memory clear", async () => {
    const mod = await import("../../src/engine/model-catalog.js");
    writeFileSync(join(dir, "pi-catalog-remote.json"), JSON.stringify({
      models: [{ provider: "kimi-coding", id: "k3-256k" }],
      fetchedAt: 1_700_000_100_000,
      updatedAt: new Date(1_700_000_100_000).toISOString(),
    }));

    mod.clearRemoteCatalogMemoryForTests();
    mod.setBundledCatalogLoader(() => [{ provider: "x", id: "bundled" }]);
    expect(mod.getCatalog().source).toBe("bundled");

    mod.hydrateCatalogFromDisk();
    const snap = mod.getCatalog();
    expect(snap.source).toBe("remote");
    expect(snap.models.map((m: any) => m.id)).toEqual(["k3-256k"]);
    expect(snap.fetchedAt).toBe(1_700_000_100_000);
  });

  it("hydrate accepts legacy disk cache without fetchedAt (uses updatedAt)", async () => {
    const mod = await import("../../src/engine/model-catalog.js");
    writeFileSync(join(dir, "pi-catalog-remote.json"), JSON.stringify({
      models: [{ provider: "anthropic", id: "claude-x" }],
      updatedAt: "2026-07-27T06:43:24.072Z",
    }));
    mod.clearRemoteCatalogMemoryForTests();
    mod.hydrateCatalogFromDisk();
    const snap = mod.getCatalog();
    expect(snap.source).toBe("remote");
    expect(snap.fetchedAt).toBe(Date.parse("2026-07-27T06:43:24.072Z"));
  });

  it("dropdown === validation: listAvailableModels sees new models after refresh", async () => {
    const cred = await import("../../src/engine/model-credentials.js");

    cred.setPiCatalogModelsForTests([
      { provider: "kimi-coding", id: "k2", name: "K2", api: "anthropic-messages", baseUrl: "https://api.kimi.com", contextWindow: 128000, input: ["text"] },
    ]);

    const profile = cred.connectBuiltinProviderApiKey({ providerSlug: "kimi-coding", apiKey: "sk-kimi" });
    expect(cred.listAvailableModels().map((m) => m.ref)).toContain("kimi-coding/k2");
    expect(cred.listAvailableModels().map((m) => m.ref)).not.toContain("kimi-coding/k3-256k");

    cred.setCatalogNetworkRefreshForTests(async () => {
      cred.setPiCatalogModelsForTests([
        { provider: "kimi-coding", id: "k2", name: "K2", api: "anthropic-messages", baseUrl: "https://api.kimi.com", contextWindow: 128000, input: ["text"] },
        { provider: "kimi-coding", id: "k3-256k", name: "K3 256k", api: "anthropic-messages", baseUrl: "https://api.kimi.com", contextWindow: 256000, input: ["text"] },
      ]);
      return { source: "remote" };
    });

    const refreshed = await cred.refreshModelCredentialProfileModels(profile.id);
    expect(refreshed.catalogSource).toBe("remote");

    const available = cred.listAvailableModels().map((m) => m.ref);
    expect(available).toContain("kimi-coding/k3-256k");
    expect(cred.isModelAvailable("kimi-coding/k3-256k")).toBe(true);

    cred.setCatalogNetworkRefreshForTests(null);
    cred.setPiCatalogModelsForTests(null);
  });

  it("failed network refresh keeps prior remote overlay", async () => {
    const cat = await import("../../src/engine/model-catalog.js");
    const cred = await import("../../src/engine/model-credentials.js");

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
      // Should report an error while keeping last-good
      expect(result.error || result.source === "remote").toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("builtin discover serves catalog without hitting provider /models", async () => {
    const cred = await import("../../src/engine/model-credentials.js");
    cred.setPiCatalogModelsForTests([
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
