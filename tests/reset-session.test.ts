import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { coreFixture } from "./helpers/core-fixture.js";
import { MockRuntime, resetMocks } from "./helpers/mock-runtime.js";
import { RuntimeRegistry } from "../src/engine/runtime/registry.js";
import { initAgentManager, activateAgent, buildMemberAgentSession, resetAgentSession, shutdownAll } from "../src/engine/agent-manager.js";
import { getDefaultConfig, writeConfig } from "../src/shared/config.js";
import { createMember, updateMemberIdentity } from "../src/member/member-registry.js";
import { createRoom, stampGlobalMemberIds, getCursors, setCursor } from "../src/chat/room-store.js";
import { addMessage } from "../src/chat/message-store.js";
import * as sessionStore from "../src/member/session-store.js";
import { loadEventsFromDisk } from "../src/engine/event-handler.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../src/communication/ws.js";

vi.mock("../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
}));

let fixture: ReturnType<typeof coreFixture>;
let roomId: string;
let memberId: string;
let runtime: MockRuntime;
let saved: { sessionId: string; sessionFile: string };

/** One member session (① A1/A2): `members/<id>/sessions/<day>/main/`, no scope. */
function retainSession(id: string) {
  const directory = sessionStore.mainSessionDirectory(id);
  mkdirSync(directory, { recursive: true });
  const manager = SessionManager.create(fixture.root, directory);
  manager.appendMessage({ role: "user", content: "retained requirement", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "retained answer" }], api: "openai-completions", provider: "mock", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  const session = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()! };
  sessionStore.saveCurrentSession(id, { runtime: "pi-cli", ...session });
  return session;
}

beforeEach(() => {
  fixture = coreFixture();
  resetMocks();
  vi.clearAllMocks();
  writeConfig(getDefaultConfig());
  memberId = createMember({ name: "pm", agentTemplate: "general", model: "mock/model", credentialId: "cred-test" }).id;
  roomId = createRoom("Reset", undefined, []).id;
  stampGlobalMemberIds(roomId, [memberId], memberId);
  const message = addMessage(roomId, { sender: "user", content: "hello", mentions: [] });
  setCursor(roomId, memberId, message.id);
  saved = retainSession(memberId);
  runtime = new MockRuntime("pi-cli");
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  initAgentManager(registry);
});

afterEach(async () => {
  try { await shutdownAll(); }
  finally { vi.restoreAllMocks(); fixture.close(); }
});

describe("resetAgentSession", () => {
  it("resumes the member's one session from any chat", async () => {
    const create = vi.spyOn(runtime, "createAgent");
    await activateAgent(roomId, memberId);
    expect(create.mock.calls[0][0].resumeSession).toEqual(saved);
    await shutdownAll();
    // Same member, private chat: the session is member-level, so it resumes there too.
    await buildMemberAgentSession(memberId, `dm:${memberId}`);
    expect(create.mock.calls.at(-1)![0].resumeSession).toEqual(saved);
  });

  it("does not resume another owner's session after taking their old display name", async () => {
    updateMemberIdentity(memberId, { name: "renamed-owner" });
    const other = createMember({ name: "pm", agentTemplate: "general", model: "mock/model", credentialId: "cred-test" });
    stampGlobalMemberIds(roomId, [memberId, other.id], memberId);
    const create = vi.spyOn(runtime, "createAgent");
    await activateAgent(roomId, "pm");
    expect(create.mock.calls[0][0].member.id).toBe(other.id);
    expect(create.mock.calls[0][0].resumeSession).toBeUndefined();
    expect(sessionStore.getCurrentSession(memberId)).toMatchObject(saved);
  });

  it("explicit reset clears a missing-file reference without reading it", () => {
    rmSync(saved.sessionFile);
    expect(() => sessionStore.getCurrentSession(memberId)).toThrow("referenced by database is missing");
    const read = vi.spyOn(sessionStore, "getCurrentSession");
    expect(resetAgentSession(roomId, memberId)).toEqual({ ok: true, message: "Session reset. Next activation will start fresh." });
    expect(read).not.toHaveBeenCalled();
    expect(sessionStore.getCurrentSession(memberId)).toBeUndefined();
  });

  it("destroys instance, clears SQL session and cursor, emits the visible event, and retains SDK history", async () => {
    const history = readFileSync(saved.sessionFile, "utf8");
    const instance = await buildMemberAgentSession(memberId, `room:${roomId}`);
    const destroy = vi.spyOn(instance!.handle, "destroy");
    const result = resetAgentSession(roomId, memberId);
    expect(result).toEqual({ ok: true, message: "Session reset. Next activation will start fresh." });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(sessionStore.getCurrentSession(memberId)).toBeUndefined();
    expect(getCursors(roomId)[memberId]).toBeNull();
    expect(loadEventsFromDisk(roomId, memberId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "system", text: result.message }),
    ]));
    await vi.waitFor(() => expect(broadcastToAgentSubscribers).toHaveBeenCalledWith(roomId, "pm", expect.objectContaining({
      type: "agent:event", roomId, agent: "pm", memberId, event: expect.objectContaining({ type: "system", text: result.message }),
    })));
    expect(broadcastToRoom).toHaveBeenCalledWith(roomId, expect.objectContaining({ type: "agent:status", roomId, agent: "pm", memberId, status: "inactive" }));
    expect(readFileSync(saved.sessionFile, "utf8")).toBe(history);
  });

  it("reset from a private chat clears the member session and leaves room cursor state alone", () => {
    const scope = `dm:${memberId}`;
    const roomCursor = getCursors(roomId)[memberId];
    resetAgentSession(scope, memberId);
    expect(sessionStore.getCurrentSession(memberId)).toBeUndefined();
    expect(getCursors(roomId)[memberId]).toBe(roomCursor);
    expect(loadEventsFromDisk(scope, memberId)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "system", text: "Session reset. Next activation will start fresh." })]));
    const status = expect.objectContaining({ type: "agent:status", roomId: scope, memberId, status: "inactive" });
    expect(broadcastToAgentSubscribers).toHaveBeenCalledWith(scope, "pm", status);
    expect(readFileSync(saved.sessionFile, "utf8")).toContain("retained requirement");
  });

  it("reset targets the stable owner, never a different owner whose ID equals its display name", () => {
    const other = createMember({ name: "other", agentTemplate: "general" });
    stampGlobalMemberIds(roomId, [memberId, other.id], memberId);
    const otherSaved = retainSession(other.id);
    const message = addMessage(roomId, { sender: "user", content: "other cursor", mentions: [] });
    setCursor(roomId, other.id, message.id);
    updateMemberIdentity(memberId, { name: other.id });
    resetAgentSession(roomId, memberId);
    expect(sessionStore.getCurrentSession(memberId)).toBeUndefined();
    expect(getCursors(roomId)[memberId]).toBeNull();
    expect(sessionStore.getCurrentSession(other.id)).toMatchObject(otherSaved);
    expect(getCursors(roomId)[other.id]).toBe(message.id);
  });
});
