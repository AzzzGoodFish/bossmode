import { afterEach, describe, expect, it } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { instances, instanceKey, type AgentInstance } from "../src/agent/instance.js";
import {
  acceptAgentAdmission, configureScheduler, readQueuedInput, wakeAgent,
  type AgentAdmissionReceipt,
} from "../src/agent/scheduler.js";
import type { AgentHandle, AgentMemberConfig } from "../src/agent/types.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => {
  instances.clear();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup() {
  const fixture = coreFixture(); fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_auth", "Auth", "auth", "general", "{}", 1, 1,
  );
  return fixture;
}

function fakeInstance(onPrompt: AgentHandle["prompt"]): AgentInstance {
  const handle: AgentHandle = {
    isWorking: false,
    prompt: onPrompt,
    abort() {}, destroy() {}, async destroyAndWait() {}, async waitForIdle() {},
    subscribe() { return () => {}; },
  };
  return {
    handle, activeSourceRef: null, memberId: "mem_auth", agentName: "Auth", sourceAgent: "general",
    status: "idle", dispatchState: "idle", promptInFlight: false, hadErrorInTurn: false,
    lastTurnError: null, pendingErrorNotice: null, lastMessageEndWasLength: false,
    lengthContinuationPending: false, lengthContinuationAttempted: false, compacting: false, turnActive: false,
    sessionSources: {
      member: { id: "mem_auth", name: "Auth", agent: "general", runtime: "fake" },
      compiled: { agentPrompt: "", envPrompt: "", appendSystemPrompt: [] },
      skills: [], skillPaths: [], cwd: "/tmp", runtimeName: "fake",
    },
    unsubscribe: () => {}, eventBuffer: [], appliedModel: "fake:model", pendingReload: null,
  };
}

function admission(fixture: ReturnType<typeof coreFixture>, key: string, sourceRef: string): AgentAdmissionReceipt {
  return fixture.db.transaction(tx => acceptAgentAdmission(tx, {
    memberId: "mem_auth", sourceRef, idempotencyKey: key,
    input: { prompt: key, trigger: "chat-message", replySources: [] }, replyExpected: false,
  }));
}

function wire(options: {
  authorize: (sourceRef: string | null) => boolean;
  build: () => Promise<AgentInstance | null>;
}) {
  configureScheduler({
    buildSession: options.build,
    memberConfig: () => ({ id: "mem_auth", name: "Auth", agent: "general", runtime: "fake" } as AgentMemberConfig),
    authorizeExecution: (_memberId, sourceRef) => options.authorize(sourceRef),
    postSystemNotice() {}, emitEvent() {}, refreshProfileSources() {}, applyPendingControls() {},
    interruptAccepted() {}, flushPendingReload() {}, reloadSession: async () => ({ queued: false, rebuilt: false }),
    hasPendingReply: () => false, dismissReplies() {},
  });
}

describe("execution authorization boundaries v2", () => {
  it("rechecks after asynchronous build and never calls the runtime after revocation", async () => {
    const fixture = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let allowed = true;
    let runtimeCalls = 0;
    const instance = fakeInstance(async () => { runtimeCalls++; });
    wire({
      authorize: () => allowed,
      build: async () => { await gate; instances.set(instanceKey("mem_auth"), instance); return instance; },
    });
    const receipt = admission(fixture, "build-race", "room:revoked");
    const running = wakeAgent("mem_auth", receipt);
    await Promise.resolve();
    allowed = false;
    release();
    await running;

    expect(runtimeCalls).toBe(0);
    expect(readQueuedInput(fixture.db, receipt.inputId, "mem_auth")).toMatchObject({
      status: "interrupted", diagnosis: "execution authorization revoked",
    });
  });

  it("cancels only the revoked source and continues an authorized source", async () => {
    const fixture = setup();
    let providerDispatches = 0;
    const instance = fakeInstance(async (message, options) => {
      options?.beforeDispatch?.({ attemptId: `attempt:${message}`, dispatchIndex: 0, message });
      providerDispatches++;
    });
    instances.set(instanceKey("mem_auth"), instance);
    wire({ authorize: sourceRef => sourceRef !== "room:revoked", build: async () => instance });
    const revoked = admission(fixture, "revoked", "room:revoked");
    const allowed = admission(fixture, "allowed", "dm:mem_auth");

    await wakeAgent("mem_auth", revoked);
    await wakeAgent("mem_auth", allowed);

    expect(providerDispatches).toBe(1);
    expect(readQueuedInput(fixture.db, revoked.inputId, "mem_auth")?.status).toBe("interrupted");
    expect(readQueuedInput(fixture.db, allowed.inputId, "mem_auth")).toMatchObject({ status: "settled", outcome: "completed" });
  });

  it("serves room, user DM and member DM through one continuous member instance", async () => {
    const fixture = setup();
    const seen: Array<{ sourceRef: string | null; message: string }> = [];
    let builds = 0;
    let instance!: AgentInstance;
    instance = fakeInstance(async (message, options) => {
      seen.push({ sourceRef: instance.activeSourceRef, message });
      options?.beforeDispatch?.({ attemptId: `attempt:${message}`, dispatchIndex: 0, message });
    });
    wire({
      authorize: () => true,
      build: async () => { builds++; instances.set(instanceKey("mem_auth"), instance); return instance; },
    });
    const receipts = [
      admission(fixture, "room", "room:rm_one"),
      admission(fixture, "dm", "dm:mem_auth"),
      admission(fixture, "mm", "mm:mem_auth:mem_peer"),
    ];
    for (const receipt of receipts) await wakeAgent("mem_auth", receipt);

    expect(builds).toBe(1);
    expect(seen).toEqual([
      { sourceRef: "room:rm_one", message: "room" },
      { sourceRef: "dm:mem_auth", message: "dm" },
      { sourceRef: "mm:mem_auth:mem_peer", message: "mm" },
    ]);
    expect(instances.get(instanceKey("mem_auth"))).toBe(instance);
    expect(instance.activeSourceRef).toBeNull();
  });

  it("rechecks inside beforeDispatch so revoked work has no provider dispatch receipt", async () => {
    const fixture = setup();
    let checks = 0;
    let providerDispatches = 0;
    const instance = fakeInstance(async (message, options) => {
      options?.beforeDispatch?.({ attemptId: `attempt:${message}`, dispatchIndex: 0, message });
      providerDispatches++;
    });
    instances.set(instanceKey("mem_auth"), instance);
    wire({ authorize: () => ++checks < 4, build: async () => instance });
    const receipt = admission(fixture, "dispatch-race", "room:race");

    await wakeAgent("mem_auth", receipt);

    expect(providerDispatches).toBe(0);
    expect(readQueuedInput(fixture.db, receipt.inputId, "mem_auth")).toMatchObject({ status: "interrupted" });
  });
});
