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
});
afterEach(() => fixture.close());

describe("canonical room descriptions", () => {
  it("copies a legacy room-principles document once without rewriting later edits", async () => {
    const { createMember } = await import("../../src/app/member-actions.js");
    const roomStore = await import("../../src/chat/conversations.js");
    const { copyRoomPrinciplesToDescriptions } = await import("../../src/app/upgrade/retirements.js");
    const pm = createMember({ name: "pm" });
    const room = roomStore.createRoom("Project X", [pm.id], { promptLeaderMemberId: pm.id });
    mkdirSync(join(dir, "rooms", room.id, "memory"), { recursive: true });
    writeFileSync(join(dir, "rooms", room.id, "memory", "room-principles.md"), "Legacy principles body\n", "utf-8");

    copyRoomPrinciplesToDescriptions(dir, fixture.db);
    expect(roomStore.getRoom(room.id)?.description).toBe("Legacy principles body");
    writeFileSync(join(dir, "rooms", room.id, "memory", "room-principles.md"), "Edited later\n", "utf-8");
    copyRoomPrinciplesToDescriptions(dir, fixture.db);
    expect(roomStore.getRoom(room.id)?.description).toBe("Legacy principles body");
  });

  it("does not overwrite an existing description during the legacy copy", async () => {
    const { createMember } = await import("../../src/app/member-actions.js");
    const roomStore = await import("../../src/chat/conversations.js");
    const { copyRoomPrinciplesToDescriptions } = await import("../../src/app/upgrade/retirements.js");
    const pm = createMember({ name: "pm" });
    const room = roomStore.createRoom("Project Y", [pm.id], { description: "Fresh description" });
    mkdirSync(join(dir, "rooms", room.id, "memory"), { recursive: true });
    writeFileSync(join(dir, "rooms", room.id, "memory", "room-principles.md"), "Legacy body\n", "utf-8");

    copyRoomPrinciplesToDescriptions(dir, fixture.db);
    expect(roomStore.getRoom(room.id)?.description).toBe("Fresh description");
  });

  it("sets, clears and bounds the canonical description field", async () => {
    const { createMember } = await import("../../src/app/member-actions.js");
    const roomStore = await import("../../src/chat/conversations.js");
    const pm = createMember({ name: "pm" });
    const room = roomStore.createRoom("Project Z", [pm.id]);

    expect(roomStore.updateRoom(room.id, { description: "  hello  " })?.description).toBe("hello");
    expect(roomStore.updateRoom(room.id, { description: "" })?.description).toBeUndefined();
    expect(() => roomStore.updateRoom(room.id, { description: "x".repeat(2001) })).toThrow(/2000/);
    expect(roomStore.updateRoom(room.id, { description: "x".repeat(2000) })?.description).toHaveLength(2000);
  });
});
