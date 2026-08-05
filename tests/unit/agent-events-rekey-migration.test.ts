/**
 * F5 migration — agent-events-rekey-v1: rekeys legacy artifact keys (name /
 * rm_) to the member's mem_ identity via the room roster evidence chain;
 * discards derived projections (stats caches, activity-index rows) for
 * re-derivation; leaves unresolvable orphans in place with a warn; is
 * data-driven idempotent (re-run = no-op once no resolvable legacy files).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

function seedAgent(name: string) {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: \"${name}\"\n---\n\nYou are ${name}.\n`, "utf-8");
}

async function seedRoom(roomId: string, memberIds: string[], names: string[]) {
  const dirPath = join(dir, "rooms", roomId);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, "room.json"), JSON.stringify({
    id: roomId,
    name: roomId,
    cwd: dir,
    members: names,
    roomMembers: names.map((name, i) => ({
      id: `rm_${i}`,
      roomId,
      name,
      sourceAgent: name,
      sourceMemberId: memberIds[i] || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    globalMemberIds: memberIds,
    createdAt: Date.now(),
  }), "utf-8");
}

function eventsDir(roomId: string): string {
  return join(dir, "rooms", roomId, "agent-events");
}

function seedEventFile(roomId: string, ref: string, events: Array<{ type: string; ts: number; text?: string }>) {
  const d = eventsDir(roomId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${ref}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function seedStats(roomId: string, ref: string, turns: number) {
  const d = eventsDir(roomId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${ref}.stats.json`), JSON.stringify({ turns, toolCalls: turns, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }), "utf-8");
}

function lineCount(roomId: string, ref: string): number {
  const p = join(eventsDir(roomId), `${ref}.jsonl`);
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).length;
}

describe("F5 agent-events rekey migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-f5-rekey-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    seedAgent("architect");
    seedAgent("designer");
    vi.resetModules();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("renames a bare-name legacy key to the mem_ identity via roster sourceMemberId", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    seedEventFile("room-1", "architect", [
      { type: "agent_start", ts: 1000 },
      { type: "agent_end", ts: 1500 },
      { type: "agent_reply", ts: 2000, text: "old history" },
    ]);
    seedStats("room-1", "architect", 7);

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    const result = runAgentEventsRekeyMigration();

    expect(existsSync(join(eventsDir("room-1"), "architect.jsonl"))).toBe(false);
    expect(lineCount("room-1", arch.id)).toBe(3);
    expect(existsSync(join(eventsDir("room-1"), "architect.stats.json"))).toBe(false);
    // Re-derived in the same run: mem cache rebuilt from the merged jsonl
    expect(readFileSync(join(eventsDir("room-1"), `${arch.id}.stats.json`), "utf-8")).toBeTruthy();
    expect(result.filesRenamed).toBe(1);
    expect(result.statsCachesRemoved).toBe(1); // old cache discarded (mem cache didn't exist)
    expect(result.roomsWithChanges).toBe(1);
    // Same-run re-derivation: stats cache rebuilt from the merged jsonl
    const rederived = JSON.parse(readFileSync(join(eventsDir("room-1"), `${arch.id}.stats.json`), "utf-8"));
    expect(rederived.turns).toBe(1); // one completed agent_start→agent_end pair
  });

  it("merges legacy + current jsonl (old segment first, ts-ordered), keeps line count", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    seedEventFile("room-1", "architect", [
      { type: "agent_start", ts: 1000 },
      { type: "agent_reply", ts: 3000, text: "pre-0.20" },
    ]);
    seedEventFile("room-1", arch.id, [
      { type: "agent_start", ts: 3500 },
      { type: "agent_reply", ts: 4000, text: "post-0.20" },
    ]);

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    const result = runAgentEventsRekeyMigration();

    expect(existsSync(join(eventsDir("room-1"), "architect.jsonl"))).toBe(false);
    expect(lineCount("room-1", arch.id)).toBe(4);
    const merged = readFileSync(join(eventsDir("room-1"), `${arch.id}.jsonl`), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l).ts);
    expect(merged).toEqual([1000, 3000, 3500, 4000]); // legacy segment first, merge point monotonic (3000 < 3500)
    expect(result.filesMerged).toBe(1);
  });

  it("ts-sorts on non-monotonic merge point but still merges", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    seedEventFile("room-1", "architect", [{ type: "agent_reply", ts: 5000, text: "late legacy" }]);
    seedEventFile("room-1", arch.id, [{ type: "agent_reply", ts: 4000, text: "early current" }]);

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    const result = runAgentEventsRekeyMigration();

    expect(lineCount("room-1", arch.id)).toBe(2);
    const merged = readFileSync(join(eventsDir("room-1"), `${arch.id}.jsonl`), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l).ts);
    expect(merged).toEqual([4000, 5000]); // ts-sorted
    expect(result.filesMerged).toBe(1);
  });

  it("resolves rm_ keys via roster id → sourceMemberId", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    seedEventFile("room-1", "rm_0", [{ type: "agent_start", ts: 100 }]);

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    runAgentEventsRekeyMigration();

    expect(existsSync(join(eventsDir("room-1"), "rm_0.jsonl"))).toBe(false);
    expect(lineCount("room-1", arch.id)).toBe(1);
  });

  it("keeps unresolvable orphans in place + reports them; re-run is a no-op", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    seedEventFile("room-1", "architect", [{ type: "agent_start", ts: 1 }]);
    seedEventFile("room-1", "ghost-who", [{ type: "agent_start", ts: 2 }]);

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    const first = runAgentEventsRekeyMigration();
    expect(first.orphans).toEqual([{ roomId: "room-1", key: "ghost-who" }]);
    expect(existsSync(join(eventsDir("room-1"), "ghost-who.jsonl"))).toBe(true);

    // Re-run: the resolvable legacy file is gone → no further changes
    const second = runAgentEventsRekeyMigration();
    expect(second.roomsWithChanges).toBe(0);
    expect(second.skipped).toBe(true);
    expect(existsSync(join(eventsDir("room-1"), "ghost-who.jsonl"))).toBe(true);

    // P1 gate: re-run with nothing to migrate snapshots NOTHING (no backups dir)
    const backups = join(dir, "backups");
    const snapCount = existsSync(backups) ? readdirSync(backups).filter((d) => d.startsWith("agent-events-rekey-")).length : 0;
    expect(snapCount).toBe(1); // only the first run's snapshot exists
  });

  it("skips dm: phantom rooms", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    seedEventFile("room-1", "architect", [{ type: "agent_start", ts: 1 }]);
    const dmDir = eventsDir(`dm:${arch.id}`);
    mkdirSync(dmDir, { recursive: true });
    writeFileSync(join(dmDir, `${arch.id}.jsonl`), JSON.stringify({ type: "agent_start", ts: 1 }) + "\n", "utf-8");

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    const result = runAgentEventsRekeyMigration();
    expect(result.roomsWithChanges).toBe(1); // only room-1 changed
    expect(existsSync(join(dmDir, `${arch.id}.jsonl`))).toBe(true); // dm dir untouched
  });

  it("snapshots affected rooms to backups/ before mutating", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    seedEventFile("room-1", "architect", [{ type: "agent_start", ts: 1 }]);

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    runAgentEventsRekeyMigration();

    const backups = join(dir, "backups");
    const snapDirs = readdirSync(backups).filter((d) => d.startsWith("agent-events-rekey-"));
    expect(snapDirs.length).toBe(1);
    expect(existsSync(join(backups, snapDirs[0], "room-1", "architect.jsonl"))).toBe(true);
  });

  it("deletes stale activity-index rows and re-backfills under the mem_ key", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    await seedRoom("room-1", [arch.id], ["architect"]);
    // name key: 2 turns (10 indexed rows); mem key: 1 turn (5 indexed rows)
    const turn = (startTs: number) => [
      { type: "agent_start", ts: startTs },
      { type: "tool_start", ts: startTs + 1, toolName: "read", args: { path: "x" } },
      { type: "tool_end", ts: startTs + 2, toolName: "read" },
      { type: "message_end", ts: startTs + 3, text: "done" },
      { type: "agent_end", ts: startTs + 4 },
    ];
    seedEventFile("room-1", "architect", [...turn(1000), ...turn(2000)]);
    seedEventFile("room-1", arch.id, turn(3000));

    const { rebuildProjection } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const { countActivityRows } = await import("../../src/workspace/db/activity-index.js");
    const { getProjectionDb } = await import("../../src/workspace/db/projection.js");
    const db = getProjectionDb()!;
    // Existing backfill dedup: when a member has both id- and name-keyed files,
    // the name-keyed file is skipped (id-keyed wins) — the "0 turns" reality.
    expect(countActivityRows(db, "room-1", "architect")).toBe(0);
    expect(countActivityRows(db, "room-1", arch.id)).toBe(5);

    const { runAgentEventsRekeyMigration } = await import("../../src/workspace/agent-events-rekey-migration.js");
    const result = runAgentEventsRekeyMigration();
    expect(result.dbRowsRemoved).toBeGreaterThan(0);

    // Old-key rows deleted; all 15 rows re-indexed under the single mem_ key
    expect(countActivityRows(db, "room-1", "architect")).toBe(0);
    expect(countActivityRows(db, "room-1", arch.id)).toBe(15);
  });
});
