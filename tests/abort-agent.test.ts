vi.mock("../src/workforce/room-member-resolver.js", () => ({
  resolveRoomMember: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing agent-manager
vi.mock("../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn(),
}));



vi.mock("../src/shared/config.js", () => ({
  getBossmodeDir: () => "/tmp/bossmode-test",
}));

vi.mock("../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(),
  getCursors: vi.fn(() => ({})),
  setCursor: vi.fn(),
}));

vi.mock("../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({})),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../src/knowledge/store.js", () => ({
  listEntries: vi.fn(() => []),
  getEntry: vi.fn(),
}));

vi.mock("../src/communication/message-bus.js", () => ({
  postMessage: vi.fn(),
  getMessagesSince: vi.fn(() => []),
  getLatestMessageId: vi.fn(),
}));

vi.mock("../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
}));

vi.mock("../src/engine/prompt-assembler.js", () => ({
  buildAgentPrompt: vi.fn(() => ({ agentPrompt: "", envPrompt: "", fullPrompt: "" })),
}));

vi.mock("../src/engine/event-handler.js", () => ({
  handleAgentEvent: vi.fn(),
  loadEventsFromDisk: vi.fn(() => []),
  appendEventToDisk: vi.fn(),
}));

import { abortAgent } from "../src/engine/agent-manager.js";
import { broadcastToRoom } from "../src/communication/ws.js";

describe("abortAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_found when no instance exists", () => {
    const result = abortAgent("room1", "nonexistent");
    expect(result).toEqual({ ok: false, action: "not_found" });
  });

  it("returns already_idle for non-working agent (no instance = not_found)", () => {
    // Without a running instance, it's not_found
    const result = abortAgent("room1", "agent1");
    expect(result.ok).toBe(false);
    expect(result.action).toBe("not_found");
  });
});

describe("abortAgent — with mocked instances", () => {
  // Test the abort logic through the exported function by directly manipulating
  // the instances Map. We access it via a known activation flow.
  // Since we can't easily inject instances, we test the API route level in acceptance tests.
  // Here we verify the function signature and edge cases.

  it("abort function is exported and callable", () => {
    expect(typeof abortAgent).toBe("function");
  });

  it("returns correct shape for not_found", () => {
    const result = abortAgent("any-room", "any-agent");
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("action");
    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.action).toBe("string");
  });
});
