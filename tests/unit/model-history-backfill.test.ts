import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => {
    mkdirSync(dir, { recursive: true });
  },
}));

function writeRoom(roomId: string, members: Array<{ id: string; name: string; sourceAgent: string }>): void {
  const roomDir = join(dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  writeFileSync(
    join(roomDir, "room.json"),
    JSON.stringify({
      id: roomId, name: roomId, cwd: "/tmp",
      members: members.map((m) => m.name),
      roomMembers: members.map((m) => ({ id: m.id, roomId, name: m.name, sourceAgent: m.sourceAgent, createdAt: 1, updatedAt: 1 })),
      createdAt: 1,
    }),
  );
}

function writeEvents(roomId: string, stem: string, events: object[]): void {
  const d = join(dir, "rooms", roomId, "agent-events");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${stem}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function writeSession(roomId: string, memberId: string, name: string, modelChanges: Array<{ ts: string; provider: string; modelId: string }>): void {
  const d = join(dir, "pi-agent", "runtime", roomId, memberId, "sessions");
  mkdirSync(d, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 1, id: name, timestamp: modelChanges[0]?.ts, cwd: "/tmp" }),
    ...modelChanges.map((m) => JSON.stringify({ type: "model_change", id: "x", timestamp: m.ts, provider: m.provider, modelId: m.modelId })),
  ];
  writeFileSync(join(d, `${name}.jsonl`), lines.join("\n") + "\n", "utf-8");
}

function msgEnd(ts: number, input: number, opts: { model?: string; output?: number } = {}): object {
  const e: Record<string, unknown> = { type: "message_end", ts, usage: { inputTokens: input, outputTokens: opts.output ?? 0, cost: 0 } };
  if (opts.model) e.model = opts.model;
  return e;
}

const D1 = Date.parse("2026-07-20T10:00:00Z");
const D2 = Date.parse("2026-07-21T10:00:00Z");

