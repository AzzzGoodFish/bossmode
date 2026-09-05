/**
 * F4 (2026-08-04, fish live report): model switch must persist to the 0.20
 * authority (member registry), not room.json memberOverrides — otherwise
 * display shows the old model and activate-heal silently rolls the session
 * back. Permanent assertions:
 *   switch → registry updated (global for unifiedModel=true, scope override
 *   for false) → memberOverrides untouched → re-activation does NOT roll the
 *   live session back.
 * F3 same batch: DM activation heals a drifted live instance (room parity).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

const broadcastToRoom = vi.fn();

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

vi.mock("../../src/communication/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/ws.js")>();
  return {
    ...actual,
    broadcastToRoom: (...args: unknown[]) => broadcastToRoom(...args),
    broadcastToAgentSubscribers: vi.fn(),
  };
});

function seedAgent(name: string) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n---\n\nYou are ${name}.\n`, "utf-8");
}

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

async function makeStampedRoom(memberId: string, memberName = "pm") {
  const roomStore = await import("../../src/workspace/room-store.js");
  const room = roomStore.createRoom("R", dir, [{ agent: memberName, name: memberName }], undefined);
  roomStore.stampGlobalMemberIds(room.id, [memberId], memberId);
  return room;
}

describe("F4 model binding persists to the registry", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-f4-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
    seedAgent("pm");
    seedAgent("dev");
    seedAgent("qa");
    broadcastToRoom.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("unifiedModel=true: switch writes the global binding; memberOverrides untouched; read side agrees", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room = await makeStampedRoom(member.id);

    const manager = await import("../../src/engine/agent-manager.js");
    await manager.switchMemberModel(member.id, { model: "testprov/claude-b", credentialId: cred.id });

    // New authority updated.
    expect(reg.getMember(member.id)!.global.model).toBe("testprov/claude-b");
    // Old authority NOT written.
    const roomStore = await import("../../src/workspace/room-store.js");
    expect(roomStore.getRoom(room.id)!.memberOverrides).toBeUndefined();
    // Read side (display / heal) resolves the new model.
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room.id, member.id)?.model).toBe("testprov/claude-b");
  });

  it("batch-5b: switch always writes global even when the disk flag says scoped", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
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

  it("non-model patch (thinking/mcp) routes by the same unified flags", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const roomStore = await import("../../src/workspace/room-store.js");

    // Fully unified member: everything goes global.
    const unified = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room1 = await makeStampedRoom(unified.id);
    const manager = await import("../../src/engine/agent-manager.js");
    manager.persistRoomMemberConfigPatch(room1.id, unified.id, { thinkingLevel: "high", mcpServers: ["playwright"] });
    let rec = reg.getMember(unified.id)!;
    expect(rec.global.thinkingLevel).toBe("high");
    expect(rec.global.mcpServers).toEqual(["playwright"]);
    expect(rec.scopeOverrides[`room:${room1.id}`]).toBeUndefined();
    expect(roomStore.getRoom(room1.id)!.memberOverrides).toBeUndefined();
    // Read side agrees (this was the invisible-write bug).
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room1.id, unified.id)?.thinkingLevel).toBe("high");

    // Batch-5b: scoped/mixed members also write global (flags ignored).
    const scoped = reg.createMember({
      name: "dev",
      agentTemplate: "pm",
      model: "testprov/claude-a",
      credentialId: cred.id,
      unifiedModel: false,
      unifiedExtensions: false,
    });
    const room2 = await makeStampedRoom(scoped.id, "dev");
    manager.persistRoomMemberConfigPatch(room2.id, scoped.id, { thinkingLevel: "low", mcpServers: ["playwright"] });
    rec = reg.getMember(scoped.id)!;
    expect(rec.global.thinkingLevel).toBe("low");
    expect(rec.global.mcpServers).toEqual(["playwright"]);
    expect(rec.scopeOverrides[`room:${room2.id}`]).toBeUndefined();
  });

  it("clearing a model binding is retired: the module exports no clear path", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
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
        prompt: vi.fn(async () => {
          subscribeCb?.({ type: "agent_start" });
          subscribeCb?.({ type: "message_end", text: "done", stopReason: "stop" });
          subscribeCb?.({ type: "agent_end" });
        }),
        steer: vi.fn(),
        abort: vi.fn(),
        destroy: vi.fn(),
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-f4heal-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
    seedAgent("pm");
    broadcastToRoom.mockClear();
    subscribeCb = undefined;
    createAgentCalls = 0;
    setModelCalls = [];
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("room: switch with live instance → persisted → re-activation does NOT roll the session back", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room = await makeStampedRoom(member.id);

    const manager = await import("../../src/engine/agent-manager.js");
    manager.initAgentManager({ get: () => fakeRuntime(), getAll: () => [] } as any);

    await manager.activateAgent(room.id, member.id);
    expect(createAgentCalls).toBe(1);

    // fish's action: switch via the member card (single memberId path).
    await manager.switchMemberModel(member.id, { model: "testprov/claude-b", credentialId: cred.id });
    expect(setModelCalls).toEqual(["testprov/claude-b"]);

    // The rollback trigger: next activation heals against the registry.
    // Pre-fix the registry still said claude-a → heal "rolled the drift back".
    // Post-fix they agree — no setModel, no destroy/recreate.
    setModelCalls = [];
    await manager.activateAgent(room.id, member.id);
    expect(setModelCalls).toEqual([]);
    expect(createAgentCalls).toBe(1);
  });

  it("F3: DM live config change heals the drifted DM instance (setModel, no recreate)", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });

    const manager = await import("../../src/engine/agent-manager.js");
    manager.initAgentManager({ get: () => fakeRuntime(), getAll: () => [] } as any);

    await manager.activateDmMember(member.id);
    expect(createAgentCalls).toBe(1);

    // Config changes while the DM instance is alive (e.g. member settings page).
    reg.updateMember(member.id, { global: { model: "testprov/claude-b" } });

    await manager.activateDmMember(member.id);
    expect(setModelCalls).toEqual(["testprov/claude-b"]);
    expect(createAgentCalls).toBe(1); // healed in place, not recreated
    expect(reg.getEffectiveConfig(member.id, `dm:${member.id}`).model).toBe("testprov/claude-b");
  });
});
