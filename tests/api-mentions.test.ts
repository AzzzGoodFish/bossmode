import { describe, it, expect, vi, beforeEach } from "vitest";

const postMessage = vi.fn();
const emitAgentReply = vi.fn();
const parseMentions = vi.fn();
const getRoom = vi.fn();

vi.mock("../src/communication/message-bus.js", () => ({
  postMessage,
}));

vi.mock("../src/engine/agent-manager.js", () => ({
  emitAgentReply,
}));

vi.mock("../src/communication/router.js", () => ({
  parseMentions,
}));

vi.mock("../src/workspace/room-store.js", () => ({
  getRoom,
}));

vi.mock("../src/workspace/message-store.js", () => ({
  getMessages: vi.fn(() => []),
  getMessagesByRange: vi.fn(() => []),
  addMessage: vi.fn(),
}));

vi.mock("../src/knowledge/store.js", () => ({
  listEntries: vi.fn(() => []),
  addEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));

describe("chat tool mentions semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRoom.mockReturnValue({ id: "room-1", members: ["pm", "developer", "qa", "architect"] });
    parseMentions.mockReturnValue([]);
  });

  it("activates only explicit mentions and does not auto-activate from content", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    parseMentions.mockReturnValue(["developer"]);
    const result = await handleToolCallback("chat", "room-1", "architect", {
      message: "@developer please implement",
      mentions: [],
      target: "room",
    });

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer please implement", []);
    expect(parseMentions).toHaveBeenCalledWith("@developer please implement", ["pm", "developer", "qa", "architect"]);
    expect(String((result as any).warning)).toContain("@developer");
    expect(String((result as any).warning)).toContain("mentions[]");
  });

  it("does not warn when content mentions are fully covered by mentions[]", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    parseMentions.mockReturnValue(["developer", "qa"]);
    const result = await handleToolCallback("chat", "room-1", "architect", {
      message: "@developer and @qa sync",
      mentions: ["developer", "qa"],
      target: "room",
    });

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer and @qa sync", ["developer", "qa"]);
    expect((result as any).warning).toBeUndefined();
  });

  it("warns only for orphan mentions missing from mentions[]", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    parseMentions.mockReturnValue(["developer", "qa"]);
    const result = await handleToolCallback("chat", "room-1", "architect", {
      message: "@developer and @qa sync",
      mentions: ["developer"],
      target: "room",
    });

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer and @qa sync", ["developer"]);
    expect(String((result as any).warning)).toContain("@qa");
    expect(String((result as any).warning)).not.toContain("@developer");
  });

  it("does not parse mentions on target=user (F11)", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    const result = await handleToolCallback("chat", "room-1", "architect", {
      message: "@developer private note",
      mentions: [],
      target: "user",
    });

    expect(parseMentions).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    expect(emitAgentReply).toHaveBeenCalledWith("room-1", "architect", "@developer private note");
    expect(result).toEqual({ ok: true, target: "user" });
  });

  it("silently degrades warning generation when room lookup fails", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    getRoom.mockReturnValue(null);
    const result = await handleToolCallback("chat", "room-1", "architect", {
      message: "@developer",
      mentions: [],
      target: "room",
    });

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer", []);
    expect(result).toEqual({ ok: true });
  });
});
