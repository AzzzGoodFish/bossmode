import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentSystemPrompt } from "../src/agent/controls.js";
import { instanceKey, instances, pendingCreations, type AgentInstance } from "../src/agent/instance.js";
import { readMemberSystemPrompt } from "../src/app/member-actions.js";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockAgentHandle } from "./helpers/mock-runtime.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => {
  instances.clear();
  pendingCreations.clear();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setupMember() {
  const fixture = coreFixture();
  fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_prompt", "Prompt", "prompt", "general", "{}", 1, 1,
  );
  return fixture;
}

function live(handle: MockAgentHandle): AgentInstance {
  return {
    handle, activeSourceRef: null, memberId: "mem_prompt", agentName: "Prompt",
    status: "idle", dispatchState: "idle", promptInFlight: false,
    hadErrorInTurn: false, lastTurnError: null, pendingErrorNotice: null,
    lastMessageEndWasLength: false, lengthContinuationPending: false,
    lengthContinuationAttempted: false, compacting: false, turnActive: false,
    sessionSources: { compiled: { agentPrompt: "input is not output", appendSystemPrompt: ["also not output"] } },
    unsubscribe() {}, eventBuffer: [], appliedModel: "fake:model", pendingReload: null,
  };
}

describe("live SDK system prompt read", () => {
  it("returns a normal empty state without creating an instance", async () => {
    setupMember();
    const beforePending = pendingCreations.size;
    await expect(readMemberSystemPrompt("mem_prompt")).resolves.toEqual({
      available: false,
      reason: "instance_not_running",
    });
    expect(instances.size).toBe(0);
    expect(pendingCreations.size).toBe(beforePending);
  });

  it("reads an idle instance and fingerprints the actual SDK text", async () => {
    setupMember();
    const text = "SDK current system prompt\nwith cwd and resources";
    const handle = new MockAgentHandle(text);
    instances.set(instanceKey("mem_prompt"), live(handle));

    await expect(readMemberSystemPrompt("mem_prompt")).resolves.toEqual({
      available: true,
      text,
      contractFingerprint: createHash("sha1").update(text, "utf8").digest("hex"),
    });
  });

  it("does not expose a handle once teardown starts, even before its map entry is removed", async () => {
    setupMember();
    const handle = new MockAgentHandle("must disappear");
    const instance = live(handle);
    instances.set(instanceKey("mem_prompt"), instance);

    await handle.destroyAndWait();
    expect(instances.get(instanceKey("mem_prompt"))).toBe(instance);
    await expect(readAgentSystemPrompt("mem_prompt")).resolves.toEqual({
      available: false,
      reason: "instance_not_running",
    });
  });

  it("rejects an async result from an instance replaced during the read", async () => {
    setupMember();
    let resolve!: (text: string | null) => void;
    const pending = new Promise<string | null>(done => { resolve = done; });
    const firstHandle = new MockAgentHandle("old");
    firstHandle.readSystemPrompt = () => pending;
    const first = live(firstHandle);
    instances.set(instanceKey("mem_prompt"), first);

    const reading = readAgentSystemPrompt("mem_prompt");
    instances.set(instanceKey("mem_prompt"), live(new MockAgentHandle("new")));
    resolve("old");

    await expect(reading).resolves.toEqual({ available: false, reason: "instance_not_running" });
  });

  it("never returns previously read text after the instance is removed", async () => {
    setupMember();
    const handle = new MockAgentHandle("one-time live text");
    instances.set(instanceKey("mem_prompt"), live(handle));
    await expect(readMemberSystemPrompt("mem_prompt")).resolves.toMatchObject({ available: true });

    await handle.destroyAndWait();
    instances.delete(instanceKey("mem_prompt"));
    const after = await readMemberSystemPrompt("mem_prompt");
    expect(after).toEqual({ available: false, reason: "instance_not_running" });
    expect("text" in after).toBe(false);
  });
});
