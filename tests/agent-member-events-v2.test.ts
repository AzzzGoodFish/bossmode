import { afterEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockAgentHandle } from "./helpers/mock-runtime.js";
import { instances, instanceKey, type AgentInstance } from "../src/agent/instance.js";
import { wireInstanceEvents } from "../src/agent/scheduler.js";
import { appendMemberEvent, handleAgentEvent, importHistoricalEvent, loadEventsPaginated, loadEventsFromDisk, pageActivity, setAgentEventSink, readAgentEvent, readStats, readUsageRows, rebuildEventAggregates } from "../src/agent/events.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => {
  setAgentEventSink(undefined);
  instances.clear();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup() {
  const fixture = coreFixture();
  fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_events", "Events", "events", "general", "{}", 1, 1,
  );
  return fixture;
}

function liveInstance(handle: MockAgentHandle): AgentInstance {
  return {
    handle, activeSourceRef: null, memberId: "mem_events", agentName: "Events",
    status:"idle",dispatchState:"idle",promptInFlight:false,
    hadErrorInTurn: false, lastTurnError: null, pendingErrorNotice: null,
    lastMessageEndWasLength: false, lengthContinuationPending: false,
    lengthContinuationAttempted: false, compacting: false, turnActive: false,
    sessionSources:{compiled:{agentPrompt:"",appendSystemPrompt:[]}},
    unsubscribe: () => {}, eventBuffer: [], appliedModel: "fake:model",
    pendingReload: null,
  };
}

