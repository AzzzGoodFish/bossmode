import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoomsDir: () => join(dir, "rooms"),
}));

describe("member-stats-store", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-memberstats-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns real zeros for a member with no recorded activity", async () => {
    const store = await import("../../src/workspace/member-stats-store.js");
    expect(store.readMemberStats("room1", "qa")).toEqual({ turns: 0, toolCalls: 0, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
  });

  it("records a full turn: start, tool call, token usage, end", async () => {
    const store = await import("../../src/workspace/member-stats-store.js");
    store.recordTurnStart("room1:qa", 1000);
    store.recordToolCall("room1", "qa");
    store.recordToolCall("room1", "qa");
    store.recordTokenUsage("room1", "qa", { inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheWrite: 5, cost: 0.02 });
    store.recordTurnEnd("room1", "qa", "room1:qa", 6000);

    const stats = store.readMemberStats("room1", "qa");
    expect(stats.turns).toBe(1);
    expect(stats.toolCalls).toBe(2);
    expect(stats.activeMs).toBe(5000);
    expect(stats.tokens).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
    expect(stats.cost).toBeCloseTo(0.02);
  });

  it("accumulates across multiple turns", async () => {
    const store = await import("../../src/workspace/member-stats-store.js");
    store.recordTurnStart("room1:qa", 0);
    store.recordTurnEnd("room1", "qa", "room1:qa", 1000);
    store.recordTurnStart("room1:qa", 2000);
    store.recordTurnEnd("room1", "qa", "room1:qa", 5000);
    const stats = store.readMemberStats("room1", "qa");
    expect(stats.turns).toBe(2);
    expect(stats.activeMs).toBe(1000 + 3000);
  });

  it("an agent_end with no matched agent_start still counts a turn but adds no active time", async () => {
    const store = await import("../../src/workspace/member-stats-store.js");
    store.recordTurnEnd("room1", "qa", "room1:qa", 1000);
    const stats = store.readMemberStats("room1", "qa");
    expect(stats.turns).toBe(1);
    expect(stats.activeMs).toBe(0);
  });

  it("computeStatsFromEvents matches the incremental accumulator for the same event sequence", async () => {
    const store = await import("../../src/workspace/member-stats-store.js");
    const events = [
      { type: "agent_start", ts: 1000 },
      { type: "tool_start", ts: 1500 },
      { type: "message_end", ts: 2000, usage: { inputTokens: 200, outputTokens: 80, cacheRead: 20, cacheWrite: 0, cost: 0.05 } },
      { type: "agent_end", ts: 3000 },
    ];
    const computed = store.computeStatsFromEvents(events);
    expect(computed.turns).toBe(1);
    expect(computed.toolCalls).toBe(1);
    expect(computed.activeMs).toBe(2000);
    expect(computed.tokens).toEqual({ input: 200, output: 80, cacheRead: 20, cacheWrite: 0 });
    expect(computed.cost).toBeCloseTo(0.05);
  });
});

describe("member-stats-backfill-v1 migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-statsbackfill-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedEvents(roomId: string, memberRef: string, events: unknown[]) {
    const evDir = join(dir, "rooms", roomId, "agent-events");
    mkdirSync(evDir, { recursive: true });
    writeFileSync(join(evDir, `${memberRef}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  it("backfills a member's stats from its existing event log", async () => {
    const migration = await import("../../src/workspace/member-stats-backfill-migration.js");
    const store = await import("../../src/workspace/member-stats-store.js");
    seedEvents("room1", "qa", [
      { type: "agent_start", ts: 1000 },
      { type: "tool_start", ts: 1200 },
      { type: "message_end", ts: 1800, usage: { inputTokens: 300, outputTokens: 100 } },
      { type: "agent_end", ts: 2000 },
    ]);

    migration.runMemberStatsBackfillMigration();

    const stats = store.readMemberStats("room1", "qa");
    expect(stats.turns).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.activeMs).toBe(1000);
    expect(stats.tokens.input).toBe(300);
    expect(stats.tokens.output).toBe(100);
  });

  it("does not re-backfill a member that already has a stats file (avoids double-counting live-accumulated data)", async () => {
    const migration = await import("../../src/workspace/member-stats-backfill-migration.js");
    const store = await import("../../src/workspace/member-stats-store.js");
    seedEvents("room1", "qa", [{ type: "agent_start", ts: 0 }, { type: "agent_end", ts: 1000 }]);
    // Simulate the server already having live-accumulated some stats before the migration runs.
    store.writeBackfilledStats("room1", "qa", { turns: 5, toolCalls: 9, activeMs: 12345, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, cost: 1.5 });

    migration.runMemberStatsBackfillMigration();

    const stats = store.readMemberStats("room1", "qa");
    expect(stats.turns).toBe(5); // untouched, not overwritten by the (smaller) event-derived count
  });

  it("is idempotent and skips rooms/members with no event data", async () => {
    const migration = await import("../../src/workspace/member-stats-backfill-migration.js");
    mkdirSync(join(dir, "rooms", "empty-room"), { recursive: true });
    expect(() => migration.runMemberStatsBackfillMigration()).not.toThrow();
    expect(existsSync(join(dir, "rooms", "empty-room", "agent-events"))).toBe(false);
  });

  it("backfills multiple members in the same room independently", async () => {
    const migration = await import("../../src/workspace/member-stats-backfill-migration.js");
    const store = await import("../../src/workspace/member-stats-store.js");
    seedEvents("room1", "pm", [{ type: "agent_start", ts: 0 }, { type: "agent_end", ts: 500 }]);
    seedEvents("room1", "qa", [{ type: "agent_start", ts: 0 }, { type: "tool_start", ts: 100 }, { type: "agent_end", ts: 1000 }]);

    migration.runMemberStatsBackfillMigration();

    expect(store.readMemberStats("room1", "pm")).toMatchObject({ turns: 1, toolCalls: 0, activeMs: 500 });
    expect(store.readMemberStats("room1", "qa")).toMatchObject({ turns: 1, toolCalls: 1, activeMs: 1000 });
  });
});
