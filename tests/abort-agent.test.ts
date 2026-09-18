import { loadMemberPromptSource, loadAgentMemberSnapshot } from "../src/app/member-actions.js";
import { getDefaultConfig, writeConfig } from "../src/config/settings.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockRuntime, resetMocks, setMockPromptFn } from "./helpers/mock-runtime.js";
import { RuntimeRegistry } from "src/agent/types.js";
import { abortAgent, shutdownAll } from "../src/agent/controls.js";
import { activateAgent, getAgentInstanceForScope, initializeMemberRuntime } from "../src/app/member-actions.js";
import { buildMemberAgentSession } from "../src/agent/assembly.js";

import { createMember } from "../src/app/member-actions.js";
import { createRoom, stampGlobalMemberIds } from "../src/chat/conversations.js";
import { addMessage } from "../src/chat/message-store.js";

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
  memberId = createMember({ name: "worker", agentTemplate: "general", model: "mock/model", credentialId: "cred-test" }).id;
  roomId = createRoom("Abort", undefined, []).id;
  stampGlobalMemberIds(roomId, [memberId], memberId);
  const registry = new RuntimeRegistry();
  registry.register(new MockRuntime("pi-cli"));
  initializeMemberRuntime(registry, loadMemberPromptSource, loadAgentMemberSnapshot);
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
