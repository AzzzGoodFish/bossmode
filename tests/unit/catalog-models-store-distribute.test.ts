import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { coreFixture } from "../helpers/core-fixture.js";

const state = vi.hoisted(() => ({ refreshAll: vi.fn(async () => ({ refreshed: 1, failed: 0 })) }));
// Only live execution is stubbed; catalog persistence and the SDK reader are real.
vi.mock("../../src/agent/orchestrator/agent-manager.js", () => ({
  refreshAllInstanceModelRegistries: () => state.refreshAll(),
}));
import { connectBuiltinProviderApiKey } from "../../src/config/models.js";
import { ensurePiCatalogWarm, refreshPiCatalogFromNetwork, getCatalog } from "../../src/config/catalog.js";
import { buildProviderOverlaysFromFetch, publishProviderModels } from "../../src/config/catalog.js";
import { createCredentialStore, getBossmodePiRuntimeRoot } from "../../src/config/pi-adapt/credentials.js";
import { commitRemoteCatalog, commitProviderOverlays, getProviderOverlays, clearRemoteCatalogMemoryForTests, createDatabaseModelsStore } from "../../src/config/catalog.js";

import { wireConfiguration } from "../../src/app/wire.js";
let dispose: () => void;
let fixture: ReturnType<typeof coreFixture>;
describe("catalog native SQL models-store distribution", () => {
  beforeEach(() => {
    fixture = coreFixture();
    dispose = wireConfiguration();
    state.refreshAll.mockReset().mockResolvedValue({ refreshed: 1, failed: 0 });
    clearRemoteCatalogMemoryForTests();
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); dispose(); clearRemoteCatalogMemoryForTests(); fixture.close(); });

  it("publishes only after the enclosing transaction commits and never after rollback", async () => {
    const overlay = { xai: { models: [{ id: "committed", provider: "xai" }], checkedAt: 1 } };
    fixture.db.transaction(() => {
      publishProviderModels(overlay);
      expect(state.refreshAll).not.toHaveBeenCalled();
    });
    await vi.waitFor(() => expect(state.refreshAll).toHaveBeenCalledTimes(1));
    expect(() => fixture.db.transaction(() => {
      publishProviderModels({ xai: { models: [{ id: "rolled-back", provider: "xai" }], checkedAt: 2 } });
      throw new Error("rollback publication");
    })).toThrow("rollback publication");
    await Promise.resolve();
    expect(state.refreshAll).toHaveBeenCalledTimes(1);
    expect(getProviderOverlays()).toEqual(overlay);
  });

  it("keeps the entire last-good catalog when provider SQL publication fails", async () => {
    await ensurePiCatalogWarm();
    const old = [{ id: "last-good", provider: "xai" }];
    commitRemoteCatalog(old, 100);
    commitProviderOverlays({ xai: { models: old, checkedAt: 100 } });
    vi.stubGlobal("fetch", vi.fn(async url => String(url).endsWith("/xai")
      ? new Response(JSON.stringify([{ id: "new-model", provider: "xai" }]), { status: 200 })
      : new Response("", { status: 404 })));
    const run = fixture.db.run.bind(fixture.db);
    vi.spyOn(fixture.db, "run").mockImplementation((sql, ...args) => {
      if (sql === "INSERT OR REPLACE INTO catalog_snapshots VALUES (?,NULL,?,?,?)") throw new Error("injected provider write failure");
      return run(sql, ...args);
    });
    const result = await refreshPiCatalogFromNetwork();
    expect(result.error).toContain("injected provider write failure");
    expect(getCatalog()).toMatchObject({ models: old, fetchedAt: 100 });
    expect(getProviderOverlays()).toEqual({ xai: { models: old, checkedAt: 100 } });
    expect(state.refreshAll).not.toHaveBeenCalled();
  });

  it("buildProviderOverlaysFromFetch shapes ModelsStoreEntry with lastModified/etag", () => {
    const models = [
      { id: "grok-4.6", provider: "xai", api: "openai-completions", contextWindow: 1e6 },
      { id: "grok-4.3", provider: "xai", api: "openai-completions", contextWindow: 1e6 },
      { id: "k3", provider: "moonshotai", api: "openai-completions", contextWindow: 2e5 },
    ];
    const meta = new Map([
      ["xai", { lastModified: 1_787_000_000_000, etag: "\"xai-etag\"", models: models.filter((m) => m.provider === "xai") }],
    ]);
    const overlays = buildProviderOverlaysFromFetch(models, meta, 1_787_000_000_100);
    expect(Object.keys(overlays).sort()).toEqual(["moonshotai", "xai"]);
    expect(overlays.xai.lastModified).toBe(1_787_000_000_000);
    expect(overlays.xai.etag).toBe("\"xai-etag\"");
    expect(overlays.xai.models.map((m: any) => m.id).sort()).toEqual(["grok-4.3", "grok-4.6"]);
    expect(overlays.moonshotai.lastModified).toBe(1_787_000_000_100); // fallback fetchedAt
    expect(overlays.moonshotai.models).toHaveLength(1);
  });

  it("real SDK accepts only overlays newer than its bundled generation", async () => {
    const generatedAt = getBuiltinModelDataGeneratedAt()!;
    expect(Number.isFinite(generatedAt)).toBe(true);
    const models = [{ provider: "xai", id: "settings-finish-remote", name: "Remote",
      api: "openai-completions", baseUrl: "https://example.test/v1", contextWindow: 10000,
      maxTokens: 1000, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }];
    await ensurePiCatalogWarm();
    const profile = connectBuiltinProviderApiKey({ providerSlug: "xai", apiKey: "fixture-xai-key" });
    const runtime = await ModelRuntime.create({
      credentials: createCredentialStore(profile),
      modelsPath: null, modelsStore: createDatabaseModelsStore(), allowModelNetwork: false,
    });
    for (const [lastModified, accepted] of [[generatedAt - 1, false], [generatedAt, false], [generatedAt + 1, true]] as const) {
      commitProviderOverlays({ xai: { models, lastModified, checkedAt: lastModified } });
      const result = await runtime.refresh({ allowNetwork: false });
      expect(result.errors.size).toBe(0);
      expect(!!runtime.getModel("xai", "settings-finish-remote")).toBe(accepted);
    }
  });

  it("distribution commits SQL and refreshes live registries without scanning room/DM files", async () => {
    const root = getBossmodePiRuntimeRoot();
    const dirs = [join(root, "roomA", "member"), join(root, "members", "member", "dm")];
    for (const dir of dirs) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "models.json"), "legacy-not-authority");
    }
    const overlays = { xai: { models: [{ id: "grok-4.6", provider: "xai", contextWindow: 1e6 }],
      lastModified: 100, checkedAt: 200, etag: '"e1"' } };
    expect(publishProviderModels(overlays)).toBeUndefined();
    await vi.waitFor(() => expect(state.refreshAll).toHaveBeenCalledTimes(1));
    fixture.reopen();
    expect(getProviderOverlays()).toEqual(overlays);
    expect(await createDatabaseModelsStore().read("xai")).toEqual(overlays.xai);
    for (const dir of dirs) {
      expect(existsSync(join(dir, "models-store.json"))).toBe(false);
      expect(readFileSync(join(dir, "models.json"), "utf8")).toBe("legacy-not-authority");
    }
  });

  it("getProviderOverlays synthesizes provider groups and timestamps from the SQL remote catalog", () => {
    commitRemoteCatalog([
      { id: "grok-4.6", provider: "xai" }, { id: "k3", provider: "moonshotai" },
    ], 1_787_100_000_000);
    fixture.reopen();
    expect(getProviderOverlays()).toEqual({
      xai: { models: [{ id: "grok-4.6", provider: "xai" }], lastModified: 1_787_100_000_000, checkedAt: 1_787_100_000_000 },
      moonshotai: { models: [{ id: "k3", provider: "moonshotai" }], lastModified: 1_787_100_000_000, checkedAt: 1_787_100_000_000 },
    });
  });

  it("empty distribution preserves last-good rows and creates no runtime file tree", async () => {
    const overlays = { xai: { models: [{ id: "retained", provider: "xai" }], checkedAt: 100 } };
    commitProviderOverlays(overlays);
    expect(publishProviderModels({})).toBeUndefined();
    await vi.waitFor(() => expect(state.refreshAll).toHaveBeenCalledTimes(1));
    expect(getProviderOverlays()).toEqual(overlays);
    expect(existsSync(getBossmodePiRuntimeRoot())).toBe(false);
  });

  it("failed SQL distribution rolls back all providers and never notifies live registries", async () => {
    const original = { xai: { models: [{ id: "retained", provider: "xai" }], checkedAt: 100 } };
    commitProviderOverlays(original);
    expect(() => publishProviderModels({
      xai: { models: [{ id: "replacement", provider: "xai" }], checkedAt: 200 },
      broken: { models: [{ noIdentity: true }], checkedAt: 200 },
    })).toThrow("identity");
    await Promise.resolve();
    expect(state.refreshAll).not.toHaveBeenCalled();
    fixture.reopen();
    expect(getProviderOverlays()).toEqual(original);
  });
});
