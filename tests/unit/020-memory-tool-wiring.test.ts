/**
 * 0.20 P0 regression — memory tools must read/write the member-global memory
 * store (members/<id>/memory/), the same paths the prompt compiler reads.
 * rc.1–rc.3 wired tools to the legacy room-keyed stores, so every post-upgrade
 * memory write was silently invisible to the compiler (silent data fork).
 *
 * The core assertion is the closed loop: write_memory → the next compiled
 * prompt actually contains the content.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function setupRoomWithMember(memberName: string) {
  const reg = await import("../../src/workspace/member-registry.js");
  const roomStore = await import("../../src/workspace/room-store.js");
  const member = reg.createMember({ name: memberName, agentTemplate: memberName });
  const room = roomStore.createRoom("r", dir, [], undefined);
  roomStore.stampGlobalMemberIds(room.id, [member.id], member.id);
  return { member, room: roomStore.getRoom(room.id)! };
}

describe("020 memory tool wiring (member-global store)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-mem-wiring-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "knowledge", "docs"), { recursive: true });
    seedAgent("pm");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("closed loop (room scope): write_memory lands in member-global store and appears in the next compiled prompt", async () => {
    const { member, room } = await setupRoomWithMember("pm");
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const MARKER = "E2E-MEMORY-CLOSED-LOOP-421";
    const write = (await handleToolCallback("write_memory", room.id, "pm", {
      asset: "mainline",
      content: `## Focus\n\n${MARKER}\n\n## Dynamic Index\n\n`,
      reason: "test closed loop",
    })) as any;
    expect(write.ok).toBe(true);

    // 1. File landed at the NEW member-global path, not rooms/<id>/memory/members/.
    const newPath = join(dir, "members", member.id, "memory", "scopes", `room-${room.id}`, "mainline.md");
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, "utf-8")).toContain(MARKER);
    expect(existsSync(join(dir, "rooms", room.id, "memory", "members"))).toBe(false);

    // 2. The compiler reads it back — the assertion rc.1–rc.3 lacked.
    const { compileMemberPromptForScope } = await import("../../src/engine/prompt-compiler.js");
    const compiled = compileMemberPromptForScope({
      scopeId: `room:${room.id}`,
      memberId: member.id,
      memberName: "pm",
      agentDef: { name: "pm", description: "pm", systemPrompt: "You are pm.", tags: [] },
      room,
      docsRoot: join(dir, "knowledge", "docs"),
    });
    expect(compiled.fullPrompt).toContain(MARKER);

    // 3. read_memory returns the new-location content with metadata.
    const read = (await handleToolCallback("read_memory", room.id, "pm", { asset: "mainline" })) as any;
    expect(read.ok).toBe(true);
    expect(read.content).toContain(MARKER);
    expect(read.revision).toBe(1);
    expect(read.updatedByName).toBe("pm");
  });

  it("edit_memory does exact-text replacement in the member-global store and bumps revision", async () => {
    const { member, room } = await setupRoomWithMember("pm");
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    await handleToolCallback("write_memory", room.id, "pm", {
      asset: "principles", scope: "member", content: "rule alpha\nrule beta", reason: "seed",
    });
    const edit = (await handleToolCallback("edit_memory", room.id, "pm", {
      asset: "principles", scope: "member", oldText: "rule beta", newText: "rule gamma", reason: "refine",
    })) as any;
    expect(edit.ok).toBe(true);
    expect(edit.revision).toBe(2);

    const newPath = join(dir, "members", member.id, "memory", "scopes", `room-${room.id}`, "principles.md");
    expect(readFileSync(newPath, "utf-8")).toBe("rule alpha\nrule gamma");

    // duplicate oldText is rejected
    await handleToolCallback("write_memory", room.id, "pm", {
      asset: "principles", scope: "member", content: "dup\ndup", reason: "seed",
    });
    const dup = (await handleToolCallback("edit_memory", room.id, "pm", {
      asset: "principles", scope: "member", oldText: "dup", newText: "x", reason: "r",
    })) as any;
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/exactly once/);
  });

  it("closed loop (dm scope): tools resolve the member from dm:<id> and writes reach the dm scope layer", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const member = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const dmRoomId = `dm:${member.id}`;

    const MARKER = "E2E-DM-SCOPE-842";
    const write = (await handleToolCallback("write_memory", dmRoomId, "pm", {
      asset: "mainline", content: `## Focus\n\n${MARKER}\n\n## Dynamic Index\n\n`, reason: "dm write",
    })) as any;
    expect(write.ok).toBe(true);

    const newPath = join(dir, "members", member.id, "memory", "scopes", "dm", "mainline.md");
    expect(readFileSync(newPath, "utf-8")).toContain(MARKER);

    const read = (await handleToolCallback("read_memory", dmRoomId, "pm", { asset: "mainline" })) as any;
    expect(read.ok).toBe(true);
    expect(read.content).toContain(MARKER);

    // room principles are meaningless in a DM scope
    const roomPrinciples = (await handleToolCallback("read_memory", dmRoomId, "pm", { asset: "principles", scope: "room" })) as any;
    expect(roomPrinciples.ok).toBe(false);
  });

  it("room principles stay room-keyed and leader-only", async () => {
    const { room } = await setupRoomWithMember("pm");
    const { handleToolCallback } = await import("../../src/engine/tools.js");

    const write = (await handleToolCallback("write_memory", room.id, "pm", {
      asset: "principles", scope: "room", content: "ROOM-RULE-17", reason: "leader sets rule",
    })) as any;
    expect(write.ok).toBe(true);

    const { readPrinciplesWithBudget } = await import("../../src/workspace/principles-store.js");
    expect(readPrinciplesWithBudget(room.id, "room").content).toBe("ROOM-RULE-17");

    const read = (await handleToolCallback("read_memory", room.id, "pm", { asset: "principles", scope: "room" })) as any;
    expect(read.ok).toBe(true);
    expect(read.content).toBe("ROOM-RULE-17");
  });
});
