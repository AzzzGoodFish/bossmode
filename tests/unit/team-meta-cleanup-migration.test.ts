import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

let tempDir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

describe("team-meta-cleanup-v1 migration", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-teammeta-cleanup-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes a stale team-meta.json left over from the retired Built-in Updates feature", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "team-meta.json"), JSON.stringify({ installedVersion: "0.18.0", files: {} }), "utf-8");

    const mod = await import("../../src/workspace/team-meta-cleanup-migration.js");
    mod.runTeamMetaCleanupMigration();

    expect(existsSync(join(tempDir, "team-meta.json"))).toBe(false);
    expect(existsSync(join(tempDir, ".migrations", "team-meta-cleanup-v1.json"))).toBe(true);
  });

  it("is idempotent — a second run is a no-op and doesn't error when the file is already gone", async () => {
    const mod = await import("../../src/workspace/team-meta-cleanup-migration.js");
    mod.runTeamMetaCleanupMigration();
    expect(() => mod.runTeamMetaCleanupMigration()).not.toThrow();
    expect(existsSync(join(tempDir, ".migrations", "team-meta-cleanup-v1.json"))).toBe(true);
  });

  it("no-ops cleanly when there was never a team-meta.json (fresh install)", async () => {
    const mod = await import("../../src/workspace/team-meta-cleanup-migration.js");
    mod.runTeamMetaCleanupMigration();
    expect(existsSync(join(tempDir, "team-meta.json"))).toBe(false);
    expect(existsSync(join(tempDir, ".migrations", "team-meta-cleanup-v1.json"))).toBe(true);
  });

  it("skips re-scanning once marked done, even if a new team-meta.json reappears", async () => {
    const mod = await import("../../src/workspace/team-meta-cleanup-migration.js");
    mod.runTeamMetaCleanupMigration();
    writeFileSync(join(tempDir, "team-meta.json"), "{}", "utf-8");
    mod.runTeamMetaCleanupMigration();
    // Marker already present — migration should skip and leave this alone.
    expect(existsSync(join(tempDir, "team-meta.json"))).toBe(true);
    expect(readFileSync(join(tempDir, "team-meta.json"), "utf-8")).toBe("{}");
  });
});