describe("member event facts v2", () => {
  it("pages historical order plus live facts without parsing off-page payloads", () => {
    const fixture = setup();
    const sourceRef = "room:rm_events";
    for (const seq of [3, 1, 2]) importHistoricalEvent(fixture.db, {
      id: `old-${seq}`, sourceKey: "old", ownerKey: "owner", sourceSeq: seq,
      memberId: "mem_events", sourceRef, event: { type: "system", text: `old-${seq}` }, ts: seq,
    });
    appendMemberEvent({ id: "new", memberId: "mem_events", sourceRef, event: { type: "system", text: "new", ts: 4 } });
    const all = loadEventsFromDisk(sourceRef, "mem_events");
    for (const before of [undefined, 3, 1, 0, -1, 100]) {
      const end = before === undefined ? all.length : Math.max(0, Math.min(before, all.length));
      expect(loadEventsPaginated(sourceRef, "mem_events", 2, before)).toEqual({
        events: all.slice(Math.max(0, end - 2), end), total: 4, hasMore: end > 2,
      });
    }
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(loadEventsPaginated(sourceRef, "mem_events", 1).events).toEqual([all[3]]);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally { parse.mockRestore(); }
  });

  it("preserves oversized event payloads and tool identity in history, activity and broadcasts", async () => {
    const fixture = setup();
    const sourceRef = "room:rm_events";
    const result = "界".repeat(400_000);
    appendMemberEvent({ id: "huge", memberId: "mem_events", sourceRef, event: {
      type: "tool_end", toolName: "read", toolCallId: "call", result, isError: false,
    } });
    const page = loadEventsPaginated(sourceRef, "mem_events", 80);
    expect(page.events[0]).toMatchObject({ type: "tool_end", toolName: "read", toolCallId: "call", result, isError: false });
    expect(page.events[0]).not.toHaveProperty("truncated");
    expect(pageActivity("mem_events").events).toEqual(page.events);
    const sent: unknown[] = [];
    setAgentEventSink((_source, _member, payload) => sent.push(payload.event));
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(sent).toEqual(page.events);
    expect(readAgentEvent("huge", fixture.db)?.event).toMatchObject({ result });
  });

  it("preserves large transient tool and message updates during WebSocket delivery", () => {
    setup();
    const sent: unknown[] = [];
    setAgentEventSink((_source, _member, payload) => sent.push(payload.event));
    const partialResult = { content: [{ type: "text", text: "x".repeat(1_000_000) }] };
    handleAgentEvent("room:rm_events", "Events", "instance", {
      type: "tool_update", toolName: "read", toolCallId: "call", partialResult,
    }, [], "mem_events");
    const text = "text".repeat(10_000), thinking = "thought".repeat(10_000);
    handleAgentEvent("room:rm_events", "Events", "instance", { type: "message_update", text, thinking }, [], "mem_events");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ type: "tool_update", toolName: "read", toolCallId: "call", partialResult });
    expect((sent[0] as { partialResult: unknown }).partialResult).toBe(partialResult);
    expect(sent[1]).toMatchObject({ type: "message_update", text, thinking });
    // Seal this test's stream so later fixtures cannot inherit its deltas.
    handleAgentEvent("room:rm_events", "Events", "instance", { type: "message_end" }, [], "mem_events");
  });

  it("persists source-less lifecycle without creating routed outbox work", () => {
    const fixture = setup();
    const handle = new MockAgentHandle();
    const instance = liveInstance(handle);
    instances.set(instanceKey(instance.memberId), instance);
    wireInstanceEvents(instance);

    handle.emit({type:"agent_start"});

    expect(instances.has(instanceKey(instance.memberId))).toBe(true);
    const row = fixture.db.get<{ id: string; source_ref: string | null; type: string }>(
      "SELECT id,source_ref,type FROM agent_events WHERE member_id=?", instance.memberId,
    );
    expect(row).toMatchObject({source_ref:null,type:"agent_start"});
    expect(readAgentEvent(row!.id)?.event).toMatchObject({type:"agent_start"});
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox WHERE kind='agent-event'")!.n).toBe(0);
  });

  it("rebuilds historical activity in logical sequence without inventing missing event time", () => {
    const fixture = setup();
    const imported = (id: string, sourceSeq: number, event: any, factTs: number) => importHistoricalEvent(fixture.db, {
      id, sourceKey: "room:rm_legacy", ownerKey: "legacy-owner", sourceSeq,
      memberId: "mem_events", sourceRef: "room:rm_legacy", event, ts: factTs,
    });
    imported("legacy-start-1", 1, { type: "agent_start", ts: 100 }, 100);
    imported("legacy-start-2", 2, { type: "agent_start", ts: 50 }, 50);
    imported("legacy-end", 3, { type: "agent_end", ts: 120 }, 120);
    imported("legacy-missing-start", 4, { type: "agent_start" }, 200);
    imported("legacy-missing-end", 5, { type: "agent_end", ts: 300 }, 300);
    const missing = (id: string, sourceSeq: number, event: any, factTs: number) => importHistoricalEvent(fixture.db, {
      id, sourceKey: "room:rm_missing", ownerKey: "legacy-owner", sourceSeq,
      memberId: "mem_events", sourceRef: "room:rm_missing", event, ts: factTs,
    });
    missing("missing-start-valid", 1, { type: "agent_start", ts: 100 }, 100);
    missing("missing-start-clears", 2, { type: "agent_start" }, 150);
    missing("missing-end-after-clear", 3, { type: "agent_end", ts: 200 }, 200);

    rebuildEventAggregates(fixture.db);

    expect(readStats("mem_events").activeMs).toBe(70);
    expect(readStats("mem_events").turns).toBe(3);
  });

  it("keeps raw SDK identity separate from one-time streamed fact materialization", () => {
    setup();
    const buffer: any[] = [];
    handleAgentEvent("room:rm_events", "Events", "instance", { type: "message_update", text: "streamed" }, buffer, "mem_events");
    const source = { type: "message_end", stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } } as any;
    handleAgentEvent("room:rm_events", "Events", "instance", source, buffer, "mem_events", "fake:model", "same-sdk-id");
    expect(readAgentEvent("same-sdk-id")?.event).toMatchObject({ text: "streamed", model: "fake:model" });

    expect(() => handleAgentEvent("room:rm_events", "Events", "instance", source, buffer, "mem_events", "other:model", "same-sdk-id")).not.toThrow();
    expect(readAgentEvent("same-sdk-id")?.event).toMatchObject({ text: "streamed", model: "fake:model" });
  });

  it("filters usage by exact source aliases and treats an explicit empty selection as no rows",()=>{
    const fixture=setup();
    const event=(inputTokens:number)=>({type:"message_end",ts:1_000,text:"done",stopReason:"stop",model:"fake:model",usage:{inputTokens,outputTokens:0,cacheRead:0,cacheWrite:0,cost:0}} as any);
    importHistoricalEvent(fixture.db,{id:"historical-match",sourceKey:"room-old",ownerKey:"owner",sourceSeq:1,event:event(2),ts:1_000});
    importHistoricalEvent(fixture.db,{id:"explicit-match",sourceKey:"room-old",ownerKey:"owner",sourceSeq:2,memberId:"mem_events",sourceRef:"room:room-old",event:event(3),ts:1_000});
    importHistoricalEvent(fixture.db,{id:"explicit-conflict",sourceKey:"room-old",ownerKey:"owner",sourceSeq:3,memberId:"mem_events",sourceRef:"room:other",event:event(5),ts:1_000});
    importHistoricalEvent(fixture.db,{id:"unrelated",sourceKey:"unrelated",ownerKey:"owner",sourceSeq:1,event:event(7),ts:1_000});
    rebuildEventAggregates(fixture.db);

    const selected=readUsageRows({sources:{sourceRefs:["room:room-new","room:room-old"],historicalSourceKeys:["room-new","room-old"]}});
    expect(selected.reduce((sum,row)=>sum+row.inputTokens,0)).toBe(5);
    expect(readUsageRows({sources:{sourceRefs:[],historicalSourceKeys:[]}})).toEqual([]);
    expect(readUsageRows({from:"1970-01-02",sources:{sourceRefs:["room:room-old"],historicalSourceKeys:["room-old"]}})).toEqual([]);
    expect(readUsageRows().reduce((sum,row)=>sum+row.inputTokens,0)).toBe(17);
  });

  it("keeps legacy token rows untouched while events and receipts remain the usage authority",()=>{
    const fixture=setup();
    fixture.db.run(`INSERT INTO token_usage_daily(member_id,date,model,input_tokens,output_tokens,cache_read,cache_write,cost,turns)
      VALUES('mem_events','2025-01-01','legacy/model',9,8,7,6,5,4)`);
    fixture.db.exec("ALTER TABLE token_usage_daily RENAME TO historical_token_usage_daily");
    appendMemberEvent({id:"current-usage",memberId:"mem_events",sourceRef:"room:rm_events",event:{
      type:"message_end",ts:Date.UTC(2026,8,19),model:"current/model",usage:{inputTokens:3,outputTokens:2,cacheRead:1,cacheWrite:0,cost:0.25},
    } as any});
    rebuildEventAggregates(fixture.db);

    expect(fixture.db.all("SELECT * FROM historical_token_usage_daily")).toEqual([expect.objectContaining({model:"legacy/model",input_tokens:9,turns:4})]);
    expect(readUsageRows()).toEqual([expect.objectContaining({model:"current/model",inputTokens:3,turns:1})]);
    expect(fixture.db.get<{n:number}>("SELECT COUNT(*) n FROM event_usage_receipts")!.n).toBe(1);
  });

  it("keeps member statistics for null-source facts and routes only addressed facts", () => {
    const fixture = setup();
    appendMemberEvent({ id: "start", memberId: "mem_events", sourceRef: null, event: { type: "agent_start", ts: 1_000 } });
    appendMemberEvent({ id: "end", memberId: "mem_events", sourceRef: null, event: { type: "agent_end", ts: 3_500 } });
    appendMemberEvent({ id: "usage", memberId: "mem_events", sourceRef: null, event: {
      type: "message_end", ts: 3_600, text: "done", stopReason: "stop", model: "fake:model",
      usage: { inputTokens: 10, outputTokens: 4, cacheRead: 2, cacheWrite: 1, cost: 0.25 },
    } });
    appendMemberEvent({ id: "room", memberId: "mem_events", sourceRef: "room:rm_events", event: { type: "system", text: "visible", ts: 3_700 } });

    expect(readStats("mem_events")).toEqual({
      turns: 1, toolCalls: 0, activeMs: 2_500,
      tokens: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
      cost: 0.25, updatedAt: 3_700,
    });
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM agent_events WHERE source_ref IS NULL")!.n).toBe(3);
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox WHERE kind='agent-event'")!.n).toBe(1);

    importHistoricalEvent(fixture.db, {
      id: "legacy-usage", sourceKey: "legacy/unknown/events.jsonl", ownerKey: "old-name", sourceSeq: 1, ts: 3_800,
      event: { type: "message_end", ts: 3_800, text: "legacy", stopReason: "stop", model: "legacy:model",
        usage: { inputTokens: 7, outputTokens: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 } },
    });
    fixture.db.run("INSERT INTO storage_meta(key,value) VALUES('event_aggregates_rebuild_required','1') ON CONFLICT(key) DO UPDATE SET value='1'");
    rebuildEventAggregates(fixture.db);
    const usage = readUsageRows();
    expect(usage).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: "mem_events", historicalOwnerKey: null, model: "fake:model", inputTokens: 10, turns: 1 }),
      expect.objectContaining({ memberId: null, historicalOwnerKey: "old-name", historicalSourceKey: "legacy/unknown/events.jsonl", model: "legacy:model", inputTokens: 7, turns: 1 }),
    ]));
    expect(fixture.db.get("SELECT 1 FROM storage_meta WHERE key='event_aggregates_rebuild_required'")).toBeUndefined();
    expect(readStats("mem_events").tokens.input).toBe(10);
  });
});
