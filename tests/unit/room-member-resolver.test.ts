import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

let dir: string;
let closeDb: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bossmode-room-member-resolver-"));
  vi.resetModules();
  vi.stubEnv("BOSSMODE_DIR", dir);
});

afterEach(() => {
  closeDb?.();
  closeDb = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function writeAgent(name: string, extraFrontmatter = ""): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n${extraFrontmatter}---\n${name} prompt\n`, "utf-8");
}

describe("room-member-resolver — no implicit model default", () => {
  it("leaves a freshly created direct Agent member Unconfigured (no model, no credentialId)", async () => {
    writeAgent("architect");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, drafts(["architect"]));
    const resolved = resolveRoomMember(room.id, "architect");

    expect(resolved?.model).toBeUndefined();
    expect(resolved?.credentialId).toBeUndefined();
  });

  it("ignores a legacy model field in Agent definition frontmatter", async () => {
    writeAgent("pm", "model: claude-sonnet-4-6\n");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, drafts(["pm"]));
    const resolved = resolveRoomMember(room.id, "pm");

    expect(resolved?.model).toBeUndefined();
  });

  it("does not synthesize a default model for a legacy global member with model set but no credentialId", async () => {
    writeAgent("developer");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    const { runRoomMemberMigration } = await import("../../src/workspace/room-member-migration.js");

    writeFileSync(join(dir, "members.json"), JSON.stringify([
      { id: "legacy-developer", name: "developer", agent: "developer", runtime: "pi-cli", model: "claude-sonnet-4-6", thinkingLevel: "off" },
    ]));
    const room = roomStore.createRoom("A", dir, drafts(["developer"]));
    // Simulate a pre-v0.14 legacy room with no roomMembers array yet, so migration
    // materializes the legacy member configuration in the room record.
    const roomJsonPath = join(roomStore.roomDir(room.id), "room.json");
    const rawRoom = JSON.parse(readFileSync(roomJsonPath, "utf-8"));
    delete rawRoom.roomMembers;
    writeFileSync(roomJsonPath, JSON.stringify(rawRoom, null, 2), "utf-8");
    runRoomMemberMigration();
    // Live resolution must not consult the migration input again.
    writeFileSync(join(dir, "members.json"), "invalid retired data");

    const resolved = resolveRoomMember(room.id, "developer");
    expect(resolved?.model).toBe("claude-sonnet-4-6");
    expect(resolved?.credentialId).toBeUndefined();
  });

  it("resolves an explicitly configured member's model and credentialId together", async () => {
    writeAgent("qa");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, drafts(["qa"]));
    roomStore.updateRoomMemberOverride(room.id, "qa", { model: "anthropic/claude-opus-4-6", credentialId: "cred-x" });

    const resolved = resolveRoomMember(room.id, "qa");
    expect(resolved?.model).toBe("anthropic/claude-opus-4-6");
    expect(resolved?.credentialId).toBe("cred-x");
  });
});

async function currentMemberFixture() {
  const registry = await import("../../src/workspace/member-registry.js");
  const { openDb } = await import("../../src/workspace/db/sqlite.js");
  const db = openDb();
  closeDb = () => db.close();
  const member = registry.importMemberRecord({
    id: "mem_current", name: "current-name", title: "Engineer", agentTemplate: "developer",
    unifiedModel: true, unifiedExtensions: true, scopeOverrides: {},
    global: { model: "db-model", credentialId: "db-credential", thinkingLevel: "high", skills: ["db-skill"], mcpServers: ["db-mcp"] },
    createdAt: 1, updatedAt: 2,
  });
  const roomStore = await import("../../src/workspace/room-store.js");
  const room = roomStore.createRoom("Current", dir, []);
  // A pre-cutover linked shadow must not supply identity or cleared settings.
  const shadow = {
    id: "rm_shadow", roomId: room.id, name: "stale-name", sourceAgent: "stale-agent",
    sourceMemberId: member.id, createdAt: 1, updatedAt: 1,
    config: { model: "shadow-model", credentialId: "shadow-credential", thinkingLevel: "high", skills: ["shadow-skill"], mcpServers: ["shadow-mcp"], contextLimit: 99 },
  };
  const path = join(roomStore.roomDir(room.id), "room.json");
  writeFileSync(path, JSON.stringify({ ...room, roomMembers: [shadow] }));
  return { registry, member, roomStore, room, path, shadow, db };
}

describe("room-member-resolver — database authority", () => {
  it("uses DB identity and config for a linked current member, including cleared settings", async () => {
    const { registry, member, roomStore, room } = await currentMemberFixture();
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/workforce/room-member-resolver.js");
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
    writeFileSync(path, JSON.stringify({ ...room, globalMemberIds: [member.id], roomMembers: [shadow] }));
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room.id, member.id)).toMatchObject({ id: member.id, name: "current-name", model: "db-model" });
    expect(resolveRoomMembers(room.id)).toHaveLength(1);
  });

  it("propagates effective-config read failures instead of using shadow config", async () => {
    const { registry, room } = await currentMemberFixture();
    vi.spyOn(registry, "getEffectiveConfig").mockImplementation(() => { throw new Error("DB config read failed"); });
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/workforce/room-member-resolver.js");
    expect(() => resolveRoomMember(room.id, "rm_shadow")).toThrow("DB config read failed");
    expect(() => resolveRoomMembers(room.id)).toThrow("DB config read failed");
  });

  it("does not revive a linked member missing from the DB", async () => {
    const { registry, member, room } = await currentMemberFixture();
    registry.deleteMemberForTests(member.id);
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    expect(() => resolveRoomMember(room.id, "rm_shadow")).toThrow("Member not found");
  });

  it("does not resolve a missing global member through a same-named agent or stale overrides", async () => {
    const { registry, member, room, path } = await currentMemberFixture();
    writeAgent(member.name);
    writeFileSync(path, JSON.stringify({ ...room, globalMemberIds: [member.id], memberOverrides: { [member.name]: { model: "stale-model" } } }));
    registry.deleteMemberForTests(member.id);
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/workforce/room-member-resolver.js");
    expect(resolveRoomMember(room.id, member.name)).toBeNull();
    expect(resolveRoomMembers(room.id, [member.name])).toEqual([]);
  });

  it("propagates corrupt DB configuration for global membership", async () => {
    const { member, room, path, shadow, db } = await currentMemberFixture();
    writeFileSync(path, JSON.stringify({ ...room, globalMemberIds: [member.id], roomMembers: [shadow] }));
    db.run("UPDATE members SET global_json = ? WHERE id = ?", "invalid JSON", member.id);
    const { resolveRoomMember, resolveRoomMembers } = await import("../../src/workforce/room-member-resolver.js");
    expect(() => resolveRoomMember(room.id, member.id)).toThrow();
    expect(() => resolveRoomMembers(room.id)).toThrow();
  });
});
