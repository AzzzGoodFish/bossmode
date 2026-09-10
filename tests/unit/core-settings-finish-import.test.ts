import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { getCatalog, hydrateCatalogFromDisk, setBundledCatalogLoader } from "../../src/engine/model-catalog.js";
import { readConfig } from "../../src/shared/config.js";
import { readMcpConfigText } from "../../src/shared/mcp-settings.js";
import { discoverLegacyInventory } from "../../src/storage/legacy-inventory.js";
import { importLegacySettings } from "../../src/storage/upgrade-settings.js";
import type { UpgradeImportContext } from "../../src/storage/upgrade-runner.js";

// Intentionally no fixture/bootstrap for this negative case.
it("settings, MCP and bundled catalog access require explicit database bootstrap", () => {
  expect(() => readConfig()).toThrow("bootstrap");
  expect(() => readMcpConfigText()).toThrow("bootstrap");
  expect(() => getCatalog()).toThrow("bootstrap");
  expect(() => hydrateCatalogFromDisk()).toThrow("bootstrap");
});

describe("legacy catalog timestamp conversion at the explicit SQL import boundary", () => {
  let fixture: ReturnType<typeof coreFixture>;
  beforeEach(() => { fixture = coreFixture(); });
  afterEach(() => { setBundledCatalogLoader(() => []); fixture.close(); });

  function snapshot(value: unknown) {
    const sourceRoot = join(fixture.root, "snapshot");
    mkdirSync(sourceRoot);
    const path = join(sourceRoot, "pi-catalog-remote.json");
    writeFileSync(path, JSON.stringify(value));
    const entries = discoverLegacyInventory(sourceRoot).entries;
    const ctx: UpgradeImportContext = {
      db: fixture.db, root: fixture.root, sourceRoot, previousDatabase: undefined,
      sourceFiles: entries.map(entry => entry.path), legacy: true, progress() {},
      stageAsset() { throw new Error("Unexpected catalog asset staging"); },
    };
    return { path, entries, ctx };
  }

  it("converts updatedAt when fetchedAt is absent without mutating the snapshot", () => {
    const updatedAt = "2026-07-27T06:43:24.072Z";
    const models = [{ provider: "anthropic", id: "claude-x" }];
    const { path, entries, ctx } = snapshot({ models, updatedAt });
    const source = readFileSync(path, "utf8");
    setBundledCatalogLoader(() => [{ provider: "test", id: "bundled" }]);
    hydrateCatalogFromDisk();
    expect(getCatalog().source).toBe("bundled");
    expect(importLegacySettings(ctx, entries, [])).toContain("pi-catalog-remote.json");
    fixture.reopen();
    expect(getCatalog()).toMatchObject({ source: "remote", models, fetchedAt: Date.parse(updatedAt), fetchedAtIso: updatedAt });
    expect(readFileSync(path, "utf8")).toBe(source);
  });

  it("rejects an invalid legacy timestamp rather than inventing freshness", () => {
    const { entries, ctx } = snapshot({ models: [{ provider: "test", id: "invalid" }], updatedAt: "invalid" });
    expect(() => importLegacySettings(ctx, entries, [])).toThrow("Invalid legacy catalog");
    expect(fixture.db.all("SELECT * FROM catalog_snapshots")).toEqual([]);
  });
});
