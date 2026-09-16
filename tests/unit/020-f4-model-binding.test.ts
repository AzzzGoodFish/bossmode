/**
 * F4 (2026-08-04, fish live report): model switch must persist to the 0.20
 * authority (member registry), not room.json memberOverrides — otherwise
 * display shows the old model and activate-heal silently rolls the session
 * back. Permanent assertions:
 *   switch → SQL global binding updated → memberOverrides untouched →
 *   re-activation does NOT roll the live session back. Retired scoped flags
 *   do not change ownership; raw config writes do not heal a live instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { coreFixture } from "../helpers/core-fixture.js";
import { getDatabase } from "../../src/data/database.js";
import { randomUUID } from "node:crypto";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
type PromptOptions = { beforeDispatch?: (event: { attemptId: string; dispatchIndex: number; message: string }) => void };
function dispatch(message: string, options?: PromptOptions) {
  getDatabase().transaction(() => options?.beforeDispatch?.({ attemptId: `mock-${randomUUID()}`, dispatchIndex: 0, message }));
}

const { broadcastToRoom } = vi.hoisted(() => ({ broadcastToRoom: vi.fn() }));

vi.mock("../../src/communication/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/ws.js")>();
  return {
    ...actual,
    broadcastToRoom: (...args: unknown[]) => broadcastToRoom(...args),
    broadcastToAgentSubscribers: vi.fn(),
  };
});

const PROFILE = {
  name: "Test provider",
  providerSlug: "testprov",
  protocol: "openai-responses" as const,
  baseUrl: "https://example.invalid/v1",
  authType: "api_key" as const,
  apiKey: "sk-test",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
  models: [
    { id: "claude-a", contextWindow: 100000, maxTokens: 8000, input: ["text" as const] },
    { id: "claude-b", contextWindow: 200000, maxTokens: 8000, input: ["text" as const] },
  ],
};

async function seedCredential() {
  const creds = await import("../../src/engine/model-credentials.js");
  return creds.saveModelCredentialProfile(PROFILE);
}

async function makeStampedRoom(memberId: string) {
  const roomStore = await import("../../src/chat/room-store.js");
  const room = roomStore.createRoom("R", dir, [memberId], undefined, { promptLeaderMemberId: memberId });
  return room;
}

describe("F4 model binding persists to the registry", () => {
  beforeEach(async () => {
    fixture = coreFixture();
    dir = fixture.root;
    (await import("../../src/shared/config.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } });
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
    broadcastToRoom.mockClear();

  });

  afterEach(async () => {
    await (await import("../../src/engine/agent-manager.js")).shutdownAll();
    fixture.close();
  });

  it("unifiedModel=true: switch writes the global binding; memberOverrides untouched; read side agrees", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room = await makeStampedRoom(member.id);

    const manager = await import("../../src/engine/agent-manager.js");
    await manager.switchMemberModel(member.id, { model: "testprov/claude-b", credentialId: cred.id });

    // New authority updated.
    expect(reg.getMember(member.id)!.global.model).toBe("testprov/claude-b");
    // Old authority NOT written.
    const roomStore = await import("../../src/chat/room-store.js");
    expect(roomStore.getRoom(room.id)!.memberOverrides).toBeUndefined();
    // Read side (display / heal) resolves the new model.
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room.id, member.id)?.model).toBe("testprov/claude-b");
  });

  it("batch-5b: switch always writes global even when the disk flag says scoped", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({
      name: "pm",
      agentTemplate: "pm",
      model: "testprov/claude-a",
      credentialId: cred.id,
      unifiedModel: false,
    });
    const room = await makeStampedRoom(member.id);

    const manager = await import("../../src/engine/agent-manager.js");
    await manager.switchMemberModel(member.id, { model: "testprov/claude-b", credentialId: cred.id });

    const rec = reg.getMember(member.id)!;
    expect(rec.global.model).toBe("testprov/claude-b");
    expect(rec.scopeOverrides[`room:${room.id}`]).toBeUndefined();
    expect(reg.getEffectiveConfig(member.id, `room:${room.id}`).model).toBe("testprov/claude-b");
    expect(reg.getEffectiveConfig(member.id, "room:other").model).toBe("testprov/claude-b");
  });

  it("MCP asset patches remain global and do not write room overrides", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const cred = await seedCredential();
    const roomStore = await import("../../src/chat/room-store.js");

    // Fully unified member: everything goes global.
    const unified = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room1 = await makeStampedRoom(unified.id);
    const manager = await import("../../src/engine/agent-manager.js");
    manager.persistRoomMemberConfigPatch(room1.id, unified.id, { mcpServers: ["playwright"] });
    let rec = reg.getMember(unified.id)!;
    expect(rec.global.mcpServers).toEqual(["playwright"]);
    expect(rec.scopeOverrides[`room:${room1.id}`]).toBeUndefined();
    expect(roomStore.getRoom(room1.id)!.memberOverrides).toBeUndefined();
    // Read side agrees (this was the invisible-write bug).
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room1.id, unified.id)?.mcpServers).toEqual(["playwright"]);

    // Batch-5b: scoped/mixed members also write global (flags ignored).
    const scoped = reg.createMember({
      name: "dev",
      agentTemplate: "pm",
      model: "testprov/claude-a",
      credentialId: cred.id,
      unifiedModel: false,
      unifiedExtensions: false,
    });
    const room2 = await makeStampedRoom(scoped.id);
    manager.persistRoomMemberConfigPatch(room2.id, scoped.id, { mcpServers: ["playwright"] });
    rec = reg.getMember(scoped.id)!;
    expect(rec.global.mcpServers).toEqual(["playwright"]);
    expect(rec.scopeOverrides[`room:${room2.id}`]).toBeUndefined();
  });

  it("clearing a model binding is retired: the module exports no clear path", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });

    const manager = await import("../../src/engine/agent-manager.js");
    expect((manager as any).clearMemberModelBinding).toBeUndefined();

    // A switch to the same binding is a no-op-safe full switch (still valid).
    await manager.switchMemberModel(member.id, { model: "testprov/claude-a", credentialId: cred.id });
    expect(reg.getMember(member.id)!.global.model).toBe("testprov/claude-a");
  });
});

describe("F4 heal consistency (no silent rollback after switch)", () => {
  let subscribeCb: ((event: any) => void) | undefined;
  let createAgentCalls: number;
  let setModelCalls: string[];

  const fakeRuntime = () => ({
    name: "pi-cli",
    createAgent: vi.fn(async () => {
      createAgentCalls += 1;
      return {
        prompt: vi.fn(async (message: string, options?: PromptOptions) => {
          dispatch(message, options);
          subscribeCb?.({ type: "agent_start" });
          subscribeCb?.({ type: "message_end", text: "done", stopReason: "stop" });
          subscribeCb?.({ type: "agent_end" });
        }),
        steer: vi.fn(),
        abort: vi.fn(),
        destroy: vi.fn(),
        async destroyAndWait() { this.abort(); await this.waitForIdle(); this.destroy(); },
        waitForIdle: vi.fn(async () => {}),
        subscribe: (fn: (event: any) => void) => {
          subscribeCb = fn;
          return () => {};
        },
        setModel: vi.fn((model: string) => {
          setModelCalls.push(model);
        }),
        refreshModelRegistry: vi.fn(async () => {}),
      };
    }),
  });

  beforeEach(async () => {
    fixture = coreFixture();
    dir = fixture.root;
    (await import("../../src/shared/config.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } });
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
    broadcastToRoom.mockClear();
    subscribeCb = undefined;
    createAgentCalls = 0;
    setModelCalls = [];

  });

  afterEach(async () => {
    await (await import("../../src/engine/agent-manager.js")).shutdownAll();
    fixture.close();
  });

  it("room: switch with live instance → persisted → re-activation does NOT roll the session back", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room = await makeStampedRoom(member.id);

    const manager = await import("../../src/engine/agent-manager.js");
    manager.initAgentManager({ get: () => fakeRuntime(), getAll: () => [] } as any);

    (await import("../../src/communication/message-bus.js")).postMessage(room.id, "user", "@pm check model", ["pm"]);
    await manager.activateAgent(room.id, member.id);
    expect(createAgentCalls).toBe(1);

    // fish's action: switch via the member card (single memberId path).
    await manager.switchMemberModel(member.id, { model: "testprov/claude-b", credentialId: cred.id });
    expect(setModelCalls).toEqual(["testprov/claude-b"]);

    // The rollback trigger: next activation heals against the registry.
    // Pre-fix the registry still said claude-a → heal "rolled the drift back".
    // Post-fix they agree — no setModel, no destroy/recreate.
    setModelCalls = [];
    (await import("../../src/communication/message-bus.js")).postMessage(room.id, "user", "@pm check model", ["pm"]);
    await manager.activateAgent(room.id, member.id);
    expect(setModelCalls).toEqual([]);
    expect(createAgentCalls).toBe(1);
  });

  it("§10: a direct config write does NOT touch a live DM instance — only switchMemberModel does", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });

    const manager = await import("../../src/engine/agent-manager.js");
    manager.initAgentManager({ get: () => fakeRuntime(), getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    expect(createAgentCalls).toBe(1);

    // A raw registry write bypasses the switch path — with activate-heal
    // removed (§10), a later activation must NOT reconcile it. The live
    // instance keeps running its applied model.
    reg.updateMember(member.id, { global: { model: "testprov/claude-b" } });
    await manager.activateDmMember(member.id);
    expect(setModelCalls).toEqual([]);
    expect(createAgentCalls).toBe(1);
    expect(reg.getEffectiveConfig(member.id, `dm:${member.id}`).model).toBe("testprov/claude-b");

    // The sanctioned path switches the live instance without recreating it.
    await manager.switchMemberModel(member.id, { model: "testprov/claude-b", credentialId: cred.id });
    expect(setModelCalls).toEqual(["testprov/claude-b"]);
    expect(createAgentCalls).toBe(1);
  });
});
