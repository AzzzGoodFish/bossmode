import type { coreFixture } from "../helpers/core-fixture.js";
/**
 * 0.20.0 flagship ① (fish 2026-08-05: "DM 里的 architect 对 bossmode dev 完全
 * 不了解"): the prompt promises "read any scope you belong to (optional scope
 * parameter on query tools)" — the implementation had no such parameter.
 * Permanent assertions: cross-scope reads work with membership checks
 * (explicit errors, never silent fallback), chat_list enumerates rooms+DM,
 * DM prompt scope injection lists real rooms, and the members config PATCH
 * route writes through the same unified-flag authority rule as F4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let fixture: ReturnType<typeof coreFixture>;
let dir: string;

vi.mock("../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

vi.mock("../../src/communication/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/ws.js")>();
  return { ...actual, broadcastToRoom: vi.fn(), broadcastToAgentSubscribers: vi.fn() };
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
  models: [{ id: "claude-a", contextWindow: 100000, maxTokens: 8000, input: ["text" as const] }],
};

/** Member "dev" belongs to roomA + roomB; "outsider" belongs to roomC only. */
async function seedWorld() {
  const reg = await import("../../src/member/member-registry.js");
  const creds = await import("../../src/engine/model-credentials.js");
  const cred = creds.saveModelCredentialProfile(PROFILE);
  const dev = reg.createMember({ name: "dev", agentTemplate: "dev", model: "testprov/claude-a", credentialId: cred.id });
  const outsider = reg.createMember({ name: "outsider", agentTemplate: "dev", model: "testprov/claude-a", credentialId: cred.id });
  const roomStore = await import("../../src/chat/room-store.js");
  const roomA = roomStore.createRoom("alpha", undefined, []);
  roomStore.stampGlobalMemberIds(roomA.id, [dev.id], dev.id);
  const roomB = roomStore.createRoom("beta", undefined, []);
  roomStore.stampGlobalMemberIds(roomB.id, [dev.id], dev.id);
  const roomC = roomStore.createRoom("gamma", undefined, []);
  roomStore.stampGlobalMemberIds(roomC.id, [outsider.id], outsider.id);
  return { dev, outsider, roomA, roomB, roomC };
}

