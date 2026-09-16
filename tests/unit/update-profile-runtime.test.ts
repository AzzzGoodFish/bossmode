import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestWorkspace } from "../helpers/test-server.js";
import { MockAgentHandle } from "../helpers/mock-runtime.js";
setupTestWorkspace();

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

it("renames a running member across room/DM without abort; next prompt refreshes self and peers", async () => {
  const reg = await import("../../src/member/member-registry.js");
  const roomStore = await import("../../src/chat/room-store.js");
  const manager = await import("../../src/agent/orchestrator/agent-manager.js");
  const { RuntimeRegistry } = await import("../../src/agent/runtime/registry.js");
  const suffix = randomUUID().slice(0, 6);
  const own = reg.createMember({ name: `Before-${suffix}`, agentTemplate: "developer", model: "mock-model", credentialId: "cred-test" });
  const peer = reg.createMember({ name: `Peer-${suffix}`, agentTemplate: "developer", model: "mock-model", credentialId: "cred-test" });
  const room = roomStore.createRoom("Runtime identity", undefined, []);
  roomStore.stampGlobalMemberIds(room.id, [own.id, peer.id]);
  const started = deferred(), release = deferred();
  const built: Array<{ opts: any; handle: any }> = [];
  let hold = true;
  const runtime = {
    name: "pi-cli", capabilities: {}, shutdownAll: async () => {},
    createAgent: vi.fn(async (opts: any) => {
      const handle = new MockAgentHandle() as any;
      handle.refreshPrompt = vi.fn();
      handle.abort = vi.fn();
      handle.prompt = vi.fn(async () => {
        handle.emit({ type: "agent_start" });
        if (hold && opts.roomId === room.id && opts.member.id === own.id) { started.resolve(); await release.promise; }
        handle.emit({ type: "agent_end" });
      });
      built.push({ opts, handle });
      return handle;
    }),
  };
  const runtimes = new RuntimeRegistry(); runtimes.register(runtime as any); manager.initAgentManager(runtimes);
  try {
    const scopes = [`room:${room.id}`, `dm:${own.id}`];
    for (const scope of scopes) expect(await manager.buildMemberAgentSession(own.id, scope)).toBeTruthy();
    expect(await manager.buildMemberAgentSession(peer.id, scopes[0])).toBeTruthy();
    const { postMessage } = await import("../../src/communication/message-bus.js");
    postMessage(room.id, "user", "Start the running turn");
    const pending = manager.activateAgent(room.id, own.id, { senderName: "peer", needResponseMemberIds: [] });
    await started.promise;
    const { handleToolCallback, loadScopeMessages } = await import("../../src/agent/tools/tools.js");
    const next = `言实 ${suffix}`;
    expect(await handleToolCallback("profile_update", room.id, own.name, { name: next, description: "Engineer" }, { memberId: own.id })).toMatchObject({ ok: true, member: { name: next } });
    expect(manager.getAgentStatus(room.id, own.id)).toBe("working");
    for (const scope of scopes) expect(manager.getAgentInstanceForScope(scope, own.id)!.agentName).toBe(next);
    for (const entry of built) expect(entry.handle.abort).not.toHaveBeenCalled();
    for (const entry of built.filter(e => e.opts.member.id === own.id)) {
      await entry.opts.callbacks.onChat("callback after rename");
      expect(loadScopeMessages(entry.opts.roomId).at(-1)).toMatchObject({ sender: next, senderMemberId: own.id });
    }
    expect(built[0].handle.refreshPrompt).not.toHaveBeenCalled();
    hold = false; release.resolve(); await pending;
    postMessage(room.id, "user", "Next turn after rename");
    await manager.activateAgent(room.id, own.id, { senderName: "peer", needResponseMemberIds: [] });
    expect(built[0].handle.refreshPrompt).toHaveBeenCalledWith(expect.objectContaining({ agentPrompt: expect.stringContaining(next) }));
    await manager.activateAgent(room.id, peer.id, { senderName: "peer", needResponseMemberIds: [] });
    const peerHandle = built.find(e => e.opts.member.id === peer.id)!.handle;
    // Prompt v2: the roster line is gone — a peer's refresh no longer carries
    // another member's new name; it refreshes its own member-level prompt.
    expect(peerHandle.refreshPrompt).toHaveBeenCalled();
    expect(JSON.stringify(peerHandle.refreshPrompt.mock.calls)).not.toContain(next);
    // ① B1: one runtime per member — the DM build reuses the room instance,
    // so only two creations happen (own room + peer).
    expect(runtime.createAgent).toHaveBeenCalledTimes(2);
    for (const entry of built) expect(entry.handle.abort).not.toHaveBeenCalled();
  } finally { release.resolve(); await manager.shutdownAll(); }
});