describe("model-history-backfill (task ④)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-s5-"));
    vi.resetModules();
  });
  afterEach(async () => {
    const { resetDbCache } = await import("../../src/workspace/db/sqlite.js");
    resetDbCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolveModelAt picks the last change <= ts; null before earliest", async () => {
    const { resolveModelAt } = await import("../../src/workspace/db/model-history-backfill.js");
    const tl = [
      { ts: 100, model: "a/1" },
      { ts: 200, model: "b/2" },
      { ts: 300, model: "c/3" },
    ];
    expect(resolveModelAt(tl, 50)).toBeNull();
    expect(resolveModelAt(tl, 100)).toBe("a/1");
    expect(resolveModelAt(tl, 150)).toBe("a/1");
    expect(resolveModelAt(tl, 250)).toBe("b/2");
    expect(resolveModelAt(tl, 999)).toBe("c/3");
    expect(resolveModelAt([], 100)).toBeNull();
  });

  it("builds a merged, sorted timeline from multiple session files", async () => {
    const roomId = "room-a";
    const memberId = "rm_a";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    writeSession(roomId, memberId, "s2", [{ ts: "2026-07-21T10:00:00Z", provider: "kimi-coding", modelId: "k3" }]);
    writeSession(roomId, memberId, "s1", [{ ts: "2026-07-20T10:00:00Z", provider: "xai-cloud", modelId: "grok-4.5" }]);
    const { buildMemberModelTimeline } = await import("../../src/workspace/db/model-history-backfill.js");
    const tl = buildMemberModelTimeline(roomId, memberId);
    expect(tl.map((t) => t.model)).toEqual(["xai-cloud/grok-4.5", "kimi-coding/k3"]);
    expect(tl[0].ts).toBeLessThan(tl[1].ts);
  });

  it("attributes historical unknown usage to real models and reports coverage", async () => {
    const roomId = "room-a";
    const memberId = "rm_a";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    // Timeline: grok from D1, k3 from D2.
    writeSession(roomId, memberId, "s1", [
      { ts: "2026-07-20T09:00:00Z", provider: "xai-cloud", modelId: "grok-4.5" },
      { ts: "2026-07-21T09:00:00Z", provider: "kimi-coding", modelId: "k3" },
    ]);
    // Historical events (no model): D1 → grok, D2 → k3.
    writeEvents(roomId, memberId, [
      msgEnd(D1, 1000),
      msgEnd(D1 + 60000, 500),
      msgEnd(D2, 2000),
    ]);

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    const progress = await rebuildProjection();
    const db = getProjectionDb()!;

    const rows = db.all<{ date: string; model: string; input_tokens: number }>(
      "SELECT date, model, input_tokens FROM token_usage_daily WHERE room_id=? AND member_id=? ORDER BY date, model",
      roomId, memberId,
    );
    // No unknown rows remain; usage split by resolved model.
    expect(rows.find((r) => r.model === "unknown")).toBeUndefined();
    const grok = rows.find((r) => r.model === "xai-cloud/grok-4.5")!;
    const k3 = rows.find((r) => r.model === "kimi-coding/k3")!;
    expect(grok.input_tokens).toBe(1500); // 1000 + 500 on D1
    expect(k3.input_tokens).toBe(2000);   // D2

    const mh = progress.modelHistory!;
    expect(mh.attributedTokens).toBe(3500);
    expect(mh.unknownRemainingTokens).toBe(0);
    expect(mh.membersWithTimeline).toBe(1);
  });

  it("leaves events before the earliest change in the unknown bucket (honest)", async () => {
    const roomId = "room-b";
    const memberId = "rm_b";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    // Timeline starts at D2; the D1 event predates it → unknown.
    writeSession(roomId, memberId, "s1", [{ ts: "2026-07-21T00:00:00Z", provider: "xai-cloud", modelId: "grok-4.5" }]);
    writeEvents(roomId, memberId, [msgEnd(D1, 1000), msgEnd(D2, 2000)]);

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    const progress = await rebuildProjection();
    const db = getProjectionDb()!;
    const rows = db.all<{ model: string; input_tokens: number }>(
      "SELECT model, input_tokens FROM token_usage_daily WHERE room_id=? AND member_id=? ORDER BY model", roomId, memberId,
    );
    expect(rows.find((r) => r.model === "unknown")!.input_tokens).toBe(1000);
    expect(rows.find((r) => r.model === "xai-cloud/grok-4.5")!.input_tokens).toBe(2000);
    expect(progress.modelHistory!.unknownRemainingTokens).toBe(1000);
    expect(progress.modelHistory!.attributedTokens).toBe(2000);
  });

  it("is idempotent — a second attribution run does not change counts", async () => {
    const roomId = "room-c";
    const memberId = "rm_c";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    writeSession(roomId, memberId, "s1", [{ ts: "2026-07-20T00:00:00Z", provider: "xai-cloud", modelId: "grok-4.5" }]);
    writeEvents(roomId, memberId, [msgEnd(D1, 1000), msgEnd(D2, 2000)]);

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const db = getProjectionDb()!;
    const sum1 = db.get<{ t: number }>("SELECT SUM(input_tokens) AS t FROM token_usage_daily WHERE room_id=? AND member_id=?", roomId, memberId)!.t;

    const { backfillModelHistory } = await import("../../src/workspace/db/model-history-backfill.js");
    backfillModelHistory(db); // run again standalone
    const sum2 = db.get<{ t: number }>("SELECT SUM(input_tokens) AS t FROM token_usage_daily WHERE room_id=? AND member_id=?", roomId, memberId)!.t;
    expect(sum2).toBe(sum1);
    // still no unknown
    expect(db.get("SELECT 1 FROM token_usage_daily WHERE model='unknown' AND room_id=?", roomId)).toBeUndefined();
  });

  it("never touches already-stamped live-model rows", async () => {
    const roomId = "room-d";
    const memberId = "rm_d";
    writeRoom(roomId, [{ id: memberId, name: "dev", sourceAgent: "developer" }]);
    writeSession(roomId, memberId, "s1", [{ ts: "2026-07-20T00:00:00Z", provider: "xai-cloud", modelId: "grok-4.5" }]);
    // One stamped (live) event + one historical (unstamped) on the same day.
    writeEvents(roomId, memberId, [
      msgEnd(D1, 100, { model: "claude-cloud/opus" }), // live-stamped → must stay as opus row
      msgEnd(D1 + 1000, 900), // historical → grok
    ]);

    const { rebuildProjection, getProjectionDb } = await import("../../src/workspace/db/projection.js");
    await rebuildProjection();
    const db = getProjectionDb()!;
    const rows = db.all<{ model: string; input_tokens: number }>(
      "SELECT model, input_tokens FROM token_usage_daily WHERE room_id=? AND member_id=? ORDER BY model", roomId, memberId,
    );
    // opus row = the live-stamped 100 (S1 backfill stamped it since event carried model); grok = historical 900.
    expect(rows.find((r) => r.model === "claude-cloud/opus")!.input_tokens).toBe(100);
    expect(rows.find((r) => r.model === "xai-cloud/grok-4.5")!.input_tokens).toBe(900);
    expect(rows.find((r) => r.model === "unknown")).toBeUndefined();
  });
});
