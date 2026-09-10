import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockRuntime, resetMocks, setMockPromptFn } from "./helpers/mock-runtime.js";
import { RuntimeRegistry } from "../src/engine/runtime/registry.js";
import { abortAgent, activateAgent, buildMemberAgentSession, getAgentInstanceForScope, initAgentManager, shutdownAll } from "../src/engine/agent-manager.js";
import { getDefaultConfig, writeConfig } from "../src/shared/config.js";
import { saveAgentDefinition } from "../src/workforce/agent-store.js";
import { createMember } from "../src/workspace/member-registry.js";
import { createRoom, stampGlobalMemberIds } from "../src/workspace/room-store.js";
import { addMessage } from "../src/workspace/message-store.js";

let fixture: ReturnType<typeof coreFixture>;
let roomId: string;
let memberId: string;
let release = () => {};
let activation: Promise<void> | undefined;

beforeEach(() => {
  fixture = coreFixture();
  resetMocks();
  release = () => {};
  activation = undefined;
  writeConfig(getDefaultConfig());
  saveAgentDefinition("general", "---\nname: general\nskills: []\n---\nGeneral");
  memberId = createMember({ name: "worker", agentTemplate: "general", model: "mock/model", credentialId: "cred-test" }).id;
  roomId = createRoom("Abort", undefined, []).id;
  stampGlobalMemberIds(roomId, [memberId], memberId);
  const registry = new RuntimeRegistry();
  registry.register(new MockRuntime("pi-cli"));
  initAgentManager(registry);
});

afterEach(async () => {
  release();
  try { await activation; }
  finally {
    try { await shutdownAll(); }
    finally { vi.restoreAllMocks(); fixture.close(); }
  }
});

describe("abortAgent", () => {
  it("returns the not_found shape when no instance exists", () => {
    expect(abortAgent(roomId, memberId)).toEqual({ ok: false, action: "not_found" });
  });

  it("returns already_idle without aborting an idle instance", async () => {
    const instance = await buildMemberAgentSession(memberId, `room:${roomId}`);
    const abort = vi.spyOn(instance!.handle, "abort");
    expect(abortAgent(roomId, memberId)).toEqual({ ok: true, action: "already_idle" });
    expect(abort).not.toHaveBeenCalled();
  });

  it("abort function is exported and callable", () => {
    expect(typeof abortAgent).toBe("function");
  });

  it("stops native work without claiming idle before the prompt settles", async () => {
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prompt = vi.fn(() => gate);
    setMockPromptFn(prompt);
    addMessage(roomId, { sender: "user", content: "@worker work", mentions: ["worker"] });
    activation = activateAgent(roomId, memberId);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    const instance = getAgentInstanceForScope(`room:${roomId}`, memberId)!;
    const abort = vi.spyOn(instance.handle, "abort");
    expect(abortAgent(roomId, memberId)).toEqual({ ok: true, action: "aborted" });
    expect(abort).toHaveBeenCalledOnce();
    expect(instance.status).toBe("working");
    expect(instance.promptInFlight).toBe(true);
    release();
    await activation;
    await vi.waitFor(() => {
      expect(instance.promptInFlight).toBe(false);
      expect(instance.status).toBe("idle");
    });
    expect(getAgentInstanceForScope(`room:${roomId}`, memberId)).toBe(instance);
  });
});
