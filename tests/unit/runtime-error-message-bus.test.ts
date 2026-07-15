import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

const wsMocks = vi.hoisted(() => ({ broadcastToRoom: vi.fn() }));
vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: wsMocks.broadcastToRoom,
}));

describe("runtime error Room boundary", () => {
  let roomStore: typeof import("../../src/workspace/room-store.js");
  let messageBus: typeof import("../../src/communication/message-bus.js");

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-runtime-error-room-"));
    mkdirSync(join(tempDir, "agents"), { recursive: true });
    writeFileSync(join(tempDir, "agents", "pm.md"), "---\nname: pm\n---\nPM", "utf-8");
    wsMocks.broadcastToRoom.mockReset();
    vi.resetModules();
    roomStore = await import("../../src/workspace/room-store.js");
    messageBus = await import("../../src/communication/message-bus.js");
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("caps runtime errors before Room persistence and WS publication only", () => {
    const room = roomStore.createRoom("test", "/tmp", [{ agent: "pm", name: "pm" }]);
    const failure = `Member "pm" request failed. Error: ${"e".repeat(5_763)}`;
    const userContent = "u".repeat(5_763);

    const errorMessage = messageBus.postMessage(room.id, "system", failure);
    const userMessage = messageBus.postMessage(room.id, "user", userContent);

    expect(Array.from(errorMessage.content)).toHaveLength(300);
    expect(errorMessage.content.endsWith("…")).toBe(true);
    expect(userMessage.content).toBe(userContent);
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

    const persisted = readFileSync(join(tempDir, "rooms", room.id, "messages.jsonl"), "utf-8").trim().split("\n").map(JSON.parse);
    expect(persisted[0].content).toBe(errorMessage.content);
    expect(persisted[1].content).toBe(userContent);
  });
});
