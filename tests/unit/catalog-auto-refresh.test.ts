import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { getDefaultConfig, readConfig, writeConfig } from "../../src/config/config.js";
import * as catalog from "../../src/config/model-catalog.js";

let fixture: ReturnType<typeof coreFixture>;

describe("catalog auto-refresh SQL settings", () => {
  beforeEach(() => {
    fixture = coreFixture();
    writeConfig(getDefaultConfig());
    catalog.clearRemoteCatalogMemoryForTests();
  });
  afterEach(() => {
    catalog.clearRemoteCatalogMemoryForTests();
    catalog.setBundledCatalogLoader(() => []);
    vi.restoreAllMocks();
    fixture.close();
  });

  it("defaults to 7 days and persists interval changes", async () => {
    const mod = await import("../../src/config/model-credentials.js");
    expect(mod.getCatalogAutoRefreshIntervalDays()).toBe(7);
    expect(mod.DEFAULT_CATALOG_AUTO_REFRESH_DAYS).toBe(7);

    expect(mod.setCatalogAutoRefreshIntervalDays(30)).toBe(30);
    fixture.reopen();
    expect(readConfig().catalog?.autoRefreshIntervalDays).toBe(30);
    expect(mod.getCatalogAutoRefreshIntervalDays()).toBe(30);

    expect(mod.setCatalogAutoRefreshIntervalDays(0)).toBe(0);
    expect(mod.getCatalogAutoRefreshIntervalDays()).toBe(0);
    // never due when off
    expect(mod.isCatalogRefreshDue()).toBe(false);
  });

  it("is due when never fetched remotely; not due right after a fresh remote commit", async () => {
    const catalog = await import("../../src/config/model-catalog.js");
    const mod = await import("../../src/config/model-credentials.js");
    catalog.clearRemoteCatalogMemoryForTests();
    catalog.setBundledCatalogLoader(() => [{ provider: "x", id: "bundled" }]);
    mod.setCatalogAutoRefreshIntervalDays(7);

    expect(mod.isCatalogRefreshDue()).toBe(true);

    catalog.commitRemoteCatalog([{ provider: "kimi-coding", id: "k3" }], Date.now());
    expect(mod.isCatalogRefreshDue()).toBe(false);

    // Advance only the clock; freshness still comes from committed SQL.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(mod.isCatalogRefreshDue()).toBe(true);
  });

  it("getCatalogSettingsPublic exposes interval + due flag + status", async () => {
    const catalog = await import("../../src/config/model-catalog.js");
    const mod = await import("../../src/config/model-credentials.js");
    catalog.clearRemoteCatalogMemoryForTests();
    catalog.setBundledCatalogLoader(() => [{ provider: "x", id: "y" }]);
    mod.setCatalogAutoRefreshIntervalDays(7);
    const pub = mod.getCatalogSettingsPublic();
    expect(pub.autoRefreshIntervalDays).toBe(7);
    expect(pub.refreshDue).toBe(true);
    expect(pub.status.source).toBe("bundled");
  });
});
