/** Unified session assembly, awaited reload and compaction admission across scopes. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestServer, closeTestServer, createMockRoom, getTestWorkspace, loginAndGetToken, setupTestWorkspace } from "../helpers/test-server.js";
import { resetMocks, setMockCompactFn, setMockPromptFn } from "../helpers/mock-runtime.js";
import { pendingRuntimeInputCount, runtimeInputOwner } from "../../src/agent/orchestrator/runtime-input-service.js";

setupTestWorkspace();
afterEach(() => { vi.restoreAllMocks(); resetMocks(); });

async function setupRoom(name: string) {
  resetMocks();
  const ts = await createTestServer();
  try {
    const token = await loginAndGetToken(ts.port);
    const room = await createMockRoom(ts.port, token, `${name}-room`, [name]);
    const memberId = room.globalMemberIds![0];
    return { ts, roomId: room.id, memberId, scopeId: `room:${room.id}` };
  } catch (error) { await closeTestServer(ts); throw error; }
}

describe("buildMemberAgentSession + reload (batch 6 §2/§3)", () => {
  it("activation builds via the unified builder; reload awaits cleanup and preserves SQL session history", async () => {
    const { ts, roomId, memberId, scopeId } = await setupRoom("rebot");
    let releaseCleanup = () => {};
    let reloading: Promise<unknown> | undefined;
    try {
      const manager = await import("../../src/agent/orchestrator/agent-manager.js");
      const { saveCurrentSession, getCurrentSession } = await import("../../src/member/sessions.js");
      saveCurrentSession(memberId, { runtime: "pi-cli", sessionId: "retained-session" });
      // An empty room builds an idle instance, not an invented human instruction.
      await manager.activateAgent(roomId, memberId);
      const instance = manager.getAgentInstanceForScope(scopeId, memberId)!;
      expect(instance.scopeId).toBe(scopeId);
      expect(instance.status).toBe("idle");
      const originalCleanup = instance.handle.destroyAndWait!.bind(instance.handle);
      const gate = new Promise<void>(resolve => { releaseCleanup = resolve; });
      const cleanup = vi.spyOn(instance.handle, "destroyAndWait").mockImplementation(async () => { await gate; await originalCleanup(); });
      let settled = false;
      reloading = manager.reloadMemberSession(scopeId, memberId, "tool").then(result => { settled = true; return result; });
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      releaseCleanup();
      expect(await reloading).toEqual({ queued: false, rebuilt: true });
      const rebuilt = manager.getAgentInstanceForScope(scopeId, memberId);
      expect(rebuilt).toBeTruthy();
      expect(rebuilt).not.toBe(instance);
      expect(getCurrentSession(memberId)).toMatchObject({ sessionId: "retained-session" });
    } finally {
      releaseCleanup();
      try { await reloading; } finally { await closeTestServer(ts); }
    }
  });

  // Real SDK order: compaction_end precedes agent_end. Reload must wait for
  // actual compaction settlement, then flush even without another queued input.
  it("mid-compaction reload queues; actual compaction settlement rebuilds the session", async () => {
    const { ts, memberId, scopeId } = await setupRoom("queuebot");
    let release = () => {};
    let compacting: Promise<unknown> | undefined;
    try {
      const manager = await import("../../src/agent/orchestrator/agent-manager.js");
      const instance = await manager.buildMemberAgentSession(memberId, scopeId);
      const gate = new Promise<void>(resolve => { release = resolve; });
      const compact = vi.fn(() => gate);
      setMockCompactFn(compact);
      compacting = manager.compactMember(scopeId, memberId);
      await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
      expect(await manager.reloadMemberSession(scopeId, memberId, "tool")).toEqual({ queued: true, rebuilt: false });
      expect(instance!.pendingReload).toBe("tool");
      release();
      expect(await compacting).toEqual({ ok: true, action: "compacted" });
      await vi.waitFor(() => {
        const rebuilt = manager.getAgentInstanceForScope(scopeId, memberId);
        expect(rebuilt).toBeTruthy();
        expect(rebuilt).not.toBe(instance);
      });
      expect(instance!.pendingReload).toBeNull();
    } finally {
      release();
      try { await compacting; } finally { await closeTestServer(ts); }
    }
  });

  it.each(["room", "dm"])("%s messages wait in SQL during compaction; only explicit Stop aborts it", async kind => {
    const { ts, roomId, memberId } = await setupRoom(`compact-${kind}`);
    let release = () => {};
    let compacting: Promise<unknown> | undefined;
    try {
      const manager = await import("../../src/agent/orchestrator/agent-manager.js");
      const { addDmMessage } = await import("../../src/chat/dm-message-store.js");
      const { addMessage } = await import("../../src/chat/message-store.js");
      const scopeId = kind === "dm" ? `dm:${memberId}` : `room:${roomId}`;
      const instance = await manager.buildMemberAgentSession(memberId, scopeId);
      expect(instance).toBeTruthy();
      const gate = new Promise<void>(resolve => { release = resolve; });
      const compact = vi.fn(() => gate);
      setMockCompactFn(compact);
      const prompt = vi.fn().mockResolvedValue(undefined);
      setMockPromptFn(prompt);
      compacting = manager.compactMember(scopeId, memberId);
      await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
      // Ignore compactMember's initial stop of the old turn; observe new arrivals.
      const abort = vi.spyOn(instance!.handle, "abort");
      const owner = runtimeInputOwner(scopeId, memberId);
      expect(pendingRuntimeInputCount(owner)).toBe(0);
      const message = { sender: "user", content: `@compact-${kind} continue`, mentions: [`compact-${kind}`] };
      if (kind === "dm") { addDmMessage(memberId, message); await manager.activateDmMember(memberId); }
      else { addMessage(roomId, message); await manager.activateAgent(roomId, memberId); }
      expect(abort).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(pendingRuntimeInputCount(owner)).toBe(1);
      if (kind !== "dm") {
        addMessage(roomId, { ...message, content: "follow-up while compacting" });
        await manager.activateAgent(roomId, memberId);
        expect(abort).not.toHaveBeenCalled();
        expect(pendingRuntimeInputCount(owner)).toBe(2);
      }
      expect(manager.abortAgent(kind === "room" ? roomId : scopeId, memberId)).toEqual({ ok: true, action: "aborted" });
      expect(abort).toHaveBeenCalledTimes(1);
      expect(pendingRuntimeInputCount(owner)).toBe(0);
      const rows = getTestWorkspace().db.all<{ status: string; diagnosis: string }>("SELECT status,diagnosis FROM queued_inputs WHERE scope_id=? AND target_actor_key=?", owner.scopeId, memberId);
      expect(rows).toHaveLength(kind === "dm" ? 1 : 2);
      for (const row of rows) expect(row).toMatchObject({ status: "interrupted", diagnosis: "explicit stop" });
      release();
      await compacting;
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      release();
      try { await compacting; } finally { await closeTestServer(ts); }
    }
  });

  it("assembly is unified: exactly one runtime.createAgent call site in agent-manager", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../src/agent/orchestrator/agent-manager.ts"), "utf-8");
    expect(src.match(/await runtime\.createAgent\(/g)?.length).toBe(1);
    // ① batch 2 / C1: the scope-aware compiler is gone; no call site passes a scope.
    expect(src.match(/compileMemberPromptForScope/g)).toBeNull();
    expect(src.match(/compileMemberPrompt\(\{\s*scopeId/g)).toBeNull();
  });
});
