/**
 * Restart pending-input recovery (qa 0.28.0-rc.1 observation ②).
 *
 * Pending queued inputs must pump after a restart (one dispatch per turn —
 * the current member-queue architecture never merges chat messages), while
 * inputs that were already dispatched at kill time become "uncertain" and are
 * deliberately not replayed (durable-execution semantics).
 */
import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockAgentHandle } from "./helpers/mock-runtime.js";
import {
  resumePendingRuntimeInputs, recoverRuntimeInputState, acceptControlInput,
  configureScheduler, wireInstanceEvents,
} from "../src/agent/scheduler.js";
import { instances, instanceKey, type AgentInstance } from "../src/agent/instance.js";
import { getDatabase } from "../src/data/database.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

const prompts: string[] = [];
function setup(memberId: string) {
  const fixture = coreFixture(); fixtures.push(fixture);
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    memberId, "Resume", "resume", "general", "{}", 1, 1);
  const handle = new MockAgentHandle();
  const instance = {
    memberId, agentName: "Resume", sourceAgent: "general", handle,
    activeSourceRef: null, sessionSources: { compiled: "" as never }, profilePromptDirty: false, appliedModel: "mock:model",
    eventBuffer: [], dispatchState: "idle", status: "idle" as const, pendingThinkingSwitch: null, pendingReload: null,
    promptInFlight: false, turnActive: false, compacting: false, hadErrorInTurn: false, lastTurnError: null, pendingErrorNotice: null,
    manualCompactionOutcome: undefined,
  } as unknown as AgentInstance;
  instances.set(instanceKey(memberId), instance);
  wireInstanceEvents(instance);
  const config = { id: memberId, name: "Resume", agent: "general", runtime: "fake", model: "mock:model", credentialId: "cred" } as never;
  configureScheduler({
    buildSession: async () => instance, memberConfig: () => config, authorizeExecution: () => true,
    postSystemNotice() {}, emitEvent() {}, loadProfileSources() { throw new Error("unexpected"); }, applyPendingControls() {}, interruptAccepted() {},
    flushPendingReload() {}, reloadSession: async () => ({ queued: false, rebuilt: false }),
    hasPendingReply: () => false, dismissReplies() {},
  });
  return { fixture, handle, memberId };
}

describe("restart pending-input recovery", () => {
  it("pumps pending inputs one turn each after a simulated restart", async () => {
    const { memberId } = setup("mem_resumetest1");
    acceptControlInput("dm:mem_resumetest1", memberId, { prompt: "<chat_message chat_id=\"dm_resumetest1\">first</chat_message>", source: "chat", trigger: "chat-message", replySources: [] }, false);
    acceptControlInput("dm:mem_resumetest1", memberId, { prompt: "<chat_message chat_id=\"dm_resumetest1\">second</chat_message>", source: "chat", trigger: "chat-message", replySources: [] }, false);
    prompts.length = 0;
    MockAgentHandle;
    resumePendingRuntimeInputs();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setTimeout(resolve, 50));
    const statuses = getDatabase().all("SELECT payload_json,status FROM queued_inputs ORDER BY id");
    expect(statuses.every(row => row.status === "settled")).toBe(true);
    expect(statuses).toHaveLength(2);
  });

  it("marks dispatched inputs uncertain instead of replaying them", () => {
    const { fixture, memberId } = setup("mem_resumetest2");
    const { input } = acceptControlInput("dm:mem_resumetest2", memberId, { prompt: "in-flight", source: "chat", trigger: "chat-message", replySources: [] }, false);
    fixture.db.run("UPDATE queued_inputs SET status='dispatched',dispatched_at=?,dispatch_token='killed-mid-flight' WHERE id=?", Date.now(), input.id);
    recoverRuntimeInputState();
    const row = fixture.db.get<{ status: string; diagnosis: string }>("SELECT status,diagnosis FROM queued_inputs WHERE id=?", input.id)!;
    expect(row.status).toBe("uncertain");
    expect(row.diagnosis).toContain("not replayed");
  });
});
