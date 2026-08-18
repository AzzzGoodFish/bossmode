import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dir: "",
  refreshAll: vi.fn(async () => ({ refreshed: 1, failed: 0 })),
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
  ensureBossmodeDir: () => { mkdirSync(state.dir, { recursive: true }); },
  readConfig: () => ({ runtime: {}, defaults: {} }),
  writeConfig: vi.fn(),
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  refreshAllInstanceModelRegistries: () => state.refreshAll(),
}));

// Import after mocks
import {
  buildProviderOverlaysFromFetch,
  listMemberAgentDirs,
  writeModelsStoreFile,
  distributeModelsStoreOverlays,
  getBossmodePiRuntimeRoot,
} from "../../src/engine/model-credentials.js";
import {
  commitProviderOverlays,
  getProviderOverlays,
  clearProviderOverlaysMemoryForTests,
  clearRemoteCatalogMemoryForTests,
  setRemoteCatalogMemoryForTests,
} from "../../src/engine/model-catalog.js";
/**
 * Mirror of pi-coding-agent remote-catalog-provider.js `remoteModels` gate
 * (not exported). lastModified must be strictly greater than builtin generatedAt.
 */
function piRemoteModelsGate(
  entry: { models: readonly unknown[]; lastModified?: number } | undefined,
  localGeneratedAt: number | undefined,
): readonly unknown[] {
  if (!entry) return [];
  if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
    return [];
  }
  return entry.models;
}

describe("catalog models-store distribute", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bossmode-models-store-"));
    state.refreshAll.mockClear();
    clearProviderOverlaysMemoryForTests();
    clearRemoteCatalogMemoryForTests();
  });

  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
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

  it("written entry is accepted by pi remoteModels (lastModified > localGeneratedAt)", () => {
    const localGeneratedAt = 1_784_983_459_521; // pi getBuiltinModelDataGeneratedAt sample
    const entry = {
      models: [{ id: "grok-4.6", provider: "xai", api: "openai-completions" }],
      lastModified: Date.now(),
      checkedAt: Date.now(),
    };
    // Same gate withRemoteCatalog uses before merging overlay models.
    const accepted = piRemoteModelsGate(entry, localGeneratedAt) as Array<{ id: string }>;
    expect(accepted).toHaveLength(1);
    expect(accepted[0].id).toBe("grok-4.6");

    // Stale lastModified is rejected
    const rejected = piRemoteModelsGate({ ...entry, lastModified: localGeneratedAt - 1 }, localGeneratedAt);
    expect(rejected).toHaveLength(0);
  });

  it("listMemberAgentDirs finds room + dm agent dirs", () => {
    const root = getBossmodePiRuntimeRoot();
    mkdirSync(join(root, "roomA", "rm_dev"), { recursive: true });
    writeFileSync(join(root, "roomA", "rm_dev", "models.json"), "{}");
    mkdirSync(join(root, "members", "mem_x", "dm"), { recursive: true });
    writeFileSync(join(root, "members", "mem_x", "dm", "models.json"), "{}");
    const dirs = listMemberAgentDirs(root);
    expect(dirs.some((d) => d.endsWith(join("roomA", "rm_dev")))).toBe(true);
    expect(dirs.some((d) => d.includes(join("members", "mem_x", "dm")))).toBe(true);
  });

  it("distributeModelsStoreOverlays writes models-store.json and triggers live refresh", async () => {
    const root = getBossmodePiRuntimeRoot();
    const agentDir = join(root, "roomB", "rm_qa");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), "{}");

    const overlays = {
      xai: {
        models: [{ id: "grok-4.6", provider: "xai", api: "openai-completions", contextWindow: 1e6 }],
        lastModified: Date.now(),
        checkedAt: Date.now(),
        etag: "\"e1\"",
      },
    };
    commitProviderOverlays(overlays);
    const result = distributeModelsStoreOverlays(overlays);
    expect(result.written).toBeGreaterThanOrEqual(1);

    const path = join(agentDir, "models-store.json");
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.xai.models[0].id).toBe("grok-4.6");
    expect(typeof parsed.xai.lastModified).toBe("number");
    expect(parsed.xai.etag).toBe("\"e1\"");

    // live refresh is fire-and-forget; give microtask a tick
    await new Promise((r) => setTimeout(r, 20));
    expect(state.refreshAll).toHaveBeenCalled();
  });

  it("getProviderOverlays synthesizes from remote catalog memory when no dedicated overlays", () => {
    setRemoteCatalogMemoryForTests([
      { id: "grok-4.6", provider: "xai" },
      { id: "k3", provider: "moonshotai" },
    ], 1_787_100_000_000);
    const overlays = getProviderOverlays();
    expect(overlays.xai.models[0].id).toBe("grok-4.6");
    expect(overlays.xai.lastModified).toBe(1_787_100_000_000);
  });

  it("writeModelsStoreFile is a no-op for empty overlays", () => {
    const dir = join(state.dir, "empty-agent");
    mkdirSync(dir, { recursive: true });
    writeModelsStoreFile(dir, {});
    expect(existsSync(join(dir, "models-store.json"))).toBe(false);
  });
});
