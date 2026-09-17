import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;



const wsMocks = vi.hoisted(() => ({ broadcastToRoom: vi.fn() }));
vi.mock("../../src/app/server/ws.js", () => ({
  broadcastToRoom: wsMocks.broadcastToRoom,
}));

describe("runtime error Room boundary", () => {
  let roomStore: typeof import("../../src/chat/conversations.js");
  let messageBus: typeof import("../../src/chat/message-bus.js");

  beforeEach(async () => {
    vi.resetModules();
    const { coreFixture } = await import("../helpers/core-fixture.js");
    fixture = coreFixture();
    tempDir = fixture.root;
    wsMocks.broadcastToRoom.mockReset();
    roomStore = await import("../../src/chat/conversations.js");
    messageBus = await import("../../src/chat/message-bus.js");
  });

  afterEach(() => fixture.close());

  it("caps runtime errors before Room persistence and WS publication only", async () => {
    const room = roomStore.createRoom("test", undefined, []);
    const failure = `Member "pm" request failed. Error: ${"e".repeat(5_763)}`;
    const userContent = "u".repeat(5_763);

    const errorMessage = messageBus.postMessage(room.id, "system", failure);
    const userMessage = messageBus.postMessage(room.id, "user", userContent);

    expect(Array.from(errorMessage.content)).toHaveLength(300);
    expect(errorMessage.content.endsWith("…")).toBe(true);
    expect(userMessage.content).toBe(userContent);
    await vi.waitFor(() => expect(wsMocks.broadcastToRoom).toHaveBeenCalledTimes(2));
    expect(wsMocks.broadcastToRoom).toHaveBeenNthCalledWith(1, room.id, {
      type: "room:message",
      roomId: room.id,
      message: expect.objectContaining({ content: errorMessage.content }),
    });
    expect(wsMocks.broadcastToRoom).toHaveBeenNthCalledWith(2, room.id, {
      type: "room:message",
      roomId: room.id,
      message: expect.objectContaining({ content: userContent }),
    });

    fixture.reopen();
    const persisted = fixture.db.all<{ content: string }>("SELECT content FROM messages WHERE scope_id=? ORDER BY seq", room.id);
    expect(persisted).toHaveLength(2);
    expect(persisted[0].content).toBe(errorMessage.content);
    expect(persisted[1].content).toBe(userContent);
    expect(messageBus.getMessagesSince(room.id, null).map(message => message.content)).toEqual([errorMessage.content, userContent]);
  });
});
