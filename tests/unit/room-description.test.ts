import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Fixture = ReturnType<(typeof import("../helpers/core-fixture.js"))["coreFixture"]>;
let fixture: Fixture;
let dir: string;
beforeEach(async () => {
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
  dir = fixture.root;
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "rooms"), { recursive: true });
});
afterEach(() => fixture.close());

describe("room description (⑤ A)", () => {
  it("copy migration seeds description from legacy room-principles.md once", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const { copyRoomPrinciplesToDescriptions } = await import("../../src/data/migrations/room-description-migration.js");
    const pm = reg.createMember({ name: "pm" });
    const room = roomStore.createRoom("Project X", undefined, [pm.id], undefined, { promptLeaderMemberId: pm.id });
    mkdirSync(join(dir, "rooms", room.id, "memory"), { recursive: true });
    writeFileSync(join(dir, "rooms", room.id, "memory", "room-principles.md"), "Legacy principles body\n", "utf-8");

    copyRoomPrinciplesToDescriptions(dir, fixture.db);
    expect(roomStore.getRoom(room.id)?.description).toBe("Legacy principles body");

    // Idempotent: a later file edit is not re-copied (flag), and description is never overwritten.
    writeFileSync(join(dir, "rooms", room.id, "memory", "room-principles.md"), "Edited later\n", "utf-8");
    copyRoomPrinciplesToDescriptions(dir, fixture.db);
    expect(roomStore.getRoom(room.id)?.description).toBe("Legacy principles body");
  });

  it("an existing description is left untouched by the copy", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const { copyRoomPrinciplesToDescriptions } = await import("../../src/data/migrations/room-description-migration.js");
    const pm = reg.createMember({ name: "pm" });
    const room = roomStore.createRoom("Project Y", undefined, [pm.id], undefined, { description: "Fresh description" });
    mkdirSync(join(dir, "rooms", room.id, "memory"), { recursive: true });
    writeFileSync(join(dir, "rooms", room.id, "memory", "room-principles.md"), "Legacy body\n", "utf-8");

    copyRoomPrinciplesToDescriptions(dir, fixture.db);
    expect(roomStore.getRoom(room.id)?.description).toBe("Fresh description");
  });

  it("updateRoomDescription sets, clears and enforces the 2000-char limit", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const pm = reg.createMember({ name: "pm" });
    const room = roomStore.createRoom("Project Z", undefined, [pm.id]);

    expect(roomStore.updateRoomDescription(room.id, "  hello  ")?.description).toBe("hello");
    expect(roomStore.updateRoomDescription(room.id, "")?.description).toBeUndefined();
    expect(() => roomStore.updateRoomDescription(room.id, "x".repeat(2001))).toThrow(/2000/);
    expect(roomStore.updateRoomDescription(room.id, "x".repeat(2000))?.description).toHaveLength(2000);
  });

  it("chat_create / chat_edit / chat_info / chat_list carry the room description", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const pm = reg.createMember({ name: "pm" });
    const dev = reg.createMember({ name: "dev" });

    const created = await handleToolCallback("chat_create", `dm:${pm.id}`, pm.id, {
      name: "Design sync",
      description: "First line\nSecond line",
      members: [dev.id],
    }, { memberId: pm.id }) as any;
    expect(created.ok).toBe(true);
    const roomId = String(created.chat.id).replace(/^room:/, "");
    expect(roomStore.getRoom(roomId)?.description).toBe("First line\nSecond line");

    const tooLong = await handleToolCallback("chat_edit", `dm:${pm.id}`, pm.id, {
      chat: roomId, description: "x".repeat(2001),
    }, { memberId: pm.id }) as any;
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toMatch(/2000/);

    await handleToolCallback("chat_edit", `dm:${pm.id}`, pm.id, {
      chat: roomId, description: "Updated description",
    }, { memberId: pm.id });
    const info = await handleToolCallback("chat_info", `dm:${pm.id}`, pm.id, { chat: roomId }, { memberId: pm.id }) as any;
    expect(info.chat.description).toBe("Updated description");

    const list = await handleToolCallback("chat_list", `dm:${pm.id}`, pm.id, {}, { memberId: pm.id }) as any;
    const listed = list.chats.find((c: any) => c.id === `room:${roomId}`);
    expect(listed.description).toBe("Updated description");

    // chat_edit with an empty string clears the stored description.
    await handleToolCallback("chat_edit", `dm:${pm.id}`, pm.id, { chat: roomId, description: "" }, { memberId: pm.id });
    expect(roomStore.getRoom(roomId)?.description).toBeUndefined();
  });
});