it("reconciles a rename while handle construction is awaiting", async () => {
  const reg = await import("../../src/member/member-registry.js");
  const manager = await import("../../src/agent/orchestrator/agent-manager.js");
  const { RuntimeRegistry } = await import("../../src/agent/runtime/registry.js");
  const member = reg.createMember({ name: `Construct-${randomUUID()}`, model: "mock", credentialId: "cred" });
  const entered = deferred(), release = deferred();
  const handle = new MockAgentHandle() as any; handle.refreshPrompt = vi.fn();
  const runtime = { name: "pi-cli", capabilities: {}, shutdownAll: async () => {}, createAgent: async () => { entered.resolve(); await release.promise; return handle; } };
  const runtimes = new RuntimeRegistry(); runtimes.register(runtime as any); manager.initAgentManager(runtimes);
  const scope = `dm:${member.id}`;
  try {
    const building = manager.buildMemberAgentSession(member.id, scope);
    await entered.promise;
    const { updateProfileForMember } = await import("../../src/member/member-profile-update.js");
    const next = `Constructed-${randomUUID()}`;
    updateProfileForMember(member.id, { name: next });
    release.resolve();
    const instance = await building;
    expect(instance!.agentName).toBe(next);
    expect(manager.getAgentInstanceForScope(scope, member.id)!.sessionSources.compiled.agentPrompt).toContain(next);
  } finally { release.resolve(); await manager.shutdownAll(); }
});

it.each(["room"])("keeps queued %s trigger and cursor on IDs when the old name is reused during construction", async (kind) => {
  const reg = await import("../../src/member/member-registry.js");
  const rooms = await import("../../src/chat/room-store.js");
  const manager = await import("../../src/agent/orchestrator/agent-manager.js");
  const { RuntimeRegistry } = await import("../../src/agent/runtime/registry.js");
  const { postMessage } = await import("../../src/communication/message-bus.js");
  const { updateProfileForMember } = await import("../../src/member/member-profile-update.js");
  const suffix = randomUUID().slice(0, 6);
  const own = reg.createMember({ name: `Queued-${suffix}`, agentTemplate: "developer", model: "mock", credentialId: "cred" });
  const peer = reg.createMember({ name: `Other-${suffix}`, agentTemplate: "developer", model: "mock", credentialId: "cred" });
  const room = rooms.createRoom("Queued identity", undefined, []);
  rooms.stampGlobalMemberIds(room.id, [own.id, peer.id]);
  const scope = room.id;
  const entered = deferred(), release = deferred();
  const handle = new MockAgentHandle() as any;
  handle.refreshPrompt = vi.fn(); handle.prompt = vi.fn(async () => {});
  const runtime = { name: "pi-cli", capabilities: {}, shutdownAll: async () => {}, createAgent: async () => { entered.resolve(); await release.promise; return handle; } };
  const runtimes = new RuntimeRegistry(); runtimes.register(runtime as any); manager.initAgentManager(runtimes);
  try {
    const first = postMessage(scope, "user", `@${own.name} ORIGINAL_REQUEST`, [own.name], { mentionMemberIds: [own.id] });
    const ctx = { senderName: "user", needResponseMemberIds: [] };
    const pending = manager.activateAgent(room.id, own.id, ctx);
    await entered.promise;
    updateProfileForMember(own.id, { name: `New-${suffix}` });
    updateProfileForMember(peer.id, { name: own.name });
    postMessage(scope, "user", `@${own.name} ANOTHER_MEMBER_REQUEST`, [own.name], { mentionMemberIds: [peer.id] });
    postMessage(scope, own.name, "OTHER_MEMBER_REPLY", [], { senderMemberId: peer.id });
    release.resolve(); await pending;
    expect(handle.prompt).toHaveBeenCalledOnce();
    expect(handle.prompt.mock.calls[0][0]).toContain("ORIGINAL_REQUEST");
    expect(handle.prompt.mock.calls[0][0]).not.toContain("ANOTHER_MEMBER_REQUEST");
    const cursors = rooms.getCursors(room.id);
    expect(cursors[own.id]).toBe(first.id);
    expect(rooms.getRoom(room.id)!.members).toContain(`New-${suffix}`);
    expect(handle.refreshPrompt.mock.calls[0][0].agentPrompt).toContain(`New-${suffix}`);
  } finally { release.resolve(); await manager.shutdownAll(); }
});
