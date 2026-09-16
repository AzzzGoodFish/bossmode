import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createMember, updateMember } from "../../src/member/member-registry.js";
import { roomDir } from "../../src/files/layout.js";

import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
import { importHistoricalAgentTemplate } from "../helpers/historical-agent-template.js";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
beforeEach(() => { fixture = coreFixture(); dir = fixture.root; });
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });
function writeAgent(name: string, extraFrontmatter = ""): void {
  importHistoricalAgentTemplate(fixture, name, `---\nname: ${name}\n${extraFrontmatter}---\n${name} prompt\n`);
}
describe("room-member-resolver — no implicit model default", () => {
  it("leaves a freshly created current contact Unconfigured (no model, no credentialId)", async () => {
    const member = createMember({ name: "architect" });
    const roomStore = await import("../../src/chat/room-store.js");
    const { resolveRoomMember } = await import("../../src/member/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, [member.id]);
    const resolved = resolveRoomMember(room.id, "architect");

    expect(resolved).not.toBeNull();
    expect(resolved?.model).toBeUndefined();
    expect(resolved?.credentialId).toBeUndefined();
  });

  it("ignores a legacy model field in Agent definition frontmatter", async () => {
    writeAgent("pm", "model: claude-sonnet-4-6\n");
    const member = createMember({ name: "pm", agentTemplate: "pm" });
    const roomStore = await import("../../src/chat/room-store.js");
    const { resolveRoomMember } = await import("../../src/member/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, [member.id]);
    const resolved = resolveRoomMember(room.id, "pm");

    expect(resolved).not.toBeNull();
    expect(resolved?.model).toBeUndefined();
  });

  it("retains imported legacy model history without making an unlinked snapshot executable", async () => {
    const roomStore = await import("../../src/chat/room-store.js");
    const { resolveRoomMember } = await import("../../src/member/room-member-resolver.js");
    // The retired historical converter's SQL DTO, constructed directly: a retained
    // legacy model history (never executable) that resolution must not activate.
    const room = {
      id: "legacy-room", name: "Legacy", members: ["developer"], createdAt: 1,
      roomMembers: [{
        id: "legacy-developer", roomId: "legacy-room", name: "developer",
        sourceAgent: "developer", sourceMemberId: "legacy-developer",
        config: { model: "claude-sonnet-4-6", thinkingLevel: "off" },
        createdAt: 1, updatedAt: 1,
        migratedFrom: { memberName: "developer", memberId: "legacy-developer" },
      }],
    };
    new ConversationsRepository(fixture.db).upsertRoom(room as any);
    mkdirSync(join(dir,"rooms/legacy-room"),{recursive:true});
    writeFileSync(join(dir,"members.json"),"invalid retired data");
    writeFileSync(join(dir,"rooms/legacy-room/room.json"),"invalid retired room");

    const resolved = resolveRoomMember(room.id, "developer");
    expect(roomStore.getRoomMemberOverride(room.id, "developer")).toMatchObject({ model: "claude-sonnet-4-6" });
    expect(roomStore.getRoomMemberOverride(room.id, "developer")?.credentialId).toBeUndefined();
    expect(resolved).toBeNull();
  });

  it("resolves an explicitly configured member's model and credentialId together", async () => {
    const member = createMember({ name: "qa" });
    const roomStore = await import("../../src/chat/room-store.js");
    const { resolveRoomMember } = await import("../../src/member/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, [member.id]);
    updateMember(member.id, { global: { model: "anthropic/claude-opus-4-6", credentialId: "cred-x" } });

    const resolved = resolveRoomMember(room.id, "qa");
    expect(resolved?.model).toBe("anthropic/claude-opus-4-6");
    expect(resolved?.credentialId).toBe("cred-x");
  });
});

async function currentMemberFixture() {
  const registry = await import("../../src/member/member-registry.js");
  const db = fixture.db;
  const member = registry.importMemberRecord({
    id: "mem_current", name: "current-name", title: "Engineer", agentTemplate: "developer",
    unifiedModel: true, unifiedExtensions: true, scopeOverrides: {},
    global: { model: "db-model", credentialId: "db-credential", thinkingLevel: "high", skills: ["db-skill"], mcpServers: ["db-mcp"] },
    createdAt: 1, updatedAt: 2,
  });
  const roomStore = await import("../../src/chat/room-store.js");
  const room = roomStore.createRoom("Current", dir, []);
  // A pre-cutover linked shadow must not supply identity or cleared settings.
  const shadow = {
    id: "rm_shadow", roomId: room.id, name: "stale-name", sourceAgent: "stale-agent",
    sourceMemberId: member.id, createdAt: 1, updatedAt: 1,
    config: { model: "shadow-model", credentialId: "shadow-credential", thinkingLevel: "high", skills: ["shadow-skill"], mcpServers: ["shadow-mcp"], contextLimit: 99 },
  };
  const path = join(roomDir(room.id), "room.json");
  // createRoom now always sets a global roster, even when empty. This fixture
  // represents a pre-cutover local roster with an explicit current-member link.
  new ConversationsRepository(db).upsertRoom({ ...room, globalMemberIds: undefined, roomMembers: [shadow] });
  writeFileSync(path, "poison retired room");
  return { registry, member, roomStore, room, path, shadow, db };
}

describe("room-member-resolver — database authority", () => {
  it("uses DB identity and config for a linked current member, including cleared settings", async () => {
    const { registry, member, roomStore, room } = await currentMemberFixture();
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/member/room-member-resolver.js");
    expect(resolveRoomMember(room.id, "rm_shadow")).toMatchObject({
      id: member.id, name: member.name, title: "Engineer", agent: "developer",
      model: "db-model", credentialId: "db-credential", thinkingLevel: "high",
      skills: ["db-skill"], mcpServers: ["db-mcp"],
    });
    registry.updateMember(member.id, { global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] } });
    registry.updateMemberIdentity(member.id, { title: null });
    expect(resolveRoomMembers(room.id)).toMatchObject([{
      id: member.id, model: undefined, credentialId: undefined, thinkingLevel: "off",
      skills: [], mcpServers: [],
    }]);
    expect(resolveRoomMember(room.id, "rm_shadow")?.contextLimit).toBeUndefined();
    expect(resolveRoomMember(room.id, "rm_shadow")?.title).toBeUndefined();
    expect(roomStore.getRoomMemberOverride(room.id, "stale-name")).toBeUndefined();
  });

  it("uses DB records for global membership and ignores old files and room shadows", async () => {
    const { member, room, path, shadow } = await currentMemberFixture();
    writeFileSync(join(dir, "members.json"), "invalid retired data");
    new ConversationsRepository(fixture.db).upsertRoom({ ...room, globalMemberIds: [member.id], roomMembers: [shadow] });
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/member/room-member-resolver.js");
    expect(resolveRoomMember(room.id, member.id)).toMatchObject({ id: member.id, name: "current-name", model: "db-model" });
    expect(resolveRoomMembers(room.id)).toHaveLength(1);
  });

  it("propagates effective-config read failures instead of using shadow config", async () => {
    const { registry, room } = await currentMemberFixture();
    vi.spyOn(registry, "getEffectiveConfig").mockImplementation(() => { throw new Error("DB config read failed"); });
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/member/room-member-resolver.js");
    expect(() => resolveRoomMember(room.id, "rm_shadow")).toThrow("DB config read failed");
    expect(() => resolveRoomMembers(room.id)).toThrow("DB config read failed");
  });

  it("does not revive a linked member missing from the DB", async () => {
    const { registry, member, room } = await currentMemberFixture();
    registry.deleteMemberForTests(member.id);
    const { resolveRoomMember } = await import("../../src/member/room-member-resolver.js");
    expect(() => resolveRoomMember(room.id, "rm_shadow")).toThrow("Member not found");
  });

  it("does not resolve a missing global member through a same-named agent or stale overrides", async () => {
    const { registry, member, room, path } = await currentMemberFixture();
    writeAgent(member.name);
    new ConversationsRepository(fixture.db).upsertRoom({ ...room, globalMemberIds: [member.id], memberOverrides: { [member.name]: { model: "stale-model" } } });
    registry.deleteMemberForTests(member.id);
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/member/room-member-resolver.js");
    expect(resolveRoomMember(room.id, member.name)).toBeNull();
    expect(resolveRoomMembers(room.id, [member.name])).toEqual([]);
  });

  it("propagates corrupt DB configuration for global membership", async () => {
    const { member, room, path, shadow, db } = await currentMemberFixture();
    new ConversationsRepository(fixture.db).upsertRoom({ ...room, globalMemberIds: [member.id], roomMembers: [shadow] });
    expect(() => db.run("UPDATE members SET global_json = ? WHERE id = ?", "invalid JSON", member.id)).toThrow();
    // Corruption cannot pass current SQL constraints. Inject a corrupt returned row
    // to independently exercise the registry decoder and final resolver error path.
    const get = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation((sql: string, ...params: unknown[]) => {
      const row = get(sql, ...params);
      return row && sql.includes("SELECT * FROM members") ? {...row, global_json:"invalid JSON"} : row;
    });
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/member/room-member-resolver.js");
    expect(() => resolveRoomMember(room.id, member.id)).toThrow();
    expect(() => resolveRoomMembers(room.id)).toThrow();
  });
});
