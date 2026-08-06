import { describe, it, expect, vi, beforeEach } from "vitest";

const postMessage = vi.hoisted(() => vi.fn());
const emitAgentReply = vi.hoisted(() => vi.fn());
const parseMentions = vi.hoisted(() => vi.fn());
const getRoom = vi.hoisted(() => vi.fn());

vi.mock("../src/communication/message-bus.js", () => ({ postMessage }));
vi.mock("../src/engine/agent-manager.js", () => ({ emitAgentReply }));
vi.mock("../src/communication/router.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseMentions,
}));
vi.mock("../src/workspace/room-store.js", () => ({ getRoom }));
vi.mock("../src/workspace/message-store.js", () => ({ getMessages: vi.fn(() => []), getMessagesByRange: vi.fn(() => []), addMessage: vi.fn() }));
vi.mock("../src/knowledge/store.js", () => ({ listEntries: vi.fn(() => []), addEntry: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn() }));

import { deliverMemberMessage } from "../src/engine/tools.js";

describe("chat tool textual @mention activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRoom.mockReturnValue({ id: "room-1", members: ["pm", "developer", "qa", "architect"] });
    parseMentions.mockReturnValue([]);
  });

  it("activates exact textual @mentions in room messages", () => {
    parseMentions.mockReturnValue(["developer"]);
    deliverMemberMessage("room-1", "architect", "@developer please implement");

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer please implement", ["developer"]);
    expect(parseMentions).toHaveBeenCalledWith("@developer please implement", ["pm", "developer", "qa", "architect"]);
  });

  it("does not activate plain member names", () => {
    parseMentions.mockReturnValue([]);
    deliverMemberMessage("room-1", "architect", "developer mentioned as reference");

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "developer mentioned as reference", []);
  });

  it("falls back to no activation when room lookup fails", () => {
    getRoom.mockReturnValue(null);
    deliverMemberMessage("room-1", "architect", "@developer");

    expect(postMessage).toHaveBeenCalledWith("room-1", "architect", "@developer", []);
  });

});
