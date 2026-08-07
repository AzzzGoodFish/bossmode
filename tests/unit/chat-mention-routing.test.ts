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
  addMessage: vi.fn(),
  broadcastToRoom: vi.fn(),
  getRoom: vi.fn(),
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/workspace/message-store.js", () => ({
  addMessage: mocks.addMessage,
  getMessages: vi.fn(() => []),
  getMessagesByRange: vi.fn(() => []),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: mocks.broadcastToRoom,
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: mocks.getRoom,
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  emitAgentReply: vi.fn(),
}));

vi.mock("../../src/knowledge/store.js", () => ({
  addEntry: vi.fn(),
  listEntries: vi.fn(() => []),
  getDocumentTree: vi.fn(() => ({ path: "", name: "docs", kind: "folder", children: [] })),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
}));

import { initRouter } from "../../src/communication/router.js";
import { deliverMemberMessage } from "../../src/engine/tools.js";

describe("chat mention routing", () => {
  let nextId = 1;

  beforeEach(() => {
    nextId = 1;
    mocks.broadcastToRoom.mockReset();
    mocks.getRoom.mockReset();
    mocks.getRoom.mockReturnValue({ id: "room1", members: ["architect", "developer", "qa"] });
    mocks.addMessage.mockImplementation((roomId: string, input: { sender: string; content: string; mentions?: string[] }) => ({
      id: `msg-${nextId++}`,
      sender: input.sender,
      content: input.content,
      mentions: input.mentions || [],
      ts: Date.now(),
    }));
  });

  it("activates exactly once when a member's final text mentions another member", async () => {
    const onMention = vi.fn();
    const onMentionAll = vi.fn();
    const unsubscribe = initRouter(onMention, onMentionAll);

    deliverMemberMessage("room1", "architect", "@developer please implement");

    expect(onMention).toHaveBeenCalledTimes(1);
    expect(onMention).toHaveBeenCalledWith("room1", "developer", expect.objectContaining({ senderName: "architect" }));
    expect(onMentionAll).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("filters self-mention and still allows cross-agent mention chain", async () => {
    const onMention = vi.fn();
    const onMentionAll = vi.fn();
    const unsubscribe = initRouter(onMention, onMentionAll);

    deliverMemberMessage("room1", "architect", "@architect self ping");

    deliverMemberMessage("room1", "developer", "@architect handing back");

    expect(onMention).toHaveBeenCalledTimes(1);
    expect(onMention).toHaveBeenCalledWith("room1", "architect", expect.objectContaining({ senderName: "developer" }));
    unsubscribe();
  });
});
