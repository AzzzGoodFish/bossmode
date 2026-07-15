import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => "/tmp/bossmode-test",
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToAgentSubscribers: vi.fn(),
}));

const agentManagerMocks = vi.hoisted(() => ({
  refreshContextUsage: vi.fn(),
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  refreshContextUsage: agentManagerMocks.refreshContextUsage,
}));

import { handleAgentEvent, loadEventsFromDisk, type AgentHistoryEvent } from "../../src/engine/event-handler.js";
import { broadcastToAgentSubscribers } from "../../src/communication/ws.js";

describe("event-handler status authority", () => {
  beforeEach(() => {
    agentManagerMocks.refreshContextUsage.mockReset();
  });
  it("maps runtime agent_start to public working status", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:developer", { type: "agent_start" }, buffer);

    expect(status).toBe("working");
    expect(buffer).toContainEqual(expect.objectContaining({ type: "agent_start" }));
  });

  it("maps runtime agent_end to public idle status", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:developer", { type: "agent_end" }, buffer);

    expect(status).toBe("idle");
    expect(buffer).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("refreshes context usage on message_end before the turn ends", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:developer", { type: "message_end", text: "done" }, buffer, "rm_dev");

    expect(status).toBeUndefined();
    expect(agentManagerMocks.refreshContextUsage).toHaveBeenCalledWith("room1", "rm_dev");
  });

  it("forces and retries context usage refresh on compaction_end", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:developer", { type: "compaction_end", reason: "manual", aborted: false, willRetry: false }, buffer, "rm_dev");

    expect(status).toBeUndefined();
    expect(agentManagerMocks.refreshContextUsage).toHaveBeenCalledWith("room1", "rm_dev", { acceptCompactedSnapshot: true, retries: 3, retryDelayMs: 500 });
  });

  it("caps runtime errors before buffering, persistence, WS publication, and legacy reads", () => {
    const roomId = `error-cap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const memberId = "rm_dev";
    const eventsDir = join("/tmp/bossmode-test", "rooms", roomId, "agent-events");
    const path = join(eventsDir, `${memberId}.jsonl`);
    const errorMessage = "e".repeat(5_763);
    const buffer: AgentHistoryEvent[] = [];

    try {
      handleAgentEvent(roomId, "developer", `${roomId}:${memberId}`, { type: "message_end", text: "", stopReason: "error", errorMessage }, buffer, memberId);

      const buffered = buffer[0] as Extract<AgentHistoryEvent, { type: "message_end" }>;
      expect(Array.from(buffered.errorMessage || "")).toHaveLength(300);
      expect(buffered.errorMessage?.endsWith("…")).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf-8")).errorMessage).toBe(buffered.errorMessage);
      expect(broadcastToAgentSubscribers).toHaveBeenCalledWith(roomId, "developer", expect.objectContaining({
        event: expect.objectContaining({ errorMessage: buffered.errorMessage }),
      }));

      mkdirSync(eventsDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ type: "compaction_end", aborted: false, willRetry: false, errorMessage }) + "\n", "utf-8");
      const legacy = loadEventsFromDisk(roomId, memberId)[0] as Extract<AgentHistoryEvent, { type: "compaction_end" }>;
      expect(Array.from(legacy.errorMessage || "")).toHaveLength(300);
      expect(legacy.errorMessage?.endsWith("…")).toBe(true);
    } finally {
      rmSync(join("/tmp/bossmode-test", "rooms", roomId), { recursive: true, force: true });
    }
  });
});
