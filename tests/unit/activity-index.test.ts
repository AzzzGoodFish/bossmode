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

  it("healMissingIndexedSeqs fills pre-watermark INDEXED gaps without double-counting tokens", async () => {
    const roomId = "room-heal";
    const memberId = "rm_heal";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    // History written when user_steer was NOT in INDEXED_TYPES (simulated by
    // backfilling only non-steer types via a full rebuild of a file without steers,
    // then appending steers into the middle-era by rewriting file with steers and
    // leaving watermark at end with steers missing from index).
    const history = [
      ev("agent_start", base),
      ev("user_steer", base + 1, { text: "mid-turn @ UNIQUE_HEAL_STEER_1" }),
      ev("message_end", base + 2, {
        text: "done",
        usage: { inputTokens: 100, outputTokens: 20, cost: 0.01 },
        model: "anthropic/claude-sonnet-4-6",
      }),
      ev("user_steer", base + 3, { text: "UNIQUE_HEAL_STEER_2" }),
      ev("agent_end", base + 4),
    ];
    writeEventsFile(roomId, memberId, history);

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const db = getProjectionDb()!;

    // Snapshot token usage after full backfill (steers present → already indexed).
    const tokensAfterFull = db.all<{ input_tokens: number; output_tokens: number; cost: number }>(
      "SELECT input_tokens, output_tokens, cost FROM token_usage_daily WHERE room_id = ? AND member_id = ?",
      roomId,
      memberId,
    );
    expect(tokensAfterFull.length).toBe(1);
    expect(tokensAfterFull[0].input_tokens).toBe(100);

    // Simulate the production gap: delete user_steer rows only, leave watermark at end.
    db.run(
      "DELETE FROM activity_events WHERE room_id = ? AND member_id = ? AND type = ?",
      roomId,
      memberId,
      "user_steer",
    );
    const { countActivityRows, healMissingIndexedSeqs, queryActivityPage } = await import(
      "../../src/workspace/db/activity-index.js"
    );
    const beforeHeal = countActivityRows(db, roomId, memberId);
    // 5 indexed types in file minus 2 steers = 3 remaining
    expect(beforeHeal).toBe(3);

    const filePath = join(eventsDir(roomId), `${memberId}.jsonl`);
    const first = healMissingIndexedSeqs(db, roomId, memberId, filePath);
    expect(first.healed).toBe(2);
    expect(first.tokenRows).toBe(0); // steers have no usage; message_end already indexed
    expect(countActivityRows(db, roomId, memberId)).toBe(5);

    const page = queryActivityPage(roomId, memberId, { limit: 50 })!;
    const steers = (page.events as Array<{ type: string; text?: string }>).filter((e) => e.type === "user_steer");
    expect(steers).toHaveLength(2);
    expect(steers.some((s) => String(s.text).includes("UNIQUE_HEAL_STEER_1"))).toBe(true);

    // Token snapshot unchanged (no double-count).
    const tokensAfterHeal = db.all<{ input_tokens: number; output_tokens: number; cost: number }>(
      "SELECT input_tokens, output_tokens, cost FROM token_usage_daily WHERE room_id = ? AND member_id = ?",
      roomId,
      memberId,
    );
    expect(tokensAfterHeal).toEqual(tokensAfterFull);

    // Idempotent second run.
    const second = healMissingIndexedSeqs(db, roomId, memberId, filePath);
    expect(second.healed).toBe(0);
    expect(countActivityRows(db, roomId, memberId)).toBe(5);
    expect(
      db.all(
        "SELECT input_tokens, output_tokens, cost FROM token_usage_daily WHERE room_id = ? AND member_id = ?",
        roomId,
        memberId,
      ),
    ).toEqual(tokensAfterFull);
  });

  it("healAllMissingIndexedSeqs honors name-keyed dedup (id-keyed wins)", async () => {
    const roomId = "room-dedup";
    const memberId = "rm_dedup";
    const name = "dev";
    writeRoom(roomId, [{ id: memberId, name, sourceAgent: "developer" }]);
    // Both id-keyed and name-keyed files present; name-keyed is legacy subset.
    writeEventsFile(roomId, memberId, [
      ev("agent_start", base),
      ev("user_steer", base + 1, { text: "id-keyed-steer" }),
      ev("agent_end", base + 2),
    ]);
    writeEventsFile(roomId, name, [
      ev("agent_start", base),
      ev("user_steer", base + 1, { text: "name-keyed-steer-should-skip" }),
      ev("agent_end", base + 2),
    ]);

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const db = getProjectionDb()!;
    // Drop steers to force heal.
    db.run(
      "DELETE FROM activity_events WHERE room_id = ? AND type = ?",
      roomId,
      "user_steer",
    );

    const { healAllMissingIndexedSeqs, queryActivityPage } = await import(
      "../../src/workspace/db/activity-index.js"
    );
    const summary = healAllMissingIndexedSeqs(db);
    expect(summary.skippedNameKeyed).toBeGreaterThanOrEqual(1);
    expect(summary.healed).toBe(1);

    const page = queryActivityPage(roomId, memberId, { limit: 50 })!;
    const steers = (page.events as Array<{ type: string; text?: string }>).filter((e) => e.type === "user_steer");
    expect(steers).toHaveLength(1);
    expect(String(steers[0].text)).toContain("id-keyed-steer");
    expect(String(steers[0].text)).not.toContain("name-keyed-steer-should-skip");
  });
