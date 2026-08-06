import { beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: (agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
}));

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  emitAgentReply: vi.fn(),
  getRoom: vi.fn(),
  parseMentions: vi.fn(),
}));

vi.mock("../../src/foundation/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../src/communication/message-bus.js", () => ({ postMessage: mocks.postMessage }));
vi.mock("../../src/workspace/room-store.js", () => ({ getRoom: mocks.getRoom }));
vi.mock("../../src/communication/router.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  parseMentions: mocks.parseMentions,
}));
vi.mock("../../src/engine/agent-manager.js", () => ({ emitAgentReply: mocks.emitAgentReply }));
vi.mock("../../src/workspace/message-store.js", () => ({ getMessages: vi.fn(() => []), getMessagesByRange: vi.fn(() => []), addMessage: vi.fn() }));
vi.mock("../../src/knowledge/store.js", () => ({
  addEntry: vi.fn(),
  listEntries: vi.fn(() => []),
  getDocumentTree: vi.fn(() => ({ path: "", name: "docs", kind: "folder", children: [] })),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));
vi.mock("../../src/communication/ws.js", () => ({ broadcastToRoom: vi.fn() }));

import { handleToolCallback } from "../../src/engine/tools.js";

describe("tools chat textual @mention activation", () => {
  beforeEach(() => {
    mocks.postMessage.mockReset();
    mocks.emitAgentReply.mockReset();
    mocks.getRoom.mockReset();
    mocks.parseMentions.mockReset();
    mocks.getRoom.mockReturnValue({ id: "room1", members: ["architect", "developer", "qa"] });
    mocks.parseMentions.mockReturnValue([]);
  });

  it("activates parsed @mentions from room message text", async () => {
    mocks.parseMentions.mockReturnValue(["developer"]);

    const result = await handleToolCallback("response", "room1", "architect", {
      message: "@developer please implement",
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "architect", "@developer please implement", ["developer"]);
    expect(result).toEqual({ ok: true });
  });

  it("passes all parsed exact @mentions", async () => {
    mocks.parseMentions.mockReturnValue(["developer", "qa"]);

    const result = await handleToolCallback("response", "room1", "architect", {
      message: "@developer @qa sync",
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "architect", "@developer @qa sync", ["developer", "qa"]);
    expect(result).toEqual({ ok: true });
  });

  it("falls back to no activation when room lookup fails", async () => {
    mocks.getRoom.mockReturnValue(null);

    const result = await handleToolCallback("response", "room1", "architect", {
      message: "@developer ping",
    });

    expect(mocks.postMessage).toHaveBeenCalledWith("room1", "architect", "@developer ping", []);
    expect(result).toEqual({ ok: true });
  });
});
