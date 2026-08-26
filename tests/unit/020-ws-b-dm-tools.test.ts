/**
 * 0.20 WS-B: DM tool surface — list_members / create_room / edit_room.
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

function seedAgent(name: string) {
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, `${name}.md`),
    `---\nname: ${name}\ndescription: \"${name}\"\n---\n\nYou are ${name}.\n`,
    "utf-8",
  );
}

describe("020 WS-B DM tools", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-wsb-dm-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "memory", "projects"), { recursive: true });
    seedAgent("pm");
    seedAgent("developer");
    seedAgent("general");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("list_members returns global registry", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    reg.createMember({ name: "pm", agentTemplate: "pm" });
    reg.createMember({ name: "developer", agentTemplate: "developer" });
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const result = await handleToolCallback("list_members", "", "pm", {}) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.members.map((m: any) => m.name).sort()).toEqual(["developer", "pm"]);
  });

  it("create_room makes creator leader and invites by id", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer" });
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const result = await handleToolCallback("create_room", "", "pm", {
      name: "Project X",
      cwd: dir,
      memberIds: [dev.id],
      principles: "# Project X\nShip it.\n",
    }) as any;

    expect(result.ok).toBe(true);
    expect(result.roomId).toBeTruthy();
    expect(result.leader).toBe("pm");
    expect(result.members.map((m: any) => m.name).sort()).toEqual(["developer", "pm"]);

    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.getRoom(result.roomId)!;
    expect(room.name).toBe("Project X");
    expect(room.globalMemberIds || []).toEqual(expect.arrayContaining([pm.id, dev.id]));
    const leader = roomStore.getRoomMembers(result.roomId).find((m) => m.id === room.promptLeaderMemberId);
    expect(leader?.name).toBe("pm");

    const principles = await import("../../src/workspace/principles-store.js");
    const rp = principles.readPrinciples(result.roomId, "room");
    expect(rp.content).toContain("Ship it");
  });

  it("edit_room any room member can rename (leader gate retired)", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    reg.createMember({ name: "pm", agentTemplate: "pm" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer" });
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const created = await handleToolCallback("create_room", "", "pm", {
      name: "R1",
      cwd: dir,
      memberIds: [dev.id],
    }) as any;
    expect(created.ok).toBe(true);

    const ok = await handleToolCallback("edit_room", created.roomId, "developer", {
      roomId: created.roomId,
      name: "R1-renamed",
    }) as any;
    expect(ok.ok).toBe(true);
    expect(ok.name).toBe("R1-renamed");
  });

  it("DM tool assembly has create_room and no wait; room has wait and no create_room", async () => {
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const dm = createBossmodeSdkTools({ roomId: "", agentName: "pm", roomMembers: ["pm"], scopeKind: "dm" });
    const names = dm.map((t) => t.name);
    expect(names).toContain("create_room");
    expect(names).toContain("list_members");
    expect(names).toContain("edit_room");
    expect(names).not.toContain("wait");
    expect(names).not.toContain("read_memory");
    expect(names).not.toContain("write_memory");
    expect(names).not.toContain("create_task");

    const room = createBossmodeSdkTools({ roomId: "r1", agentName: "pm", roomMembers: ["pm", "qa"], scopeKind: "room" });
    const roomNames = room.map((t) => t.name);
    expect(roomNames).toContain("wait");
    expect(roomNames).toContain("create_task");
    expect(roomNames).not.toContain("create_room");
  });
});
