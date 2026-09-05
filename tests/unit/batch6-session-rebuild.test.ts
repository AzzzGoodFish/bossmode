/**
 * Batch 6 §2+§3: unified buildMemberAgentSession + reload semantics.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestServer, closeTestServer, getTestBossmodeDir, jsonRequest, loginAndGetToken, setupConfigMock, type TestServer } from "../helpers/test-server.js";

setupConfigMock();

async function setupRoomWithActivatedMember(name: string): Promise<{ ts: TestServer; token: string; roomId: string; memberId: string; scopeId: string }> {
  const ts = await createTestServer();
  const token = await loginAndGetToken(ts.port);
  const created = await jsonRequest(ts.port, "POST", "/api/members", {
    token, body: { name, agentTemplate: "pm" },
  });
  const memberId = JSON.parse(created.body).member.memberId as string;
  // configure model+credential so the member is activation-ready
  const patched = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}/config`, {
    token, body: { model: "prov/m1", credentialId: "cred-1" },
  });
  expect(patched.status).toBe(200);
  const room = await jsonRequest(ts.port, "POST", "/api/rooms", {
    token, body: { name: `${name}-room`, cwd: getTestBossmodeDir(), memberIds: [memberId] },
  });
  expect(room.status).toBe(200);
  const roomId = JSON.parse(room.body).id as string;
  return { ts, token, roomId, memberId, scopeId: `room:${roomId}` };
}

describe("buildMemberAgentSession + reload (batch 6 §2/§3)", () => {
  it("activation builds via the unified builder; reload rebuilds with history-keep semantics", async () => {
    const { ts, token, roomId, memberId, scopeId } = await setupRoomWithActivatedMember("rebot");
    const { getAgentInstanceForScope, reloadMemberSession } = await import("../../src/engine/agent-manager.js");

    const sent = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, {
      token, body: { content: `@rebot hello` },
    });
    expect(sent.status).toBeLessThan(300);

    let instance: any = null;
    for (let i = 0; i < 50 && !instance; i++) {
      instance = getAgentInstanceForScope(scopeId, memberId);
      if (!instance) await new Promise((r) => setTimeout(r, 50));
    }
    expect(instance).toBeTruthy();
    expect(instance.scopeId).toBe(scopeId);

    const result = await reloadMemberSession(scopeId, memberId, "tool");
    expect(result).toEqual({ queued: false, rebuilt: true });
    const rebuilt = getAgentInstanceForScope(scopeId, memberId);
    expect(rebuilt).toBeTruthy();
    expect(rebuilt).not.toBe(instance);
    // Session store NOT cleared (reload keeps history — resetAgentSession clears it).
    const { getAgentInstanceForScope: _g } = { getAgentInstanceForScope };
    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((r) => ts.server.close(() => r()));
  }, 20000);

  it("mid-run reload queues; compaction_end settles the queue", async () => {
    const { ts, token, roomId, memberId, scopeId } = await setupRoomWithActivatedMember("queuebot");
    const { getAgentInstanceForScope, reloadMemberSession } = await import("../../src/engine/agent-manager.js");
    await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, {
      token, body: { content: `@queuebot hi` },
    });
    let instance: any = null;
    for (let i = 0; i < 50 && !instance; i++) {
      instance = getAgentInstanceForScope(scopeId, memberId);
      if (!instance) await new Promise((r) => setTimeout(r, 50));
    }
    expect(instance).toBeTruthy();

    // Mid-run → queued
    instance.status = "working";
    const queued = await reloadMemberSession(scopeId, memberId, "tool");
    expect(queued).toEqual({ queued: true, rebuilt: false });
    expect(instance.pendingReload).toBe("tool");

    // Turn settles → compaction_end flushes the pending rebuild
    instance.status = "idle";
    instance.compacting = true;
    instance.handle.emit({ type: "compaction_end" });
    await new Promise((r) => setTimeout(r, 200));
    expect(instance.pendingReload).toBeNull();
    const rebuilt = getAgentInstanceForScope(scopeId, memberId);
    expect(rebuilt).toBeTruthy();
    expect(rebuilt).not.toBe(instance);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((r) => ts.server.close(() => r()));
  }, 20000);

  it.each(["room", "dm", "topic"])("%s messages wait for compaction; only explicit Stop aborts it", async (kind) => {
    const { ts, roomId, memberId } = await setupRoomWithActivatedMember(`compact-${kind}`);
    const manager = await import("../../src/engine/agent-manager.js");
    const { createTopic } = await import("../../src/workspace/topic-store.js");
    const topic = kind === "topic" ? createTopic({ roomId, title: "compaction", anchorMessageId: "anchor", seedMode: "fresh" }) : null;
    const scopeId = kind === "dm" ? `dm:${memberId}` : topic ? `topic:${topic.id}` : roomId;
    try {
      const instance = await manager.buildMemberAgentSession(memberId, kind === "room" ? `room:${roomId}` : scopeId);
      expect(instance).toBeTruthy();
      const handle = instance!.handle as any;
      handle.emit({ type: "agent_start" });
      handle.emit({ type: "compaction_start" });
      const abort = vi.spyOn(handle, "abort");
      const prompt = vi.spyOn(handle, "prompt");
      const queued = instance!.queuedInputs.length;
      if (kind === "dm") await manager.activateDmMember(memberId);
      else if (topic) await manager.activateTopicMember(roomId, topic.id, memberId);
      else {
        const { addMessage } = await import("../../src/workspace/message-store.js");
        addMessage(roomId, { sender: "user", content: `@compact-${kind} continue`, mentions: [`compact-${kind}`] });
        await manager.activateAgent(roomId, memberId);
      }
      expect(abort).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(instance!.queuedInputs.length).toBeGreaterThan(queued);
      if (kind !== "dm") {
        // Even an urgent message must not cancel compaction.
        await manager.interruptAgent(scopeId, memberId, "user");
        expect(abort).not.toHaveBeenCalled();
      }
      manager.abortAgent(scopeId, memberId);
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      await closeTestServer(ts);
    }
  });

  it("assembly is unified: exactly one runtime.createAgent call site in agent-manager", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../../src/engine/agent-manager.ts"), "utf-8");
    expect(src.match(/await runtime\.createAgent\(/g)?.length).toBe(1);
    // compile lives only inside the builder (model-switch comparison excluded)
    expect(src.match(/compileMemberPromptForScope\(\{/g)?.length).toBe(2); // dm + topic branches of the builder
  });
});
