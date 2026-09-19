import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockAgentHandle } from "./helpers/mock-runtime.js";
import { compactMemberById, configureControls } from "../src/agent/controls.js";
import { configureScheduler, wireInstanceEvents } from "../src/agent/scheduler.js";
import { instances, instanceKey, type AgentInstance } from "../src/agent/instance.js";
import type { AgentMemberConfig } from "../src/agent/types.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => { instances.clear(); for (const fixture of fixtures.splice(0)) fixture.close(); });

function setup() {
  const fixture = coreFixture(); fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_compact", "Compact", "compact", "general", "{}", 1, 1,
  );
  return fixture;
}

function instance(handle: MockAgentHandle): AgentInstance {
  return {
    handle, activeSourceRef: null, memberId: "mem_compact", agentName: "Compact", sourceAgent: "general",
    status: "idle", dispatchState: "idle", promptInFlight: false, hadErrorInTurn: false,
    lastTurnError: null, pendingErrorNotice: null, lastMessageEndWasLength: false,
    lengthContinuationPending: false, lengthContinuationAttempted: false, compacting: false, turnActive: false,
    sessionSources: {
      member: { id: "mem_compact", name: "Compact", agent: "general", runtime: "fake" },
      compiled: { agentPrompt: "", envPrompt: "", appendSystemPrompt: [] },
      skills: [], skillPaths: [], cwd: "/tmp", runtimeName: "fake",
    },
    unsubscribe: () => {}, eventBuffer: [], appliedModel: "fake:model", pendingReload: null,
  };
}

describe("null-source member controls v2", () => {
  it("compacts without inventing a DM source and persists the lifecycle", async () => {
    const fixture = setup();
    const handle = new MockAgentHandle();
    const live = instance(handle);
    instances.set(instanceKey(live.memberId), live);
    const config = { id: live.memberId, name: live.agentName, agent: "general", runtime: "fake", model: "fake:model", credentialId: "cred" } as AgentMemberConfig;
    configureScheduler({
      buildSession: async () => live, memberConfig: () => config, authorizeExecution: () => true,
      postSystemNotice() {}, emitEvent() {}, loadProfileSources() { throw new Error("unexpected profile refresh"); }, applyPendingControls() {}, interruptAccepted() {},
      flushPendingReload() {}, reloadSession: async () => ({ queued: false, rebuilt: false }),
      hasPendingReply: () => false, dismissReplies() {},
    });
    configureControls({
      memberConfig: () => config, resolveMember: () => ({ id: live.memberId, name: live.agentName }), memberScopes: () => [],
      clearSession() {}, commitModelBinding() {}, emitEvent() {}, postSystemNotice() {}, publishStatus() {}, publishReset() {},
    });
    wireInstanceEvents(live);

    await expect(compactMemberById(live.memberId)).resolves.toEqual({ ok: true, action: "compacted" });

    expect(live.activeSourceRef).toBeNull();
    expect(fixture.db.all<{ source_ref: string | null }>(
      "SELECT source_ref FROM agent_events WHERE member_id=?", live.memberId,
    )).toEqual(expect.arrayContaining([
      { source_ref: null }, { source_ref: null }, { source_ref: null }, { source_ref: null },
    ]));
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM outbox WHERE kind='agent-event'")!.n).toBe(0);
  });
});
