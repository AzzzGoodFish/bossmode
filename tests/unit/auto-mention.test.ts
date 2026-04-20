import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getDocumentTree: vi.fn(() => ({ path: "", name: "docs", kind: "folder", children: [] })),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
}));

import { handleToolCallback } from "../../src/engine/tools.js";

describe("tools chat mentions semantics", () => {
  beforeEach(() => {
    mocks.postMessage.mockReset();
    mocks.emitAgentReply.mockReset();
    mocks.getRoom.mockReset();
    mocks.parseMentions.mockReset();
    mocks.getRoom.mockReturnValue({ id: "room1", members: ["architect", "developer", "qa"] });
    mocks.parseMentions.mockReturnValue([]);
  });

  it("does not auto-activate from content @mentions when mentions is empty", async () => {
    mocks.parseMentions.mockReturnValue(["developer"]);

    const result = await handleToolCallback("chat", "room1", "architect", {
      message: "@developer please implement",
      mentions: [],
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "architect", "@developer please implement", []);
    expect(result).toEqual({
      ok: true,
      warning: expect.stringContaining("@developer"),
    });
  });

  it("returns warning for missing mentions[] entries only", async () => {
    mocks.parseMentions.mockReturnValue(["developer", "qa"]);

    const result = await handleToolCallback("chat", "room1", "architect", {
      message: "@developer @qa sync",
      mentions: ["developer"],
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "architect", "@developer @qa sync", ["developer"]);
    expect(String((result as any).warning)).toContain("@qa");
    expect(String((result as any).warning)).not.toContain("@developer");
  });

  it("does not warn when mentions[] fully matches content mentions", async () => {
    mocks.parseMentions.mockReturnValue(["developer"]);

    const result = await handleToolCallback("chat", "room1", "architect", {
      message: "@developer please implement",
      mentions: ["developer"],
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "architect", "@developer please implement", ["developer"]);
    expect(result).toEqual({ ok: true });
  });

  it("does not parse mentions for target=user private reply", async () => {
    const result = await handleToolCallback("chat", "room1", "architect", {
      message: "@developer this is private",
      target: "user",
      mentions: [],
    });

    expect(mocks.emitAgentReply).toHaveBeenCalledWith("room1", "architect", "@developer this is private");
    expect(mocks.parseMentions).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, target: "user" });
  });

  it("silently degrades when room lookup fails", async () => {
    mocks.getRoom.mockReturnValue(null);

    const result = await handleToolCallback("chat", "room1", "architect", {
      message: "@developer ping",
      mentions: [],
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "architect", "@developer ping", []);
    expect(result).toEqual({ ok: true });
  });
});
