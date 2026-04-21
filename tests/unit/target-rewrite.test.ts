import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllActivationSources, setActivationSource } from "../../src/engine/activation-context.js";

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  emitAgentReply: vi.fn(),
  getRoom: vi.fn(),
  parseMentions: vi.fn(),
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/communication/message-bus.js", () => ({
  postMessage: mocks.postMessage,
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: mocks.getRoom,
}));

vi.mock("../../src/communication/router.js", () => ({
  parseMentions: mocks.parseMentions,
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  emitAgentReply: mocks.emitAgentReply,
}));

vi.mock("../../src/workspace/message-store.js", () => ({
  getMessages: vi.fn(() => []),
  getMessagesByRange: vi.fn(() => []),
  addMessage: vi.fn(),
}));

vi.mock("../../src/knowledge/store.js", () => ({
  addEntry: vi.fn(),
  listEntries: vi.fn(() => []),
  searchEntries: vi.fn(() => []),
  getDocumentTree: vi.fn(() => ({ path: "", name: "docs", kind: "folder", children: [] })),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  getEntry: vi.fn(),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
}));

import { handleToolCallback } from "../../src/engine/tools.js";

describe("chat target rewrite enforcement", () => {
  beforeEach(() => {
    clearAllActivationSources();
    mocks.postMessage.mockReset();
    mocks.emitAgentReply.mockReset();
    mocks.getRoom.mockReset();
    mocks.parseMentions.mockReset();
    mocks.getRoom.mockReturnValue({ id: "room1", members: ["pm", "developer"] });
    mocks.parseMentions.mockReturnValue([]);
  });

  it("rewrites room_mention + target=user to room with warning", async () => {
    setActivationSource("room1", "pm", "room_mention");

    const result = await handleToolCallback("chat", "room1", "pm", {
      message: "reply",
      target: "user",
      mentions: [],
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "pm", "reply", []);
    expect(mocks.emitAgentReply).not.toHaveBeenCalled();
    expect(String((result as any).warning)).toContain("rewrote");
  });

  it("keeps private for private_instruction + target=user", async () => {
    setActivationSource("room1", "pm", "private_instruction");

    const result = await handleToolCallback("chat", "room1", "pm", {
      message: "private",
      target: "user",
      mentions: [],
    });

    expect(mocks.emitAgentReply).toHaveBeenCalledWith("room1", "pm", "private");
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect((result as any).warning).toBeUndefined();
  });

  it("keeps private for self_start + target=user", async () => {
    setActivationSource("room1", "pm", "self_start");
    await handleToolCallback("chat", "room1", "pm", { message: "private", target: "user" });
    expect(mocks.emitAgentReply).toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it("keeps private for system + target=user", async () => {
    setActivationSource("room1", "pm", "system");
    await handleToolCallback("chat", "room1", "pm", { message: "private", target: "user" });
    expect(mocks.emitAgentReply).toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it("keeps private for null source + target=user", async () => {
    await handleToolCallback("chat", "room1", "pm", { message: "private", target: "user" });
    expect(mocks.emitAgentReply).toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it("room_mention + target=room passes without warning", async () => {
    setActivationSource("room1", "pm", "room_mention");
    const result = await handleToolCallback("chat", "room1", "pm", { message: "public", target: "room", mentions: [] });
    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "pm", "public", []);
    expect((result as any).warning).toBeUndefined();
  });

  it("@all fan-out classified as room_mention is also rewritten", async () => {
    setActivationSource("room1", "pm", "room_mention");
    const result = await handleToolCallback("chat", "room1", "pm", {
      message: "should be room",
      target: "user",
    });
    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "pm", "should be room", []);
    expect(String((result as any).warning)).toContain("room @mention");
  });
});
