import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { handleAgentEvent, type AgentHistoryEvent } from "../../src/engine/event-handler.js";

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
});
