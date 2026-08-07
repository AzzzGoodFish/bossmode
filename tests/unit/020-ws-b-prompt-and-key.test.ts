/**
 * 0.20 WS-B foundation: scope-aware prompt assembly + instanceKey rekey.
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

describe("020 WS-B prompt + instanceKey", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-wsb-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("instanceKey for room uses room:<id>:<memberId>", async () => {
    const { scopeIdOf, instanceKey, parseInstanceKey } = await import("../../src/shared/conversation-ref.js");
    const scope = scopeIdOf({ kind: "room", roomId: "abc" });
    expect(scope).toBe("room:abc");
    const key = instanceKey(scope, "mem_x");
    expect(key).toBe("room:abc:mem_x");
    expect(parseInstanceKey(key)).toEqual({ scopeId: "room:abc", memberId: "mem_x" });
  });

  it("compileMemberPromptForScope (room) orders persona → scope principles → mainline → room principles", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const mem = await import("../../src/workspace/member-memory-store.js");
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");

    const member = reg.createMember({ name: "architect", agentTemplate: "architect" });
    mem.writeMemoryLayer(member.id, "persona", "# Persona\nI am careful.", { type: "user" });
    mem.writeMemoryLayer(member.id, "principles", "# Scope rules\nAlways test.", { type: "user" }, { scopeId: `room:room1` });
    mem.writeMemoryLayer(member.id, "mainline", "## Focus\nShip 0.20", { type: "user" }, { scopeId: `room:room1` });

    // Minimal room with principles file
    const roomDir = join(dir, "rooms", "room1");
    mkdirSync(join(roomDir, "memory"), { recursive: true });
    writeFileSync(join(roomDir, "memory", "room-principles.md"), "# Room\nBe kind.\n", "utf-8");
    writeFileSync(join(roomDir, "room.json"), JSON.stringify({
      id: "room1",
      name: "Test Room",
      cwd: dir,
      members: ["architect"],
      roomMembers: [{ id: member.id, name: "architect", agent: "architect" }],
      promptLeaderMemberId: member.id,
    }), "utf-8");

    const { readFileSync } = await import("node:fs");
    const room = JSON.parse(readFileSync(join(roomDir, "room.json"), "utf-8"));
    const compiled = compileMemberPromptForScope({
      scopeId: "room:room1",
      memberId: member.id,
      memberName: "architect",
      agentDef: { name: "architect", description: "", systemPrompt: "You are the architect.", tags: [], skills: [] },
      room,
      docsRoot: join(dir, "docs"),
    });

    const ids = compiled.sections.filter((s) => s.included).map((s) => s.id);
    expect(ids).toEqual([
      "source-agent",
      "bossmode-core",
      "environment-communication",
      "persona",
      "member-principles",
      "member-mainline",
      "room-principles",
    ]);
    expect(compiled.envPrompt).toContain("group chat room");
    expect(compiled.envPrompt).toContain("Speak with the `chat` tool");
    expect(compiled.envPrompt).not.toContain("[room]");
    expect(compiled.fullPrompt).toContain("I am careful.");
    expect(compiled.fullPrompt).toContain("Always test.");
    expect(compiled.fullPrompt).toContain("Ship 0.20");
    expect(compiled.fullPrompt).toContain("Be kind.");
  });

  it("compileMemberPromptForScope (dm) has no @ routing and no room principles", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");

    const member = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const compiled = compileMemberPromptForScope({
      scopeId: `dm:${member.id}`,
      memberId: member.id,
      memberName: "pm",
      agentDef: { name: "pm", description: "", systemPrompt: "You are pm.", tags: [], skills: [] },
      room: null,
      docsRoot: join(dir, "docs"),
      activeScopes: [`dm:${member.id}`],
    });

    expect(compiled.envPrompt).toContain("private chat");
    expect(compiled.envPrompt).toContain("create_room");
    // No @ routing in DM; no [room] marker mention at all (feature removed)
    expect(compiled.envPrompt).toMatch(/no.*@/i);
    expect(compiled.envPrompt).not.toContain("[room]");
    const roomSection = compiled.sections.find((s) => s.id === "room-principles");
    expect(roomSection?.included).toBe(false);
  });

  it("tool surface: dm has create_room, room has wait/tasks", async () => {
    const { toolSurfaceForScope, familyEnabled } = await import("../../src/engine/scope-tool-surface.js");
    const dm = toolSurfaceForScope("dm:mem_x");
    expect(dm.kind).toBe("dm");
    expect(dm.families).toContain("create_room");
    expect(dm.families).not.toContain("wait");
    expect(dm.families).not.toContain("tasks");

    const room = toolSurfaceForScope("room:r1", { isRoomLeader: false });
    expect(room.families).toContain("wait");
    expect(room.families).toContain("tasks");
    expect(room.families).not.toContain("create_room");
    expect(familyEnabled("room:r1", "edit_room", { isRoomLeader: false })).toBe(false);
    expect(familyEnabled("room:r1", "edit_room", { isRoomLeader: true })).toBe(true);
  });

  it("getEffectiveConfig respects unifiedModel off + scope override", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const member = reg.createMember({
      name: "dev",
      agentTemplate: "developer",
      model: "global/model",
      credentialId: "cred-g",
      unifiedModel: false,
    });
    reg.patchScopeOverride(member.id, "room:r1", { model: "scope/model", credentialId: "cred-s" });
    const eff = reg.getEffectiveConfig(member.id, "room:r1");
    expect(eff.model).toBe("scope/model");
    expect(eff.sources.model).toBe("scope");
    expect(eff.credentialId).toBe("cred-s");
  });
});
