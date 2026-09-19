import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockAgentHandle } from "./helpers/mock-runtime.js";
import { instances, instanceKey, type AgentInstance } from "../src/agent/instance.js";
import { wireInstanceEvents } from "../src/agent/scheduler.js";
import { appendMemberEvent, importHistoricalEvent, readAgentEvent, readStats, readUsageRows, rebuildEventAggregates } from "../src/agent/events.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => {
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
    sourceAgent: "general", status: "idle", dispatchState: "idle", promptInFlight: false,
    hadErrorInTurn: false, lastTurnError: null, pendingErrorNotice: null,
    lastMessageEndWasLength: false, lengthContinuationPending: false,
    lengthContinuationAttempted: false, compacting: false, turnActive: false,
    sessionSources: {
      member: { id: "mem_events", name: "Events", agent: "general", runtime: "mock" },
      compiled: { agentPrompt: "", envPrompt: "", appendSystemPrompt: [] },
      skills: [], skillPaths: [], cwd: "/tmp", runtimeName: "mock",
    },
    unsubscribe: () => {}, eventBuffer: [], appliedModel: "fake:model",
    pendingReload: null,
  };
}

describe("member event facts v2", () => {
  it("persists source-less lifecycle and removes an unexpectedly exited idle runtime", () => {
    const fixture = setup();
    const handle = new MockAgentHandle();
    const instance = liveInstance(handle);
    instances.set(instanceKey(instance.memberId), instance);
    wireInstanceEvents(instance);

    handle.emit({ type: "runtime_exit", unexpected: true, code: 9, signal: null, stderrTail: "gone" });

    expect(instances.has(instanceKey(instance.memberId))).toBe(false);
    const row = fixture.db.get<{ id: string; source_ref: string | null; type: string }>(
      "SELECT id,source_ref,type FROM agent_events WHERE member_id=?", instance.memberId,
    );
    expect(row).toMatchObject({ source_ref: null, type: "runtime_exit" });
    expect(readAgentEvent(row!.id)?.event).toMatchObject({ type: "runtime_exit", unexpected: true });
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox WHERE kind='agent-event'")!.n).toBe(0);
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
