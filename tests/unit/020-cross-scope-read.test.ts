/**
 * 0.20.0 flagship ① (fish 2026-08-05: "DM 里的 architect 对 bossmode dev 完全
 * 不了解"): the prompt promises "read any scope you belong to (optional scope
 * parameter on query tools)" — the implementation had no such parameter.
 * Permanent assertions: cross-scope reads work with membership checks
 * (explicit errors, never silent fallback), list_scopes enumerates rooms+DM,
 * DM prompt scope injection lists real rooms, and the members config PATCH
 * route writes through the same unified-flag authority rule as F4.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

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
  return { ...actual, broadcastToRoom: vi.fn(), broadcastToAgentSubscribers: vi.fn() };
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
  models: [{ id: "claude-a", contextWindow: 100000, maxTokens: 8000, input: ["text" as const] }],
};

/** Member "dev" belongs to roomA + roomB; "outsider" belongs to roomC only. */
async function seedWorld() {
  const reg = await import("../../src/workspace/member-registry.js");
  const creds = await import("../../src/engine/model-credentials.js");
  const cred = creds.saveModelCredentialProfile(PROFILE);
  const dev = reg.createMember({ name: "dev", agentTemplate: "dev", model: "testprov/claude-a", credentialId: cred.id });
  const outsider = reg.createMember({ name: "outsider", agentTemplate: "dev", model: "testprov/claude-a", credentialId: cred.id });
  const roomStore = await import("../../src/workspace/room-store.js");
  const roomA = roomStore.createRoom("alpha", dir, [{ agent: "dev", name: "dev" }], undefined);
  roomStore.stampGlobalMemberIds(roomA.id, [dev.id], dev.id);
  const roomB = roomStore.createRoom("beta", dir, [{ agent: "dev", name: "dev" }], undefined);
  roomStore.stampGlobalMemberIds(roomB.id, [dev.id], dev.id);
  const roomC = roomStore.createRoom("gamma", dir, [{ agent: "dev", name: "outsider" }], undefined);
  roomStore.stampGlobalMemberIds(roomC.id, [outsider.id], outsider.id);
  return { dev, outsider, roomA, roomB, roomC };
}

