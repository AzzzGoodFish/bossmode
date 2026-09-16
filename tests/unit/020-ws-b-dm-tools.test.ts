import type { coreFixture } from "../helpers/core-fixture.js";
/**
 * Batch 3 (member-centric tools): gateway capabilities — member_list /
 * chat_create / chat_edit; uniform tool assembly across scope kinds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let fixture: ReturnType<typeof coreFixture>;
let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

describe("batch 3 gateway tools", () => {
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

  it("member_list returns global registry with id/name/description", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm", title: "Product lead" });
    reg.createMember({ name: "developer", agentTemplate: "developer" });
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const result = await handleToolCallback("member_list", `dm:${pm.id}`, "pm", {}, { memberId: pm.id }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.members.map((m: any) => m.name).sort()).toEqual(["developer", "pm"]);
    expect(result.members.find((m: any) => m.name === "pm")).toMatchObject({ description: "Product lead" });
    const filtered = await handleToolCallback("member_list", `dm:${pm.id}`, "pm", { query: "lead" }, { memberId: pm.id }) as any;
    expect(filtered.members.map((m: any) => m.name)).toEqual(["pm"]);
  });

  it("chat_create makes creator leader and invites by id", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer" });
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const result = await handleToolCallback("chat_create", `dm:${pm.id}`, pm.id, {
      name: "Project X",
      description: "# Project X\nShip it.\n",
      members: [dev.id],
    }, { memberId: pm.id }) as any;

    expect(result.ok).toBe(true);
    expect(result.chat).toMatchObject({ kind: "room", name: "Project X" });
    expect(result.members.map((m: any) => m.name).sort()).toEqual(["developer", "pm"]);

    const roomId = String(result.chat.id).replace(/^room:/, "");
    const roomStore = await import("../../src/chat/room-store.js");
    const room = roomStore.getRoom(roomId)!;
    expect(room.name).toBe("Project X");
    expect(room.globalMemberIds || []).toEqual(expect.arrayContaining([pm.id, dev.id]));
    const leader = roomStore.getRoomMembers(roomId).find((m) => m.id === room.promptLeaderMemberId);
    expect(leader?.name).toBe("pm");

    const room2 = roomStore.getRoom(roomId)!;
    expect(room2.description).toContain("Ship it");

    // Retired parameter names carry guidance instead of silent fallback.
    const legacy = await handleToolCallback("chat_create", `dm:${pm.id}`, pm.id, {
      name: "R2",
      memberIds: [dev.id],
    }, { memberId: pm.id }) as any;
    expect(legacy.ok).toBe(false);
    expect(legacy.error).toMatch(/use 'members'/);
  });

  it("chat_edit: any room member can rename and adjust members (leader gate retired)", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer" });
    const extra = reg.createMember({ name: "extra", agentTemplate: "general" });
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const created = await handleToolCallback("chat_create", `dm:${pm.id}`, pm.id, {
      name: "R1",
      members: [dev.id],
    }, { memberId: pm.id }) as any;
    expect(created.ok).toBe(true);
    const roomId = String(created.chat.id).replace(/^room:/, "");

    const ok = await handleToolCallback("chat_edit", roomId, dev.id, {
      chat: roomId,
      name: "R1-renamed",
      add_members: [extra.id],
    }, { memberId: dev.id }) as any;
    expect(ok.ok).toBe(true);
    expect(ok.chat.name).toBe("R1-renamed");
    expect(ok.added).toEqual(["extra"]);
  });

  it("tool assembly is uniform: hot chat tools + gateway; wait and legacy names never registered", async () => {
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    for (const scope of [
      { memberId: "mem_schema_fixture", roomId: "", scopeKind: "dm" as const },
      { memberId: "mem_schema_fixture", roomId: "r1", scopeKind: "room" as const },
    ]) {
      const names = createBossmodeSdkTools(scope).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["chat_send", "chat_read", "chat_search", "chat_list", "bossmode"]));
      for (const retired of ["wait", "create_room", "edit_room", "list_members", "query_room_messages", "list_scopes", "update_profile", "member_status", "read_memory", "write_memory"]) {
        expect(names).not.toContain(retired);
      }
    }
  });
});
