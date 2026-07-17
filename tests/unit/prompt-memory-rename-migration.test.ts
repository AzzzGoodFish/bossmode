import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  roomDir: (roomId: string) => join(dir, "rooms", roomId),
  getRoomsDir: () => join(dir, "rooms"),
}));

describe("prompt-memory-rename-v1 migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-memrename-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedMemory(roomId: string, kind: "principles" | "mainline", filename: string, content: string) {
    const subdir = kind === "principles" ? "prompt-supplements" : "mainlines";
    const target = join(dir, "rooms", roomId, subdir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, filename), content);
  }

  it("rewrites *_asset tool references in principles and mainline files", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    seedMemory("room1", "principles", "qa.md", "Use read_asset to check, edit_asset to tweak, write_asset to rewrite.");
    seedMemory("room1", "mainline", "qa.md", "- docs/x.md — see write_asset\n");

    migration.runPromptMemoryRenameMigration();

    const principles = readFileSync(join(dir, "rooms", "room1", "prompt-supplements", "qa.md"), "utf-8");
    const mainline = readFileSync(join(dir, "rooms", "room1", "mainlines", "qa.md"), "utf-8");
    expect(principles).toBe("Use read_memory to check, edit_memory to tweak, write_memory to rewrite.");
    expect(mainline).toBe("- docs/x.md — see write_memory\n");

    // Snapshot was taken
    const snapshots = readdirSync(join(dir, "pi-agent", "runtime", ".migration-snapshots"));
    expect(snapshots.length).toBeGreaterThan(0);
  });

  it("leaves files without asset references untouched and is idempotent", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    const content = "No tool references here, just rules.";
    seedMemory("room1", "principles", "qa.md", content);

    migration.runPromptMemoryRenameMigration();
    expect(readFileSync(join(dir, "rooms", "room1", "prompt-supplements", "qa.md"), "utf-8")).toBe(content);

    // Second run: no changes
    migration.runPromptMemoryRenameMigration();
    expect(readFileSync(join(dir, "rooms", "room1", "prompt-supplements", "qa.md"), "utf-8")).toBe(content);
  });

  it("skips rooms with no memory directories", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    mkdirSync(join(dir, "rooms", "empty-room"), { recursive: true });
    expect(() => migration.runPromptMemoryRenameMigration()).not.toThrow();
  });
});
