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
    await manager.switchMemberModel(room.id, member.id, "testprov/claude-b", cred.id);

    // New authority updated.
    expect(reg.getMember(member.id)!.global.model).toBe("testprov/claude-b");
    // Old authority NOT written.
    const roomStore = await import("../../src/workspace/room-store.js");
    expect(roomStore.getRoom(room.id)!.memberOverrides).toBeUndefined();
    // Read side (display / heal) resolves the new model.
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room.id, member.id)?.model).toBe("testprov/claude-b");
  });

  it("unifiedModel=false: switch writes this room's scope override; global untouched", async () => {
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
    await manager.switchMemberModel(room.id, member.id, "testprov/claude-b", cred.id);

    const rec = reg.getMember(member.id)!;
    expect(rec.global.model).toBe("testprov/claude-a");
    expect(rec.scopeOverrides[`room:${room.id}`]?.model).toBe("testprov/claude-b");
    expect(reg.getEffectiveConfig(member.id, `room:${room.id}`).model).toBe("testprov/claude-b");
    // Other scopes still see the global.
    expect(reg.getEffectiveConfig(member.id, "room:other").model).toBe("testprov/claude-a");
  });

  it("non-model patch (thinking/mcp/extensions) routes by the same unified flags", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const roomStore = await import("../../src/workspace/room-store.js");

    // Fully unified member: everything goes global.
    const unified = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room1 = await makeStampedRoom(unified.id);
    const manager = await import("../../src/engine/agent-manager.js");
    manager.persistRoomMemberConfigPatch(room1.id, unified.id, { thinkingLevel: "high", mcpServers: ["playwright"], extensions: ["ext-x"] });
    let rec = reg.getMember(unified.id)!;
    expect(rec.global.thinkingLevel).toBe("high");
    expect(rec.global.mcpServers).toEqual(["playwright"]);
    expect(rec.scopeOverrides[`room:${room1.id}`]).toBeUndefined();
    expect(roomStore.getRoom(room1.id)!.memberOverrides).toBeUndefined();
    // Read side agrees (this was the invisible-write bug).
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room1.id, unified.id)?.thinkingLevel).toBe("high");

    // Fully scoped member: everything goes to this room's scope override.
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
    expect(rec.global.thinkingLevel).toBeNull();
    expect(rec.scopeOverrides[`room:${room2.id}`]?.thinkingLevel).toBe("low");
    expect(rec.scopeOverrides[`room:${room2.id}`]?.mcpServers).toEqual(["playwright"]);

    // Mixed flags: thinking (unifiedModel) global, mcp (unifiedExtensions) scope.
    const mixed = reg.createMember({
      name: "qa",
      agentTemplate: "pm",
      model: "testprov/claude-a",
      credentialId: cred.id,
      unifiedModel: true,
      unifiedExtensions: false,
    });
    const room3 = await makeStampedRoom(mixed.id, "qa");
    manager.persistRoomMemberConfigPatch(room3.id, mixed.id, { thinkingLevel: "max", mcpServers: ["playwright"] });
    rec = reg.getMember(mixed.id)!;
    expect(rec.global.thinkingLevel).toBe("max");
    expect(rec.scopeOverrides[`room:${room3.id}`]?.mcpServers).toEqual(["playwright"]);
    expect(rec.scopeOverrides[`room:${room3.id}`]?.thinkingLevel).toBeUndefined();
  });

  it("clearMemberModelBinding clears on the same authority", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const unified = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const room = await makeStampedRoom(unified.id);

    const manager = await import("../../src/engine/agent-manager.js");
    manager.clearMemberModelBinding(room.id, unified.id);
    expect(reg.getMember(unified.id)!.global.model).toBeNull();

    const scoped = reg.createMember({
      name: "dev",
      agentTemplate: "pm",
      model: "testprov/claude-a",
      credentialId: cred.id,
      unifiedModel: false,
    });
    reg.patchScopeOverride(scoped.id, `room:${room.id}`, { model: "testprov/claude-b" });
    manager.clearMemberModelBinding(room.id, scoped.id);
    expect(reg.getMember(scoped.id)!.scopeOverrides[`room:${room.id}`]?.model ?? null).toBeNull();
    expect(reg.getMember(scoped.id)!.global.model).toBe("testprov/claude-a");
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

    // fish's action: switch via the room member card.
    await manager.switchMemberModel(room.id, member.id, "testprov/claude-b", cred.id);
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
