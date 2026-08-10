import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Point the projection DB path at a temp dir via getBossmodeDir().
let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => {
    mkdirSync(dir, { recursive: true });
  },
}));

function eventsDir(roomId: string): string {
  return join(dir, "rooms", roomId, "agent-events");
}

function writeRoom(roomId: string, members: Array<{ id: string; name: string; sourceAgent: string }>): void {
  const roomDir = join(dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  const room = {
    id: roomId,
    name: roomId,
    cwd: "/tmp",
    members: members.map((m) => m.name),
    roomMembers: members.map((m) => ({
      id: m.id, roomId, name: m.name, sourceAgent: m.sourceAgent, createdAt: 1, updatedAt: 1,
    })),
    createdAt: 1,
  };
  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room), "utf-8");
}

const base = Date.parse("2026-07-24T00:00:00Z");

function ev(type: string, ts: number, extra: Record<string, unknown> = {}): object {
  return { type, ts, ...extra };
}

/** A representative turn: agent_start, tool_start, message_end, agent_end + churn. */
function turn(startTs: number): object[] {
  return [
    ev("agent_start", startTs),
    ev("message_update", startTs + 1, { text: "partial" }), // churn — not indexed
    ev("tool_start", startTs + 2, { toolName: "read", args: { path: "x" } }),
    ev("tool_update", startTs + 3), // churn — not indexed
    ev("tool_end", startTs + 4, { toolName: "read" }),
    ev("message_end", startTs + 5, { text: "done", usage: { inputTokens: 10 } }),
    ev("agent_end", startTs + 6),
  ];
}