describe("cross-scope reads (flagship ①)", () => {
  beforeEach(async () => {
    vi.resetModules();
    fixture = (await import("../helpers/core-fixture.js")).coreFixture();
    dir = fixture.root;
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
  });

  afterEach(() => {
    fixture.close();
  });

  it("chat_read: chat param reads another member-room; violations are explicit errors", async () => {
    const { dev, roomA, roomB, roomC } = await seedWorld();
    const messageStore = await import("../../src/chat/message-store.js");
    messageStore.addMessage(roomA.id, { sender: "dev", mentions: [], content: "alpha-only discussion" });
    messageStore.addMessage(roomB.id, { sender: "pm", mentions: [], content: "beta decision: ship it" });
    messageStore.addMessage(roomB.id, { sender: "system", mentions: [], content: "[Member failure notice] hidden" });

    const tools = await import("../../src/engine/tools.js");
    // Cross-scope read from roomA into roomB.
    const res = (await tools.handleToolCallback("chat_read", roomA.id, "dev", { chat: `room:${roomB.id}` }, { memberId: dev.id })) as any[];
    expect(Array.isArray(res)).toBe(true);
    expect(res.map((m) => m.content)).toEqual(["beta decision: ship it"]); // system notice filtered

    // Default (no scope) = current scope, unchanged.
    const cur = (await tools.handleToolCallback("chat_read", roomA.id, "dev", {}, { memberId: dev.id })) as any[];
    expect(cur.map((m) => m.content)).toEqual(["alpha-only discussion"]);

    // Not a member of roomC → explicit error, no silent fallback.
    const denied = (await tools.handleToolCallback("chat_read", roomA.id, "dev", { chat: `room:${roomC.id}` }, { memberId: dev.id })) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/not a member/);

    // Nonexistent room → explicit error.
    const missing = (await tools.handleToolCallback("chat_read", roomA.id, "dev", { chat: "room:nope" }, { memberId: dev.id })) as any;
    expect(missing.ok).toBe(false);

    // Another member's DM → explicit error.
    const dmDenied = (await tools.handleToolCallback("chat_read", roomA.id, "dev", { chat: "dm:mem_other" }, { memberId: dev.id })) as any;
    expect(dmDenied.ok).toBe(false);
    expect(dmDenied.error).toMatch(/own DM/);
  });

  it("chat_read: own DM scope is readable from room and from DM (member-owned store)", async () => {
    const { dev, roomA } = await seedWorld();
    const dmStore = await import("../../src/chat/dm-message-store.js");
    dmStore.addDmMessage(dev.id, { sender: "user", mentions: [], content: "private beta question" });
    dmStore.addDmMessage(dev.id, { sender: "dev", mentions: [], content: "private answer" });

    const tools = await import("../../src/engine/tools.js");
    const fromRoom = (await tools.handleToolCallback("chat_read", roomA.id, "dev", { chat: `dm:${dev.id}` }, { memberId: dev.id })) as any[];
    expect(fromRoom.map((m) => m.content)).toEqual(["private beta question", "private answer"]);

    // From inside the DM scope itself: default reads the DM; chat_search filters by text.
    const fromDm = (await tools.handleToolCallback("chat_search", `dm:${dev.id}`, "dev", { chat: `dm:${dev.id}`, query: "question" }, { memberId: dev.id })) as any[];
    expect(fromDm.map((m) => m.content)).toEqual(["private beta question"]);
  });

  it("retired task tools are gone from the member surface", async () => {
    const { dev, roomA } = await seedWorld();
    const tools = await import("../../src/engine/tools.js");
    for (const tool of ["list_tasks", "get_task", "create_task", "update_task", "comment_task"]) {
      await expect(tools.handleToolCallback(tool, roomA.id, "dev", {}, { memberId: dev.id }))
        .rejects.toThrow(/Unknown tool/);
    }
  });

  it("supported query tools reject retired target_scope without silent fallback", async () => {
    const { dev, roomA } = await seedWorld();
    const tools = await import("../../src/engine/tools.js");
    // Retired target_scope on chat_read (QA's silent-fallback trap).
    const q = (await tools.handleToolCallback("chat_read", roomA.id, "dev", { target_scope: `room:${roomA.id}` }, { memberId: dev.id })) as any;
    expect(Array.isArray(q)).toBe(false);
    expect(q.ok).toBe(false);
    expect(q.error).toMatch(/unknown parameter 'target_scope'/);
  });

  it("chat_list: rooms (id+name) + own DM; excludes non-member rooms", async () => {
    const { dev, roomA, roomB, roomC } = await seedWorld();
    const tools = await import("../../src/engine/tools.js");
    const res = (await tools.handleToolCallback("chat_list", roomA.id, "dev", {}, { memberId: dev.id })) as any;
    expect(res.ok).toBe(true);
    const scopes = res.chats.map((s: any) => s.id);
    expect(scopes).toContain(`room:${roomA.id}`);
    expect(scopes).toContain(`room:${roomB.id}`);
    expect(scopes).toContain(`dm:${dev.id}`);
    expect(scopes).not.toContain(`room:${roomC.id}`);
    const names = res.chats.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("DM prompt scope injection lists real rooms (was [scopeId] only — room-blind)", async () => {
    const { dev, roomA, roomB } = await seedWorld();
    const manager = await import("../../src/engine/agent-manager.js");
    const labels = manager.buildDmScopeLabels(dev.id, `dm:${dev.id}`);
    expect(labels.some((l) => l.includes("alpha") && l.includes(`room:${roomA.id}`))).toBe(true);
    expect(labels.some((l) => l.includes("beta") && l.includes(`room:${roomB.id}`))).toBe(true);
    expect(labels.some((l) => l.includes("this DM"))).toBe(true);
  });

  it("members config PATCH write path: batch-5b writes global on any scope", async () => {
    const { dev, roomA } = await seedWorld();
    const reg = await import("../../src/member/member-registry.js");

    // Unified member patched at DM scope → global write, no scope override.
    reg.applyMemberConfigPatch(dev.id, `dm:${dev.id}`, { thinkingLevel: "high" });
    let rec = reg.getMember(dev.id)!;
    expect(rec.global.thinkingLevel).toBe("high");
    expect(rec.scopeOverrides[`dm:${dev.id}`]).toBeUndefined();

    // Scoped-flag member (disk says false) patched at DM scope → still global.
    const scoped = reg.createMember({
      name: "scoped",
      agentTemplate: "dev",
      model: "testprov/claude-a",
      credentialId: rec.global.credentialId,
      unifiedModel: false,
    });
    reg.applyMemberConfigPatch(scoped.id, `dm:${scoped.id}`, { thinkingLevel: "low" });
    rec = reg.getMember(scoped.id)!;
    expect(rec.global.thinkingLevel).toBe("low");
    expect(rec.scopeOverrides[`dm:${scoped.id}`]).toBeUndefined();

    // Room scope same story: global write, no memberOverrides residue.
    const roomStore = await import("../../src/chat/room-store.js");
    const room2 = roomStore.createRoom("delta", undefined, []);
    roomStore.stampGlobalMemberIds(room2.id, [scoped.id], scoped.id);
    reg.applyMemberConfigPatch(scoped.id, `room:${room2.id}`, { thinkingLevel: "max" });
    rec = reg.getMember(scoped.id)!;
    expect(rec.global.thinkingLevel).toBe("max");
    expect(rec.scopeOverrides[`room:${room2.id}`]).toBeUndefined();
    expect(roomStore.getRoom(room2.id)!.memberOverrides).toBeUndefined();
    expect(reg.getEffectiveConfig(scoped.id, `room:${roomA.id}`)).toBeDefined();
  });
});
