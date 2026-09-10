import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { appendAgentEvent, importAgentEvent, rebuildEventAggregates, type EventPayload } from "../../src/storage/event-repository.js";
import { computeStatsFromEvents, readMemberStats } from "../../src/workspace/member-stats-store.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  fixture.db.run("INSERT INTO scopes VALUES('room1','room','room1',NULL)");
});
afterEach(() => { fixture.close(); });
const zero = { turns: 0, toolCalls: 0, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
function record(events: EventPayload[], ownerKey = "qa") {
  events.forEach((event, i) => importAgentEvent(fixture.db, { id: `${ownerKey}-${i}`, scopeId: "room1", ownerKey, memberId: null, seq: i + 1, ts: event.ts ?? 10000, event }));
}
describe("member statistics from authoritative events", () => {
  it("returns real zeros for no recorded activity", () => { expect(readMemberStats("room1", "qa")).toEqual(zero); });
  it("records a full turn including all token and cost dimensions", () => {
    record([{ type: "agent_start", ts: 1000 }, { type: "tool_start", ts: 1200 }, { type: "tool_start", ts: 1300 }, { type: "message_end", ts: 1400, usage: { inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheWrite: 5, cost: 0.02 } }, { type: "agent_end", ts: 6000 }]);
    expect(readMemberStats("room1", "qa")).toEqual({ turns: 1, toolCalls: 2, activeMs: 5000, tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, cost: 0.02, updatedAt: 6000 });
  });
  it("accumulates multiple turns including a zero timestamp start", () => {
    record([{ type: "agent_start", ts: 0 }, { type: "agent_end", ts: 1000 }, { type: "agent_start", ts: 2000 }, { type: "agent_end", ts: 5000 }]);
    expect(readMemberStats("room1", "qa")).toMatchObject({ turns: 2, activeMs: 4000 });
  });
  it.each([
    [{ type: "agent_end", ts: 1000 }],
    [{ type: "agent_start" }, { type: "agent_end", ts: 1000 }],
    [{ type: "agent_start", ts: 2000 }, { type: "agent_end", ts: 1000 }],
  ])("never invents elapsed time from an unmatched or invalid interval: %j", (...events) => {
    record(events);
    expect(readMemberStats("room1", "qa")).toMatchObject({ turns: 1, activeMs: 0 });
  });
  it("pure computation matches incremental SQL and rebuild including independent owners", () => {
    const events = [{ type: "agent_start", ts: 1000 }, { type: "tool_start", ts: 1500 }, { type: "message_end", ts: 2000, usage: { inputTokens: 200, outputTokens: 80, cacheRead: 20, cacheWrite: 0, cost: 0.05 } }, { type: "agent_end", ts: 3000 }];
    record(events); record([{ type: "agent_start", ts: 0 }, { type: "agent_end", ts: 500 }], "pm");
    expect(readMemberStats("room1", "qa")).toEqual({ ...computeStatsFromEvents(events), updatedAt: 3000 });
    const before = readMemberStats("room1", "qa");
    rebuildEventAggregates(); fixture.reopen(); rebuildEventAggregates();
    expect(readMemberStats("room1", "qa")).toEqual(before);
    expect(readMemberStats("room1", "pm")).toMatchObject({ turns: 1, activeMs: 500, toolCalls: 0 });
  });
  it("replays an imported source without double-counting and retains subsequent live facts", () => {
    const old = [{ type: "agent_start", ts: 0 }, { type: "agent_end", ts: 500 }];
    record(old); record(old);
    appendAgentEvent("room1", { ownerKey: "qa", memberId: null }, { type: "agent_end", ts: 800 }, "new");
    rebuildEventAggregates();
    expect(readMemberStats("room1", "qa")).toMatchObject({ turns: 2, activeMs: 500 });
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_events")!.n).toBe(3);
  });
  it("rebuild on empty authority is idempotent without creating phantom statistics", () => {
    rebuildEventAggregates(); rebuildEventAggregates();
    expect(fixture.db.all("SELECT * FROM member_statistics")).toEqual([]);
  });
});