function writeEventsFile(roomId: string, stem: string, events: object[]): void {
  mkdirSync(eventsDir(roomId), { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(eventsDir(roomId), `${stem}.jsonl`), body, "utf-8");
}

describe("activity-index (S3)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-s3-act-"));
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetDbCache } = await import("../../src/workspace/db/sqlite.js");
    resetDbCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfill indexes only INDEXED_TYPES and queryActivityPage fetches full lines by offset", async () => {
    const roomId = "room-a";
    const memberId = "rm_abc";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    // Two turns = 2×(agent_start, tool_start, tool_end, message_end, agent_end) indexed = 10 rows.
    writeEventsFile(roomId, memberId, [...turn(base), ...turn(base + 1000)]);

    const { rebuildProjection } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();

    const { queryActivityPage, countActivityRows } = await import("../../src/workspace/db/activity-index.js");
    const { getProjectionDb } = await import("../../src/workspace/db/projection.js");
    const db = getProjectionDb()!;
    expect(countActivityRows(db, roomId, memberId)).toBe(10);

    const page = queryActivityPage(roomId, memberId, { limit: 50 })!;
    expect(page).not.toBeNull();
    expect(page.indexed).toBe(true);
    // No churn types leaked in.
    for (const e of page.events as Array<{ type: string }>) {
      expect(["message_update", "tool_update"]).not.toContain(e.type);
    }
    // Full event bodies came back (tool_start carries args, message_end carries text).
    const toolStart = (page.events as Array<Record<string, unknown>>).find((e) => e.type === "tool_start");
    expect(toolStart?.args).toEqual({ path: "x" });
    const msgEnd = (page.events as Array<Record<string, unknown>>).find((e) => e.type === "message_end");
    expect(msgEnd?.text).toBe("done");
    // Chronological order (oldest→newest).
    const seqTs = (page.events as Array<{ ts: number }>).map((e) => e.ts);
    expect(seqTs).toEqual([...seqTs].sort((a, b) => a - b));
  });

  it("paginates newest-first with beforeSeq + hasMore", async () => {
    const roomId = "room-b";
    const memberId = "rm_p";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    // 4 turns → 20 indexed rows.
    writeEventsFile(roomId, memberId, [0, 1, 2, 3].flatMap((i) => turn(base + i * 1000)));

    const { rebuildProjection } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const { queryActivityPage } = await import("../../src/workspace/db/activity-index.js");

    const first = queryActivityPage(roomId, memberId, { limit: 8 })!;
    expect(first.events.length).toBe(8);
    expect(first.hasMore).toBe(true);
    expect(first.nextBeforeSeq).toBeGreaterThan(0);

    const second = queryActivityPage(roomId, memberId, { limit: 8, beforeSeq: first.nextBeforeSeq! })!;
    expect(second.events.length).toBe(8);
    // Second page events are all older (smaller ts) than first page's oldest.
    const firstOldestTs = Math.min(...(first.events as Array<{ ts: number }>).map((e) => e.ts));
    const secondNewestTs = Math.max(...(second.events as Array<{ ts: number }>).map((e) => e.ts));
    expect(secondNewestTs).toBeLessThanOrEqual(firstOldestTs);

    const third = queryActivityPage(roomId, memberId, { limit: 8, beforeSeq: second.nextBeforeSeq! })!;
    expect(third.events.length).toBe(4);
    expect(third.hasMore).toBe(false);
    expect(third.nextBeforeSeq).toBeNull();
  });

  it("types filter restricts to requested indexed types", async () => {
    const roomId = "room-c";
    const memberId = "rm_t";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    writeEventsFile(roomId, memberId, turn(base));

    const { rebuildProjection } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const { queryActivityPage } = await import("../../src/workspace/db/activity-index.js");

    const onlyTools = queryActivityPage(roomId, memberId, { limit: 50, types: ["tool_start"] })!;
    expect(onlyTools.events.length).toBe(1);
    expect((onlyTools.events[0] as { type: string }).type).toBe("tool_start");
  });

  it("live indexAppendedEvent keeps the index current for a new append", async () => {
    const roomId = "room-d";
    const memberId = "rm_live";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    writeEventsFile(roomId, memberId, turn(base)); // 5 indexed rows

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const { countActivityRows, indexAppendedEvent } = await import("../../src/workspace/db/activity-index.js");
    const db = getProjectionDb()!;
    const before = countActivityRows(db, roomId, memberId);

    // Simulate the event-handler append: write the line, then index it.
    const filePath = join(eventsDir(roomId), `${memberId}.jsonl`);
    const { statSync } = await import("node:fs");
    const offsetBefore = statSync(filePath).size;
    const newEvent = ev("message_end", base + 9999, { text: "live!", usage: { inputTokens: 5 } });
    appendFileSync(filePath, JSON.stringify(newEvent) + "\n", "utf-8");
    // seq = line 8 (turn = 7 lines incl. churn) + 1.
    indexAppendedEvent(roomId, memberId, 8, offsetBefore, { type: "message_end", ts: base + 9999 });

    expect(countActivityRows(db, roomId, memberId)).toBe(before + 1);
    const { queryActivityPage } = await import("../../src/workspace/db/activity-index.js");
    const page = queryActivityPage(roomId, memberId, { limit: 50 })!;
    const last = page.events[page.events.length - 1] as { text: string };
    expect(last.text).toBe("live!");
  });

  it("catchUpActivityIndex backfills tail events appended without live-index", async () => {
    const roomId = "room-e";
    const memberId = "rm_catch";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    writeEventsFile(roomId, memberId, turn(base)); // indexed at backfill

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const { countActivityRows, catchUpActivityIndex } = await import("../../src/workspace/db/activity-index.js");
    const db = getProjectionDb()!;
    const before = countActivityRows(db, roomId, memberId);

    // Append a whole new turn WITHOUT calling indexAppendedEvent (simulates a gap).
    const filePath = join(eventsDir(roomId), `${memberId}.jsonl`);
    const body = turn(base + 5000).map((e) => JSON.stringify(e)).join("\n") + "\n";
    appendFileSync(filePath, body, "utf-8");

    catchUpActivityIndex(roomId, memberId);
    expect(countActivityRows(db, roomId, memberId)).toBe(before + 5); // 5 indexed rows in a turn
  });
});

  it("startup initProjection does NOT trigger heal (heal is removed from product code)", async () => {
    const roomId = "room-no-startup-heal";
    const memberId = "rm_nosh";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    writeEventsFile(roomId, memberId, [
      ev("agent_start", base),
      ev("user_steer", base + 1, { text: "should stay un-indexed; no product heal" }),
      ev("agent_end", base + 2),
    ]);

    // Backfill establishes baseline + watermark; steers indexed since user_steer is now in INDEXED_TYPES.
    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const db = getProjectionDb()!;

    // Simulate the production gap: drop user_steer rows, leave watermark past them.
    db.run("DELETE FROM activity_events WHERE room_id = ? AND type = ?", roomId, "user_steer");

    // A fresh initProjection (existing DB path) must NOT heal the gap back —
    // heal lives only in scripts/heal-activity-index.mjs now (fish 2026-08-10).
    const { initProjection } = await import("../../src/workspace/db/projection.js");
    initProjection();
    await new Promise((r) => setTimeout(r, 50));

    const steers = db
      .all<{ type: string }>("SELECT type FROM activity_events WHERE room_id = ? AND type = ?", roomId, "user_steer");
    expect(steers).toHaveLength(0); // gap persists — no product heal path exists

    // And activity-index exports no heal symbols anymore.
    const ai = await import("../../src/workspace/db/activity-index.js");
    expect((ai as any).healMissingIndexedSeqs).toBeUndefined();
    expect((ai as any).healAllMissingIndexedSeqs).toBeUndefined();
  });
