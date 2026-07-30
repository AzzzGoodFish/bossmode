import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  readConfig: () => {
    try {
      return JSON.parse(require("node:fs").readFileSync(join(dir, "config.json"), "utf-8"));
    } catch {
      return { auth: { username: "u", passwordHash: "h" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } };
    }
  },
  writeConfig: (cfg: any) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2));
  },
}));

describe("catalog auto-refresh settings", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-catalog-sched-"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({
      auth: { username: "u", passwordHash: "h" },
      apiKeys: {},
      defaults: { host: "127.0.0.1", port: 8080 },
    }));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to 7 days and persists interval changes", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    expect(mod.getCatalogAutoRefreshIntervalDays()).toBe(7);
    expect(mod.DEFAULT_CATALOG_AUTO_REFRESH_DAYS).toBe(7);

    expect(mod.setCatalogAutoRefreshIntervalDays(30)).toBe(30);
    expect(mod.getCatalogAutoRefreshIntervalDays()).toBe(30);

    expect(mod.setCatalogAutoRefreshIntervalDays(0)).toBe(0);
    expect(mod.getCatalogAutoRefreshIntervalDays()).toBe(0);
    // never due when off
    expect(mod.isCatalogRefreshDue()).toBe(false);
  });

  it("is due when never fetched remotely; not due right after a fresh remote commit", async () => {
    const catalog = await import("../../src/engine/model-catalog.js");
    const mod = await import("../../src/engine/model-credentials.js");
    catalog.clearRemoteCatalogMemoryForTests();
    catalog.setBundledCatalogLoader(() => [{ provider: "x", id: "bundled" }]);
    mod.setCatalogAutoRefreshIntervalDays(7);

    expect(mod.isCatalogRefreshDue()).toBe(true);

    catalog.commitRemoteCatalog([{ provider: "kimi-coding", id: "k3" }], Date.now());
    expect(mod.isCatalogRefreshDue()).toBe(false);

    // Age the cache beyond 7 days
    catalog.setRemoteCatalogMemoryForTests([{ provider: "kimi-coding", id: "k3" }], Date.now() - 8 * 24 * 60 * 60 * 1000);
    expect(mod.isCatalogRefreshDue()).toBe(true);
  });

  it("getCatalogSettingsPublic exposes interval + due flag + status", async () => {
    const catalog = await import("../../src/engine/model-catalog.js");
    const mod = await import("../../src/engine/model-credentials.js");
    catalog.clearRemoteCatalogMemoryForTests();
    catalog.setBundledCatalogLoader(() => [{ provider: "x", id: "y" }]);
    mod.setCatalogAutoRefreshIntervalDays(7);
    const pub = mod.getCatalogSettingsPublic();
    expect(pub.autoRefreshIntervalDays).toBe(7);
    expect(pub.refreshDue).toBe(true);
    expect(pub.status.source).toBe("bundled");
  });
});
