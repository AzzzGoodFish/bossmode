/**
 * Background execution context: history queries from a background child must
 * NOT advance the member's unread cursor (read-to-clear is a live-turn
 * behavior); the live path keeps it. Declarations unchanged; no model-facing
 * parameter controls this.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
let fixture: ReturnType<typeof coreFixture>;
let tools: typeof import("../../src/engine/tools.js");
let roomStore: typeof import("../../src/workspace/room-store.js");
let registryMod: typeof import("../../src/workspace/member-registry.js");
let bus: typeof import("../../src/communication/message-bus.js");
let memberId = "";
let roomId = "";

beforeEach(async () => {
  fixture = coreFixture();
  tools = await import("../../src/engine/tools.js");
  roomStore = await import("../../src/workspace/room-store.js");
  registryMod = await import("../../src/workspace/member-registry.js");
  bus = await import("../../src/communication/message-bus.js");

  const member = registryMod.createMember({ name: "cursorbot", agentTemplate: "general", model: "anthropic/model-x", credentialId: "cred-a" });
  memberId = member.id;
  const room = roomStore.createRoom("cursor room", undefined, []);
  roomStore.stampGlobalMemberIds(room.id, [memberId], memberId);
  roomId = room.id;
  // three room messages; cursor starts unset (all unread)
  bus.postMessage(roomId, "user", "first unread message");
  bus.postMessage(roomId, "user", "second unread message");
  bus.postMessage(roomId, "user", "third unread message");
});

afterEach(() => fixture.close());

function cursorOf(): string | null {
  return roomStore.getCursors(roomId)[memberId] ?? null;
}

describe("background history queries never consume unread positions", () => {
  it("a live read advances the member's cursor (read-to-clear kept)", async () => {
    const view = await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }) as {content: string}[];
    expect(view.map(row => row.content)).toEqual(["first unread message", "second unread message", "third unread message"]);
    expect(cursorOf()).not.toBeNull();
  });

  it("a background read returns the same messages but leaves the cursor untouched", async () => {
    const before = cursorOf();
    const view = await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }, { execution: "background" }) as {content: string}[];
    expect(view.map(row => row.content)).toEqual(["first unread message", "second unread message", "third unread message"]);
    expect(cursorOf()).toBe(before);
    const live = await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", {limit: 10});
    expect(view).toEqual(live);
  });

  it("mixed sequence: background reads between live reads never regress or advance the cursor", async () => {
    await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 1 }); // live: advances
    const afterLive = cursorOf();
    expect(afterLive).not.toBeNull();
    await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }, { execution: "background" });
    expect(cursorOf()).toBe(afterLive); // unchanged by the background read
    bus.postMessage(roomId, "user", "fourth message arrives");
    await tools.handleToolCallback("query_room_messages", roomId, "cursorbot", { limit: 10 }); // live: advances to the new latest
    expect(cursorOf()).not.toBe(afterLive);
  });
});
