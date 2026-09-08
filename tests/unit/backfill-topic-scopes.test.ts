import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BossmodeDb } from "../../src/workspace/db/sqlite.js";

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let dir: string;
let previousDir: string | undefined;
let sqlite: typeof import("../../src/workspace/db/sqlite.js");
let projection: typeof import("../../src/workspace/db/projection.js");
let backfill: typeof import("../../src/workspace/db/backfill.js");

const roomId = "room-parent";
const memberId = "rm_engineer";
const memberName = "engineer";
const dmId = `dm:${memberId}`;
const topicId = "topic-fixture";
const topicScope = `topic:${topicId}`;
const base = Date.parse("2026-08-01T00:00:00Z");

function writeRoom(id: string): void {
  const path = join(dir, "rooms", id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "room.json"), JSON.stringify({
    id,
    name: id,
    members: [memberName],
    roomMembers: [{ id: memberId, roomId: id, name: memberName, sourceAgent: "general", createdAt: 1, updatedAt: 1 }],
    createdAt: 1,
  }));
}

function eventsDir(scope: string): string {
  return scope.startsWith("topic:")
    ? join(dir, "rooms", roomId, "topics", scope.slice("topic:".length), "agent-events")
    : join(dir, "rooms", scope, "agent-events");
}

function writeEvents(scope: string, stem: string, events: object[]): string {
  const path = eventsDir(scope);
  mkdirSync(path, { recursive: true });
  const file = join(path, `${stem}.jsonl`);
  writeFileSync(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return file;
}

function messageEnd(n: number, model?: string): object {
  return {
    type: "message_end",
    ts: base + n,
    text: "主题活动",
    ...(model === undefined ? {} : { model }),
    usage: { inputTokens: n, outputTokens: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: n / 4 },
  };
}

function snapshot(db: BossmodeDb) {
  return {
    usage: db.all("SELECT * FROM token_usage_daily ORDER BY room_id, member_id, date, model"),
    activity: db.all("SELECT * FROM activity_events ORDER BY room_id, member_id, seq"),
    watermarks: db.all("SELECT * FROM ingest_watermark ORDER BY kind, room_id, member_id"),
  };
}

function completeMarker(db: BossmodeDb) {
  return db.get("SELECT value FROM projection_state WHERE key = 'backfill-complete'");
}

beforeEach(async () => {
  previousDir = process.env.BOSSMODE_DIR;
  dir = mkdtempSync(join(tmpdir(), "bossmode-backfill-scopes-"));
  process.env.BOSSMODE_DIR = dir;
  vi.resetModules();
  vi.clearAllMocks();
  sqlite = await import("../../src/workspace/db/sqlite.js");
  projection = await import("../../src/workspace/db/projection.js");
  backfill = await import("../../src/workspace/db/backfill.js");
});

afterEach(() => {
  sqlite?.resetDbCache();
  if (previousDir === undefined) delete process.env.BOSSMODE_DIR;
  else process.env.BOSSMODE_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("backfill room, DM and nested topic scopes", () => {
  it("preserves scoped activity, model buckets and per-directory name/id dedup across repeated rebuilds", async () => {
    writeRoom(roomId);
    writeRoom(dmId);
    const events = [
      { type: "agent_start", ts: base },
      messageEnd(1, "test/model-a"),
      { type: "message_update", ts: base + 1, text: "not indexed" },
      messageEnd(2, "test/model-a"),
      messageEnd(3, "test/model-b"),
      messageEnd(4),
      messageEnd(5, "  "),
    ];
    for (const scope of [roomId, dmId, topicScope]) {
      writeEvents(scope, memberName, events.slice(0, 2));
      writeEvents(scope, memberId, events);
    }
    // No topic metadata/index is needed to recover event files. A second topic
    // has only a name-keyed file even though the parent has an id-keyed file.
    const legacyTopic = "topic:legacy-topic";
    writeEvents(legacyTopic, memberName, [messageEnd(7, "test/model-a")]);
    mkdirSync(join(dir, "rooms", roomId, "topics", "empty-topic"));
    writeFileSync(join(dir, "rooms", roomId, "topics", "not-a-topic.json"), "{}");

    const first = await projection.rebuildProjection();
    const db = sqlite.openDb();
    expect(first).toMatchObject({ rooms: 2, members: 4, events: 19, usageRows: 16, skippedNameKeyedFiles: 3 });
    expect(completeMarker(db)).toBeDefined();
    expect(db.all<{ room_id: string }>("SELECT DISTINCT room_id FROM token_usage_daily ORDER BY room_id").map(row => row.room_id))
      .toEqual([roomId, dmId, topicScope, legacyTopic].sort());

    for (const scope of [roomId, dmId, topicScope]) {
      expect(db.all(
        "SELECT member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns FROM token_usage_daily WHERE room_id = ? ORDER BY model",
        scope,
      )).toEqual([
        { member_id: memberId, date: "2026-08-01", model: "test/model-a", input_tokens: 3, output_tokens: 6, cache_read: 9, cache_write: 12, cost: 0.75, turns: 2 },
        { member_id: memberId, date: "2026-08-01", model: "test/model-b", input_tokens: 3, output_tokens: 6, cache_read: 9, cache_write: 12, cost: 0.75, turns: 1 },
        { member_id: memberId, date: "2026-08-01", model: "unknown", input_tokens: 9, output_tokens: 18, cache_read: 27, cache_write: 36, cost: 2.25, turns: 2 },
      ]);
      const activity = db.all<{ member_id: string; seq: number; type: string; byte_offset: number }>(
        "SELECT member_id, seq, type, byte_offset FROM activity_events WHERE room_id = ? ORDER BY seq", scope,
      );
      expect(activity.map(row => [row.member_id, row.seq, row.type])).toEqual([
        [memberId, 1, "agent_start"],
        ...[2, 4, 5, 6, 7].map(seq => [memberId, seq, "message_end"]),
      ]);
      const content = readFileSync(join(eventsDir(scope), `${memberId}.jsonl`));
      for (const row of activity) {
        const line = content.subarray(row.byte_offset).toString("utf8").split("\n")[0];
        expect(JSON.parse(line)).toEqual(events[row.seq - 1]);
      }
      expect(db.get("SELECT last_seq, last_ts FROM ingest_watermark WHERE kind = 'events' AND room_id = ? AND member_id = ?", scope, memberId))
        .toEqual({ last_seq: 7, last_ts: base + 5 });
    }
    expect(db.get("SELECT member_id, input_tokens FROM token_usage_daily WHERE room_id = ?", legacyTopic))
      .toEqual({ member_id: memberId, input_tokens: 7 });
    const before = snapshot(db);
    expect(await projection.rebuildProjection()).toEqual(first);
    expect(snapshot(db)).toEqual(before);
    // Closing/reopening SQLite must not affect file-derived reconstruction.
    sqlite.resetDbCache();
    await projection.rebuildProjection();
    expect(snapshot(sqlite.openDb())).toEqual(before);
  });

  it.each([roomId, dmId, topicScope])("retains name-only and unclaimed files in %s", async (scope) => {
    writeRoom(roomId);
    writeRoom(dmId);
    writeEvents(scope, memberName, [messageEnd(2)]);
    writeEvents(scope, "rm_removed", [messageEnd(3)]);
    const progress = await backfill.backfillAll(sqlite.openDb());
    expect(progress.skippedNameKeyedFiles).toBe(0);
    expect(sqlite.openDb().all("SELECT member_id, input_tokens FROM token_usage_daily WHERE room_id = ? ORDER BY member_id", scope))
      .toEqual([{ member_id: memberId, input_tokens: 2 }, { member_id: "rm_removed", input_tokens: 3 }]);
  });

  it.each([roomId, dmId, topicScope])("rejects a failed event source read in %s without marking the rebuild complete", async (scope) => {
    writeRoom(roomId);
    writeRoom(dmId);
    writeEvents(roomId, memberId, [messageEnd(1)]);
    const file = writeEvents(scope, memberId, [messageEnd(2)]);
    await projection.rebuildProjection();
    const db = sqlite.openDb();
    expect(completeMarker(db)).toBeDefined();
    const before = snapshot(db);
    // A directory named *.jsonl deterministically fails readFile on Linux,
    // including when tests run as root (unlike chmod-based failure tests).
    rmSync(file);
    mkdirSync(file);
    await expect(projection.rebuildProjection()).rejects.toThrow();
    expect(completeMarker(db)).toBeUndefined();
    const { logger } = await import("../../src/foundation/logger.js");
    expect(logger.error).toHaveBeenCalledWith("db", "backfill failed for room", expect.objectContaining({ roomId: scope === topicScope ? roomId : scope }));
    rmSync(file, { recursive: true });
    writeEvents(scope, memberId, [messageEnd(2)]);
    await projection.rebuildProjection();
    expect(completeMarker(db)).toBeDefined();
    expect(snapshot(db).usage).toEqual(before.usage);
    expect(snapshot(db).activity).toEqual(before.activity);
  });

  it.each(["rooms", "events", "topics", "topic-events", "tasks"])("propagates unreadable %s source errors", async (source) => {
    writeRoom(roomId);
    const paths: Record<string, string> = {
      rooms: join(dir, "rooms"),
      events: eventsDir(roomId),
      topics: join(dir, "rooms", roomId, "topics"),
      "topic-events": eventsDir(topicScope),
      tasks: join(dir, "rooms", roomId, "tasks.json"),
    };
    const path = paths[source];
    if (source === "rooms") rmSync(path, { recursive: true });
    if (source === "topic-events") mkdirSync(join(path, ".."), { recursive: true });
    if (source === "tasks") mkdirSync(path);
    else writeFileSync(path, "not a directory");
    await expect(projection.rebuildProjection()).rejects.toThrow();
    expect(completeMarker(sqlite.openDb())).toBeUndefined();
    const { logger } = await import("../../src/foundation/logger.js");
    expect(logger.error).toHaveBeenCalled();
  });

  it("does not certify a failed startup backfill", async () => {
    writeRoom(roomId);
    const file = writeEvents(topicScope, memberId, [messageEnd(1)]);
    rmSync(file);
    mkdirSync(file);
    const db = projection.initProjection();
    expect(db).not.toBeNull();
    await vi.waitFor(() => expect(projection.getBackfillStatus().status).toBe("error"));
    expect(completeMarker(db!)).toBeUndefined();
  });
});
