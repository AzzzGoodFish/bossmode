/**
 * Read-to-clear: any successful read of the member's own room advances their
 * unread cursor to the furthest message seen. Declarations unchanged; no
 * model-facing parameter controls this.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
let fixture: ReturnType<typeof coreFixture>;
let tools: typeof import("../../src/agent/tools/tools.js");
let roomStore: typeof import("../../src/chat/conversations.js");
let registryMod: typeof import("../../src/member/identity.js"), __registryMod_app_member_actions: typeof import("../../src/app/member-actions.js");
let bus: typeof import("../../src/chat/message-bus.js");
let memberId = "";
let roomId = "";

beforeEach(async () => {
  fixture = coreFixture();
  tools = await import("../../src/agent/tools/tools.js");
  roomStore = await import("../../src/chat/conversations.js");
  registryMod = await import("../../src/member/identity.js");
__registryMod_app_member_actions = await import("../../src/app/member-actions.js");
  bus = await import("../../src/chat/message-bus.js");

  const member = __registryMod_app_member_actions.createMember({ name: "cursorbot", agentTemplate: "general", model: "anthropic/model-x", credentialId: "cred-a" });
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

describe("history queries advance unread positions", () => {
  it("a live read advances the member's cursor (read-to-clear kept)", async () => {
    const view = await tools.handleToolCallback("chat_read", roomId, "cursorbot", { limit: 10 }) as {content: string}[];
    expect(view.map(row => row.content)).toEqual(["first unread message", "second unread message", "third unread message"]);
    expect(cursorOf()).not.toBeNull();
  });

  it("a read advances the cursor to the latest message seen; new arrivals advance it further", async () => {
    await tools.handleToolCallback("chat_read", roomId, "cursorbot", { limit: 1 });
    const afterFirst = cursorOf();
    expect(afterFirst).not.toBeNull();
    bus.postMessage(roomId, "user", "fourth message arrives");
    await tools.handleToolCallback("chat_read", roomId, "cursorbot", { limit: 10 });
    expect(cursorOf()).not.toBe(afterFirst);
  });
});
