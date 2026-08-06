import { describe, it, expect, vi, beforeEach } from "vitest";

const postMessage = vi.fn();
const emitAgentReply = vi.fn();
const parseMentions = vi.fn();
const getRoom = vi.fn();

vi.mock("../src/communication/message-bus.js", () => ({ postMessage }));
vi.mock("../src/engine/agent-manager.js", () => ({ emitAgentReply }));
vi.mock("../src/communication/router.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseMentions,
}));
vi.mock("../src/workspace/room-store.js", () => ({ getRoom }));
vi.mock("../src/workspace/message-store.js", () => ({ getMessages: vi.fn(() => []), getMessagesByRange: vi.fn(() => []), addMessage: vi.fn() }));
vi.mock("../src/knowledge/store.js", () => ({ listEntries: vi.fn(() => []), addEntry: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn() }));

describe("chat tool textual @mention activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRoom.mockReturnValue({ id: "room-1", members: ["pm", "developer", "qa", "architect"] });
    parseMentions.mockReturnValue([]);
  });

  it("activates exact textual @mentions in room messages", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    parseMentions.mockReturnValue(["developer"]);
    const result = await handleToolCallback("response", "room-1", "architect", {
      message: "@developer please implement",
      target: "room",
    });

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer please implement", ["developer"]);
    expect(parseMentions).toHaveBeenCalledWith("@developer please implement", ["pm", "developer", "qa", "architect"]);
    expect(result).toEqual({ ok: true });
  });

  it("does not activate plain member names", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    parseMentions.mockReturnValue([]);
    const result = await handleToolCallback("response", "room-1", "architect", {
      message: "developer mentioned as reference",
      target: "room",
    });

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "developer mentioned as reference", []);
    expect(result).toEqual({ ok: true });
  });

  it("falls back to no activation when room lookup fails", async () => {
    const { handleToolCallback } = await import("../src/engine/tools.js");

    getRoom.mockReturnValue(null);
    const result = await handleToolCallback("response", "room-1", "architect", {
      message: "@developer",
      target: "room",
    });

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer", []);
    expect(result).toEqual({ ok: true });
  });
});
