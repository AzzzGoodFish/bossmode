import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { ACTIVITY_TYPES, appendAgentEvent, importAgentEvent, pageActivity, readAgentEvents } from "../../src/storage/event-repository.js";

let fixture: ReturnType<typeof coreFixture>;
const owner = { ownerKey: "mem_one", memberId: "mem_one" };
const events = [
  { type: "agent_start", ts: 1 },
  { type: "message_start", ts: 2 },
  { type: "message_update", ts: 3, text: "churn" },
  { type: "tool_start", ts: 4, toolName: "read", args: { path: "数据.txt", nested: [1, { raw: true }] } },
  { type: "tool_end", ts: 5, result: "full result", custom: { retained: true } },
  { type: "message_end", ts: 6, text: "full".repeat(100000), thinking: "reason" },
  { type: "agent_end", ts: 7 },
];
beforeEach(() => {
  fixture = coreFixture();
  fixture.db.run("INSERT INTO scopes VALUES('room','room','room',NULL),('dm:mem_one','dm',NULL,'mem_one'),('topic:one','topic','room',NULL)");
});
afterEach(() => { fixture.close(); });
function seed(scope = "room") {
  events.forEach((event, i) => importAgentEvent(fixture.db, { id: `${scope}:${i}`, scopeId: scope, ...owner, seq: i + 1, ts: event.ts, event }));
}
describe("authoritative activity pages", () => {
  it.each(["room", "dm:mem_one", "topic:one"])("retains full payloads and counts, excluding only activity churn in %s", scope => {
    seed(scope);
    expect(readAgentEvents(scope, owner.ownerKey)).toEqual(events);
    const visible = events.filter(e => ACTIVITY_TYPES.has(e.type));
    expect(pageActivity(scope, owner.ownerKey)).toEqual({ events: visible, hasMore: false, nextBeforeSeq: null, indexed: true });
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_events WHERE scope_id=?", scope)!.n).toBe(7);
    expect(fixture.db.get<{ n: number }>(`SELECT COUNT(*) n FROM agent_events WHERE scope_id=? AND type IN (${[...ACTIVITY_TYPES].map(() => "?").join(",")})`, scope, ...ACTIVITY_TYPES)!.n).toBe(5);
    expect(pageActivity(scope, "mem_other").events).toEqual([]);
  });
  it("pages newest batches in chronological order with exclusive keysets and terminal pagination", () => {
    seed();
    expect(pageActivity("room", owner.ownerKey, { limit: 2 })).toEqual({ events: events.slice(5), hasMore: true, nextBeforeSeq: 6, indexed: true });
    expect(pageActivity("room", owner.ownerKey, { limit: 2, beforeSeq: 6 })).toEqual({ events: events.slice(3, 5), hasMore: true, nextBeforeSeq: 4, indexed: true });
    expect(pageActivity("room", owner.ownerKey, { limit: 2, beforeSeq: 4 })).toEqual({ events: [events[0]], hasMore: false, nextBeforeSeq: null, indexed: true });
    expect(pageActivity("room", owner.ownerKey, { beforeSeq: 1 }).events).toEqual([]);
  });
  it("filters requested indexed types before counting a page", () => {
    seed();
    expect(pageActivity("room", owner.ownerKey, { types: ["tool_start", "tool_end", "message_update"], limit: 1 })).toEqual({ events: [events[4]], hasMore: true, nextBeforeSeq: 5, indexed: true });
    expect(pageActivity("room", owner.ownerKey, { types: ["tool_start", "tool_end"], beforeSeq: 5 }).events).toEqual([events[3]]);
    expect(pageActivity("room", owner.ownerKey, { types: ["unknown"] }).events).toEqual(events.filter(e => ACTIVITY_TYPES.has(e.type)));
  });
  it("reflects committed live facts immediately and after reopen without catch-up or source files", () => {
    appendAgentEvent("room", owner, events[0], "live-start");
    expect(pageActivity("room", owner.ownerKey).events).toEqual([events[0]]);
    fixture.reopen();
    appendAgentEvent("room", owner, events[6], "live-end");
    expect(pageActivity("room", owner.ownerKey).events).toEqual([events[0], events[6]]);
  });
  it("does not write or heal while serving activity", () => {
    seed();
    fixture.db.exec("PRAGMA query_only=ON");
    expect(pageActivity("room", owner.ownerKey).events).toHaveLength(5);
    fixture.db.exec("PRAGMA query_only=OFF");
  });
});
