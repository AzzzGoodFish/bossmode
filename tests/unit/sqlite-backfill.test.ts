import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The projection DB path derives from getBossmodeDir(); point it at a temp dir.
let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => {
    mkdirSync(dir, { recursive: true });
  },
}));

function writeEvents(roomId: string, fileStem: string, events: object[]): void {
  const eventsDir = join(dir, "rooms", roomId, "agent-events");
  mkdirSync(eventsDir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(eventsDir, `${fileStem}.jsonl`), body, "utf-8");
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
      id: m.id,
      roomId,
      name: m.name,
      sourceAgent: m.sourceAgent,
      createdAt: 1,
      updatedAt: 1,
    })),
    createdAt: 1,
  };
  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room), "utf-8");
}

function messageEnd(ts: number, usage: Partial<Record<string, number>>): object {
  return {
    type: "message_end",
    text: "",
    usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ...usage },
    ts,
  };
}

function messageEndModel(ts: number, model: string, usage: Partial<Record<string, number>>): object {
  return { ...messageEnd(ts, usage), model };
}

describe("sqlite backfill", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-db-"));
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetDbCache } = await import("../../src/workspace/db/sqlite.js");
    resetDbCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedups id-keyed vs name-keyed files: id-keyed wins, name-keyed skipped", async () => {
    const roomId = "room-a";
    const memberId = "rm_abc123";
    writeRoom(roomId, [{ id: memberId, name: "architect", sourceAgent: "architect" }]);

    // Legacy name-keyed file: subset (2 turns). id-keyed: superset (3 turns).
    // The base ts is a real epoch-ms so utcDate() yields a valid YYYY-MM-DD.
    const base = Date.parse("2026-07-24T00:00:00Z");
    writeEvents(roomId, "architect", [
      messageEnd(base, { inputTokens: 100 }),
      messageEnd(base + 1000, { inputTokens: 100 }),
    ]);
    writeEvents(roomId, memberId, [
      messageEnd(base, { inputTokens: 100 }),
      messageEnd(base + 1000, { inputTokens: 100 }),
      messageEnd(base + 2000, { inputTokens: 100 }),
    ]);

    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    const { backfillAll } = await import("../../src/workspace/db/backfill.js");
    const db = openDb();
    const progress = await backfillAll(db);

    expect(progress.skippedNameKeyedFiles).toBe(1);

    // Only the id-keyed superset should be counted: 3 turns × 100 = 300, not
    // 500 (would be double-count if both files were ingested).
    const row = db.get<{ input_tokens: number; turns: number }>(
      "SELECT SUM(input_tokens) AS input_tokens, SUM(turns) AS turns FROM token_usage_daily WHERE room_id = ? AND member_id = ?",
      roomId,
      memberId,
    );
    expect(row?.input_tokens).toBe(300);
    expect(row?.turns).toBe(3);

    // No rows should be keyed by the legacy name.
    const legacy = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM token_usage_daily WHERE member_id = 'architect'",
    );
    expect(legacy?.n).toBe(0);
  });

  it("uses name-keyed file for legacy member with no id-keyed file", async () => {
    const roomId = "room-b";
    const memberId = "rm_legacy1";
    writeRoom(roomId, [{ id: memberId, name: "pm", sourceAgent: "pm" }]);
    const base = Date.parse("2026-07-24T00:00:00Z");
    writeEvents(roomId, "pm", [messageEnd(base, { inputTokens: 42 })]);

    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    const { backfillAll } = await import("../../src/workspace/db/backfill.js");
    const db = openDb();
    await backfillAll(db);

    // Falls back to name-keyed content but keys the row by the member id.
    const row = db.get<{ input_tokens: number }>(
      "SELECT input_tokens FROM token_usage_daily WHERE room_id = ? AND member_id = ?",
      roomId,
      memberId,
    );
    expect(row?.input_tokens).toBe(42);
  });

  it("is idempotent: re-running backfill does not double-count", async () => {
    const roomId = "room-c";
    const memberId = "rm_idem";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    const base = Date.parse("2026-07-24T00:00:00Z");
    writeEvents(roomId, memberId, [
      messageEnd(base, { inputTokens: 10, cost: 0.5 }),
      messageEnd(base + 1000, { outputTokens: 20 }),
    ]);

    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    const { backfillAll } = await import("../../src/workspace/db/backfill.js");
    const db = openDb();
    await backfillAll(db);
    await backfillAll(db); // second run must be a no-op for totals

    const row = db.get<{ input_tokens: number; output_tokens: number; cost: number; turns: number }>(
      "SELECT input_tokens, output_tokens, cost, turns FROM token_usage_daily WHERE room_id = ? AND member_id = ?",
      roomId,
      memberId,
    );
    expect(row?.input_tokens).toBe(10);
    expect(row?.output_tokens).toBe(20);
    expect(row?.cost).toBeCloseTo(0.5);
    expect(row?.turns).toBe(2);

    // Activity rows are keyed by seq (PRIMARY KEY) so re-run is INSERT OR REPLACE.
    const act = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM activity_events WHERE room_id = ? AND member_id = ?",
      roomId,
      memberId,
    );
    expect(act?.n).toBe(2);
  });

  it("advances the events watermark to last seq + file mtime", async () => {
    const roomId = "room-d";
    const memberId = "rm_wm";
    writeRoom(roomId, [{ id: memberId, name: "qa", sourceAgent: "qa" }]);
    const base = Date.parse("2026-07-24T00:00:00Z");
    writeEvents(roomId, memberId, [
      { type: "agent_start", ts: base },
      messageEnd(base + 500, { inputTokens: 5 }),
      { type: "agent_end", ts: base + 1000 },
    ]);

    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    const { backfillAll } = await import("../../src/workspace/db/backfill.js");
    const { getWatermark } = await import("../../src/workspace/db/watermark.js");
    const db = openDb();
    await backfillAll(db);

    const wm = getWatermark(db, "events", roomId, memberId);
    expect(wm).toBeTruthy();
    expect(wm?.lastSeq).toBe(3);
    expect(wm?.lastTs).toBe(base + 1000);
    expect(wm?.lastMtimeMs).toBeGreaterThan(0);
  });

  it("indexes activity events with byte offsets and skips streaming churn", async () => {
    const roomId = "room-e";
    const memberId = "rm_act";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    const base = Date.parse("2026-07-24T00:00:00Z");
    writeEvents(roomId, memberId, [
      { type: "agent_start", ts: base },
      { type: "message_update", ts: base + 100 }, // high-churn: must be skipped
      { type: "tool_start", ts: base + 200 },
      messageEnd(base + 300, { inputTokens: 1 }),
    ]);

    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    const { backfillAll } = await import("../../src/workspace/db/backfill.js");
    const db = openDb();
    await backfillAll(db);

    const types = db
      .all<{ type: string }>("SELECT type FROM activity_events WHERE room_id = ? ORDER BY seq", roomId)
      .map((r) => r.type);
    expect(types).toEqual(["agent_start", "tool_start", "message_end"]);

    // Offsets are non-negative and strictly increasing by seq.
    const rows = db.all<{ seq: number; byte_offset: number }>(
      "SELECT seq, byte_offset FROM activity_events WHERE room_id = ? ORDER BY seq",
      roomId,
    );
    expect(rows[0].byte_offset).toBe(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].byte_offset).toBeGreaterThan(rows[i - 1].byte_offset);
    }
  });

  it("projects tasks.json into the tasks table", async () => {
    const roomId = "room-f";
    writeRoom(roomId, [{ id: "rm_x", name: "pm", sourceAgent: "pm" }]);
    const roomDir = join(dir, "rooms", roomId);
    writeFileSync(
      join(roomDir, "tasks.json"),
      JSON.stringify([
        { id: "t1", title: "First", status: "todo", priority: "P1", assignee: "developer", createdAt: 1, updatedAt: 2 },
        { id: "t2", title: "Second", status: "done", createdAt: 3, updatedAt: 4 },
      ]),
      "utf-8",
    );

    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    const { backfillAll } = await import("../../src/workspace/db/backfill.js");
    const db = openDb();
    const progress = await backfillAll(db);
    expect(progress.tasks).toBe(2);

    const t1 = db.get<{ title: string; assignee: string; payload_json: string }>(
      "SELECT title, assignee, payload_json FROM tasks WHERE room_id = ? AND task_id = 't1'",
      roomId,
    );
    expect(t1?.title).toBe("First");
    expect(t1?.assignee).toBe("developer");
    expect(JSON.parse(t1!.payload_json).status).toBe("todo");
  });

  it("rebuild after deleting the DB reproduces the same totals", async () => {
    const roomId = "room-g";
    const memberId = "rm_reb";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    const base = Date.parse("2026-07-24T00:00:00Z");
    writeEvents(roomId, memberId, [messageEnd(base, { inputTokens: 7, cost: 0.1 })]);

    const { rebuildProjection } = await import("../../src/workspace/db/projection.js");
    const { openDb, getDbPath, resetDbCache } = await import("../../src/workspace/db/sqlite.js");
    const { existsSync, rmSync: rm } = await import("node:fs");

    await rebuildProjection();
    let db = openDb();
    const before = db.get<{ input_tokens: number }>(
      "SELECT input_tokens FROM token_usage_daily WHERE member_id = ?",
      memberId,
    );
    expect(before?.input_tokens).toBe(7);

    // Kill DB → rebuild → data returns.
    resetDbCache();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = getDbPath() + suffix;
      if (existsSync(p)) rm(p);
    }
    await rebuildProjection();
    db = openDb();
    const after = db.get<{ input_tokens: number }>(
      "SELECT input_tokens FROM token_usage_daily WHERE member_id = ?",
      memberId,
    );
    expect(after?.input_tokens).toBe(7);
  });

  it("honors the stamped model on events (does not wipe to unknown)", async () => {
    const roomId = "room-model";
    const memberId = "rm_stamped";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    const base = Date.parse("2026-07-24T00:00:00Z");
    // Two stamped turns (real model) + one legacy turn (no model → unknown).
    writeEvents(roomId, memberId, [
      messageEndModel(base, "anthropic/claude-opus-4-8", { inputTokens: 100 }),
      messageEndModel(base + 1000, "anthropic/claude-opus-4-8", { inputTokens: 50 }),
      messageEnd(base + 2000, { inputTokens: 30 }),
    ]);

    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    const { backfillAll } = await import("../../src/workspace/db/backfill.js");
    const db = openDb();
    await backfillAll(db);

    const stamped = db.get<{ input_tokens: number }>(
      "SELECT input_tokens FROM token_usage_daily WHERE room_id = ? AND member_id = ? AND model = ?",
      roomId,
      memberId,
      "anthropic/claude-opus-4-8",
    );
    expect(stamped?.input_tokens).toBe(150); // two stamped turns preserved, not wiped
    const unknown = db.get<{ input_tokens: number }>(
      "SELECT input_tokens FROM token_usage_daily WHERE room_id = ? AND member_id = ? AND model = 'unknown'",
      roomId,
      memberId,
    );
    expect(unknown?.input_tokens).toBe(30); // legacy turn stays unknown
  });
});
