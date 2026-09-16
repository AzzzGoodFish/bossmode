import { getDefaultConfig, readConfig, writeConfig } from "../../src/config/settings.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";

import * as catalog from "../../src/config/catalog.js";

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
    const mod = await import("../../src/config/models.js"), __mod_catalog = await import("../../src/config/catalog.js");
    expect(__mod_catalog.getCatalogAutoRefreshIntervalDays()).toBe(7);
    expect(__mod_catalog.DEFAULT_CATALOG_AUTO_REFRESH_DAYS).toBe(7);

    expect(__mod_catalog.setCatalogAutoRefreshIntervalDays(30)).toBe(30);
    fixture.reopen();
    expect(readConfig().catalog?.autoRefreshIntervalDays).toBe(30);
    expect(__mod_catalog.getCatalogAutoRefreshIntervalDays()).toBe(30);

    expect(__mod_catalog.setCatalogAutoRefreshIntervalDays(0)).toBe(0);
    expect(__mod_catalog.getCatalogAutoRefreshIntervalDays()).toBe(0);
    // never due when off
    expect(__mod_catalog.isCatalogRefreshDue()).toBe(false);
  });

  it("is due when never fetched remotely; not due right after a fresh remote commit", async () => {
    const catalog = await import("../../src/config/catalog.js");
    const mod = await import("../../src/config/models.js"), __mod_catalog = await import("../../src/config/catalog.js");
    catalog.clearRemoteCatalogMemoryForTests();
    catalog.setBundledCatalogLoader(() => [{ provider: "x", id: "bundled" }]);
    __mod_catalog.setCatalogAutoRefreshIntervalDays(7);

    expect(__mod_catalog.isCatalogRefreshDue()).toBe(true);

    catalog.commitRemoteCatalog([{ provider: "kimi-coding", id: "k3" }], Date.now());
    expect(__mod_catalog.isCatalogRefreshDue()).toBe(false);

    // Advance only the clock; freshness still comes from committed SQL.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(__mod_catalog.isCatalogRefreshDue()).toBe(true);
  });

  it("getCatalogSettingsPublic exposes interval + due flag + status", async () => {
    const catalog = await import("../../src/config/catalog.js");
    const mod = await import("../../src/config/models.js"), __mod_catalog = await import("../../src/config/catalog.js");
    catalog.clearRemoteCatalogMemoryForTests();
    catalog.setBundledCatalogLoader(() => [{ provider: "x", id: "y" }]);
    __mod_catalog.setCatalogAutoRefreshIntervalDays(7);
    const pub = __mod_catalog.getCatalogSettingsPublic();
    expect(pub.autoRefreshIntervalDays).toBe(7);
    expect(pub.refreshDue).toBe(true);
    expect(pub.status.source).toBe("bundled");
  });
});
