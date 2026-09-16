// Tests for the 0.7.0 → 0.8.0 "single namespace" migration.
//
// Scenarios:
//   1. Two KB dirs → docs/<slug>/ with rooms rewritten
//   2. Idempotency: running twice doesn't re-migrate
//   3. Collision: two KBs with same slug get suffixed
//   4. Room with knowledgeBaseId but no matching KB: field is cleaned, paths untouched
//   5. Fresh install (no KBs): just creates docs/ root

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string = "";
vi.mock("../../src/config/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => {},
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
  seedTemplates: () => {},
}));

function setupKB(kbId: string, name: string, docs: Record<string, string>) {
  const kbDir = join(tmpDir, "knowledge", kbId);
  mkdirSync(join(kbDir, "docs"), { recursive: true });
  writeFileSync(
    join(kbDir, "knowledge.json"),
    JSON.stringify({ id: kbId, name, description: "", createdAt: Date.now() }),
    "utf-8",
  );
  for (const [path, content] of Object.entries(docs)) {
    const abs = join(kbDir, "docs", path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
  // Mark as already-phase-1-migrated so runKnowledgeMigration skips entries parsing
  writeFileSync(join(kbDir, ".migrated"), "1", "utf-8");
}

function setupRoom(roomId: string, roomJson: Record<string, unknown>) {
  const dir = join(tmpDir, "rooms", roomId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "room.json"), JSON.stringify(roomJson, null, 2), "utf-8");
}

function readRoom(roomId: string): any {
  return JSON.parse(readFileSync(join(tmpDir, "rooms", roomId, "room.json"), "utf-8"));
}

describe("Knowledge migration: single namespace (0.8.0)", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bossmode-kb-mig-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates two KBs into docs/<slug>/ and rewrites room refs", async () => {
    setupKB("abc123", "Bossmode", {
      "rules/protocol.md": "---\ntitle: Protocol\n---\nBody",
      "architecture/map.md": "---\ntitle: Map\n---\nBody",
    });
    setupKB("def456", "FreeU", {
      "rules/protocol.md": "---\ntitle: Protocol\n---\nBody",
    });
    setupRoom("room-a", {
      id: "room-a", name: "Bossmode dev", cwd: "/tmp", members: [], createdAt: 1,
      knowledgeBaseId: "abc123", ruleDocs: ["rules/protocol.md"],
    });
    setupRoom("room-b", {
      id: "room-b", name: "FreeU dev", cwd: "/tmp", members: [], createdAt: 2,
      knowledgeBaseId: "def456", ruleDocs: ["rules/protocol.md"],
    });

    const { runKnowledgeMigration } = await import("../../src/knowledge/migration.js");
    runKnowledgeMigration();

    // docs/<slug>/ exists
    expect(existsSync(join(tmpDir, "knowledge", "docs", "bossmode", "rules", "protocol.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "knowledge", "docs", "bossmode", "architecture", "map.md"))).toBe(true);
    expect(existsSync(join(tmpDir, "knowledge", "docs", "freeu", "rules", "protocol.md"))).toBe(true);
    // Original KB dirs renamed to .legacy
    expect(existsSync(join(tmpDir, "knowledge", "abc123.legacy"))).toBe(true);
    expect(existsSync(join(tmpDir, "knowledge", "def456.legacy"))).toBe(true);
    expect(existsSync(join(tmpDir, "knowledge", "abc123"))).toBe(false);

    // Rooms rewritten: knowledgeBaseId removed, ruleDocs prefixed with slug
    const roomA = readRoom("room-a");
    expect(roomA.knowledgeBaseId).toBeUndefined();
    expect(roomA.ruleDocs).toEqual(["bossmode/rules/protocol.md"]);
    const roomB = readRoom("room-b");
    expect(roomB.knowledgeBaseId).toBeUndefined();
    expect(roomB.ruleDocs).toEqual(["freeu/rules/protocol.md"]);

    // Backups written
    expect(existsSync(join(tmpDir, "rooms", "room-a", "room.json.pre-0.8.0-backup"))).toBe(true);
    expect(existsSync(join(tmpDir, "rooms", "room-b", "room.json.pre-0.8.0-backup"))).toBe(true);
  });

  it("is idempotent: running twice does not duplicate files or corrupt rooms", async () => {
    setupKB("abc123", "Bossmode", {
      "rules/protocol.md": "---\ntitle: Protocol\n---\nBody",
    });
    setupRoom("room-a", {
      id: "room-a", name: "X", cwd: "/tmp", members: [], createdAt: 1,
      knowledgeBaseId: "abc123", ruleDocs: ["rules/protocol.md"],
    });

    const { runKnowledgeMigration } = await import("../../src/knowledge/migration.js");
    runKnowledgeMigration();
    const firstRoom = readRoom("room-a");
    const firstBackup = readFileSync(join(tmpDir, "rooms", "room-a", "room.json.pre-0.8.0-backup"), "utf-8");

    runKnowledgeMigration();
    const secondRoom = readRoom("room-a");
    const secondBackup = readFileSync(join(tmpDir, "rooms", "room-a", "room.json.pre-0.8.0-backup"), "utf-8");

    expect(secondRoom).toEqual(firstRoom); // no re-prefix
    expect(secondBackup).toBe(firstBackup); // backup preserved
    expect(existsSync(join(tmpDir, "knowledge", "docs", "bossmode", "rules", "protocol.md"))).toBe(true);
  });

  it("resolves slug collision when two KBs share the same name", async () => {
    setupKB("id-1", "Project", { "a.md": "c" });
    setupKB("id-2", "Project", { "b.md": "c" });

    const { runKnowledgeMigration } = await import("../../src/knowledge/migration.js");
    runKnowledgeMigration();

    const docs = join(tmpDir, "knowledge", "docs");
    // One becomes "project", the other "project-2" (order depends on readdir)
    const project = existsSync(join(docs, "project"));
    const project2 = existsSync(join(docs, "project-2"));
    expect(project).toBe(true);
    expect(project2).toBe(true);
  });

  it("cleans orphaned knowledgeBaseId on rooms even when no KBs exist", async () => {
    // No KBs, but a room points to a non-existent KB
    setupRoom("room-a", {
      id: "room-a", name: "X", cwd: "/tmp", members: [], createdAt: 1,
      knowledgeBaseId: "ghost", ruleDocs: ["rules/x.md"],
    });

    const { runKnowledgeMigration } = await import("../../src/knowledge/migration.js");
    runKnowledgeMigration();

    const room = readRoom("room-a");
    expect(room.knowledgeBaseId).toBeUndefined();
    // With no slug map, ruleDocs is left as-is (user may fix paths manually)
    expect(room.ruleDocs).toEqual(["rules/x.md"]);
  });

  it("fresh install (no KBs): creates docs/ root and no errors", async () => {
    const { runKnowledgeMigration } = await import("../../src/knowledge/migration.js");
    runKnowledgeMigration();
    expect(existsSync(join(tmpDir, "knowledge", "docs"))).toBe(true);
  });
});
