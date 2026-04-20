import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomMessage } from "../../src/shared/types.js";

const mocks = vi.hoisted(() => {
  const state = {
    roomMessages: [] as RoomMessage[],
    unsummarized: [] as RoomMessage[],
  };

  return {
    state,
    postMessage: vi.fn((roomId: string, sender: string, content: string) => {
      state.roomMessages.push({
        id: `sys-${state.roomMessages.length + 1}`,
        sender,
        content,
        mentions: [],
        ts: Date.now(),
      });
      return state.roomMessages[state.roomMessages.length - 1];
    }),
    getUnsummarizedMessages: vi.fn(() => state.unsummarized),
    readAllMessages: vi.fn(() => state.roomMessages),
    createAgent: vi.fn(),
  };
});

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn(() => ({
    id: "summarizer",
    name: "summarizer",
    type: "agent",
    agent: "summarizer",
    model: "haiku",
    runtime: "claude-cli",
    thinkingLevel: "off",
  })),
  saveMember: vi.fn(),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn(() => ({
    name: "summarizer",
    description: "summarizer",
    systemPrompt: "summarizer prompt",
  })),
}));

vi.mock("../../src/workspace/message-store.js", () => ({
  getUnsummarizedMessages: mocks.getUnsummarizedMessages,
  readAllMessages: mocks.readAllMessages,
}));

vi.mock("../../src/communication/message-bus.js", () => ({
  postMessage: mocks.postMessage,
  onMessage: vi.fn(() => () => {}),
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  getRegistry: vi.fn(() => ({
    get: vi.fn(() => ({
      createAgent: mocks.createAgent,
    })),
  })),
}));

vi.mock("../../src/shared/config.js", () => ({
  readConfig: vi.fn(() => ({ summary: { autoEnabled: false, threshold: 200, keepCount: 50 } })),
}));

import { summarizeRoom } from "../../src/engine/summarizer.js";

describe("summarizer completion messaging", () => {
  beforeEach(() => {
    mocks.state.roomMessages = [
      { id: "msg-1", sender: "user", content: "first", mentions: [], ts: 1 },
      { id: "msg-2", sender: "user", content: "second", mentions: [], ts: 2 },
    ];
    mocks.state.unsummarized = [
      { id: "msg-1", sender: "user", content: "first", mentions: [], ts: 1 },
      { id: "msg-2", sender: "user", content: "second", mentions: [], ts: 2 },
    ];
    mocks.postMessage.mockClear();
    mocks.getUnsummarizedMessages.mockClear();
    mocks.readAllMessages.mockClear();
    mocks.createAgent.mockClear();

    const handle = {
      prompt: vi.fn(async () => {
        mocks.state.roomMessages.push({
          id: "sum-1",
          sender: "summarizer",
          content: "summary 1",
          mentions: [],
          ts: Date.now(),
          type: "summary",
          summary_meta: {
            title: "topic 1",
            covered_range: { from_id: "msg-1", to_id: "msg-1", count: 1 },
            time_range: { from: 1, to: 1 },
            participants: ["user"],
          },
        });
        mocks.state.roomMessages.push({
          id: "sum-2",
          sender: "summarizer",
          content: "summary 2",
          mentions: [],
          ts: Date.now(),
          type: "summary",
          summary_meta: {
            title: "topic 2",
            covered_range: { from_id: "msg-2", to_id: "msg-2", count: 1 },
            time_range: { from: 2, to: 2 },
            participants: ["user"],
          },
        });
      }),
      waitForIdle: vi.fn(async () => {}),
      destroy: vi.fn(),
    };

    mocks.createAgent.mockResolvedValue(handle);
  });

  it("posts completion message with summary count after successful summarize", async () => {
    await summarizeRoom("room-1", 0);

    const completionCall = mocks.postMessage.mock.calls.find((call) =>
      String(call[2]).includes("Summarization complete:"),
    );

    expect(completionCall).toBeTruthy();
    expect(completionCall?.[2]).toBe("Summarization complete: 2 messages condensed into 2 summaries.");
  });

  it("posts zero-summary warning instead of success when no summaries are produced", async () => {
    const handle = {
      prompt: vi.fn(async () => {}),
      waitForIdle: vi.fn(async () => {}),
      destroy: vi.fn(),
    };
    mocks.createAgent.mockResolvedValueOnce(handle);

    await summarizeRoom("room-1", 0);

    const zeroSummaryCall = mocks.postMessage.mock.calls.find((call) =>
      String(call[2]).includes("Summarization produced no summaries."),
    );
    const successCall = mocks.postMessage.mock.calls.find((call) =>
      String(call[2]).includes("Summarization complete:"),
    );

    expect(zeroSummaryCall).toBeTruthy();
    expect(String(zeroSummaryCall?.[2])).toContain("Try again");
    expect(successCall).toBeUndefined();
  });
});