describe("cross-scope reads (flagship ①)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-xs-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "knowledge", "docs"), { recursive: true });
    seedAgent("dev");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("query_room_messages: scope param reads another member-room; violations are explicit errors", async () => {
    const { dev, roomA, roomB, roomC } = await seedWorld();
    const messageStore = await import("../../src/workspace/message-store.js");
    messageStore.addMessage(roomA.id, { sender: "dev", content: "alpha-only discussion", seq: 1 });
    messageStore.addMessage(roomB.id, { sender: "pm", content: "beta decision: ship it", seq: 1 });
    messageStore.addMessage(roomB.id, { sender: "system", content: "[Member failure notice] hidden", seq: 2 });

    const tools = await import("../../src/engine/tools.js");
    // Cross-scope read from roomA into roomB.
    const res = (await tools.handleToolCallback("query_room_messages", roomA.id, "dev", { scope: `room:${roomB.id}` })) as any[];
    expect(Array.isArray(res)).toBe(true);
    expect(res.map((m) => m.content)).toEqual(["beta decision: ship it"]); // system notice filtered

    // Default (no scope) = current scope, unchanged.
    const cur = (await tools.handleToolCallback("query_room_messages", roomA.id, "dev", {})) as any[];
    expect(cur.map((m) => m.content)).toEqual(["alpha-only discussion"]);

    // Not a member of roomC → explicit error, no silent fallback.
    const denied = (await tools.handleToolCallback("query_room_messages", roomA.id, "dev", { scope: `room:${roomC.id}` })) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/not a member/);

    // Nonexistent room → explicit error.
    const missing = (await tools.handleToolCallback("query_room_messages", roomA.id, "dev", { scope: "room:nope" })) as any;
    expect(missing.ok).toBe(false);

    // Another member's DM → explicit error.
    const dmDenied = (await tools.handleToolCallback("query_room_messages", roomA.id, "dev", { scope: "dm:mem_other" })) as any;
    expect(dmDenied.ok).toBe(false);
    expect(dmDenied.error).toMatch(/own DM/);
  });

  it("query_room_messages: own DM scope is readable from room and from DM (member-owned store)", async () => {
    const { dev, roomA } = await seedWorld();
    const dmStore = await import("../../src/workspace/dm-message-store.js");
    dmStore.addDmMessage(dev.id, { sender: "user", content: "private beta question" });
    dmStore.addDmMessage(dev.id, { sender: "dev", content: "private answer" });

    const tools = await import("../../src/engine/tools.js");
    const fromRoom = (await tools.handleToolCallback("query_room_messages", roomA.id, "dev", { scope: `dm:${dev.id}` })) as any[];
    expect(fromRoom.map((m) => m.content)).toEqual(["private beta question", "private answer"]);

    // From inside the DM scope itself: default reads the DM; query filter works.
    const fromDm = (await tools.handleToolCallback("query_room_messages", `dm:${dev.id}`, "dev", { query: "question" })) as any[];
    expect(fromDm.map((m) => m.content)).toEqual(["private beta question"]);
  });

  it("list_tasks / get_task: cross-room read works; DM scope rejected explicitly", async () => {
    const { dev, roomA, roomB } = await seedWorld();
    const taskStore = await import("../../src/workspace/task-store.js");
    taskStore.createTask(roomB.id, { title: "beta task", createdBy: "pm" });

    const tools = await import("../../src/engine/tools.js");
    const tasks = (await tools.handleToolCallback("list_tasks", roomA.id, "dev", { scope: `room:${roomB.id}` })) as any[];
    expect(tasks.map((t) => t.title)).toEqual(["beta task"]);

    const detail = (await tools.handleToolCallback("get_task", roomA.id, "dev", { scope: `room:${roomB.id}`, taskId: tasks[0].id })) as string;
    expect(detail).toContain("beta task");

    const dmTasks = (await tools.handleToolCallback("list_tasks", roomA.id, "dev", { scope: `dm:${dev.id}` })) as any;
    expect(dmTasks.ok).toBe(false);
    expect(dmTasks.error).toMatch(/room-scoped/);
  });

  it("read_memory: target_scope reads own member memory and room principles at another scope", async () => {
    const { dev, roomA, roomB, roomC } = await seedWorld();
    const memStore = await import("../../src/workspace/member-memory-store.js");
    memStore.writeMemoryLayer(dev.id, "principles", "beta-scope rules", { type: "member", memberId: dev.id, name: "dev" }, { scopeId: `room:${roomB.id}`, reason: "test", operation: "write" });
    const principlesStore = await import("../../src/workspace/principles-store.js");
    principlesStore.writePrinciples({ roomId: roomB.id, scope: "room", content: "beta room principles", actor: { type: "member", memberId: dev.id, name: "dev" }, reason: "test" });

    const tools = await import("../../src/engine/tools.js");
    // Member principles at room:B scope, read from roomA.
    const res = (await tools.handleToolCallback("read_memory", roomA.id, "dev", { asset: "principles", target_scope: `room:${roomB.id}` })) as any;
    expect(res.ok).toBe(true);
    expect(res.content).toBe("beta-scope rules");

    // Room principles of roomB from roomA.
    const rp = (await tools.handleToolCallback("read_memory", roomA.id, "dev", { asset: "principles", scope: "room", target_scope: `room:${roomB.id}` })) as any;
    expect(rp.ok).toBe(true);
    expect(rp.content).toBe("beta room principles");

    // Unauthorized target scope → explicit error.
    const denied = (await tools.handleToolCallback("read_memory", roomA.id, "dev", { asset: "principles", target_scope: `room:${roomC.id}` })) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/not a member/);

    // Default remains current scope.
    const cur = (await tools.handleToolCallback("read_memory", roomA.id, "dev", { asset: "principles" })) as any;
    expect(cur.ok).toBe(true);
    expect(cur.content).not.toBe("beta-scope rules");
  });

  it("list_scopes: rooms (id+name) + own DM; excludes non-member rooms", async () => {
    const { dev, roomA, roomB, roomC } = await seedWorld();
    const tools = await import("../../src/engine/tools.js");
    const res = (await tools.handleToolCallback("list_scopes", roomA.id, "dev", {})) as any;
    expect(res.ok).toBe(true);
    const scopes = res.scopes.map((s: any) => s.scope);
    expect(scopes).toContain(`room:${roomA.id}`);
    expect(scopes).toContain(`room:${roomB.id}`);
    expect(scopes).toContain(`dm:${dev.id}`);
    expect(scopes).not.toContain(`room:${roomC.id}`);
    const names = res.scopes.map((s: any) => s.name);
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

  it("members config PATCH write path: persistMemberConfigPatch routes by unified flags on any scope", async () => {
    const { dev, roomA } = await seedWorld();
    const reg = await import("../../src/workspace/member-registry.js");
    const manager = await import("../../src/engine/agent-manager.js");

    // Unified member patched at DM scope → global write, no scope override.
    manager.persistMemberConfigPatch(`dm:${dev.id}`, dev.id, { thinkingLevel: "high" });
    let rec = reg.getMember(dev.id)!;
    expect(rec.global.thinkingLevel).toBe("high");
    expect(rec.scopeOverrides[`dm:${dev.id}`]).toBeUndefined();

    // Scoped member (unifiedModel=false) patched at DM scope → dm: scope override.
    const scoped = reg.createMember({
      name: "scoped",
      agentTemplate: "dev",
      model: "testprov/claude-a",
      credentialId: rec.global.credentialId,
      unifiedModel: false,
    });
    manager.persistMemberConfigPatch(`dm:${scoped.id}`, scoped.id, { thinkingLevel: "low" });
    rec = reg.getMember(scoped.id)!;
    expect(rec.global.thinkingLevel).toBeNull();
    expect(rec.scopeOverrides[`dm:${scoped.id}`]?.thinkingLevel).toBe("low");

    // Room scope delegates to the F4 path (scope override for scoped member).
    const roomStore = await import("../../src/workspace/room-store.js");
    const room2 = roomStore.createRoom("delta", dir, [{ agent: "dev", name: "scoped" }], undefined);
    roomStore.stampGlobalMemberIds(room2.id, [scoped.id], scoped.id);
    manager.persistMemberConfigPatch(`room:${room2.id}`, scoped.id, { thinkingLevel: "max" });
    rec = reg.getMember(scoped.id)!;
    expect(rec.scopeOverrides[`room:${room2.id}`]?.thinkingLevel).toBe("max");
    expect(roomStore.getRoom(room2.id)!.memberOverrides).toBeUndefined();
    expect(reg.getEffectiveConfig(scoped.id, `room:${roomA.id}`)).toBeDefined();
  });
});
