import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => "/tmp/bossmode-test",
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToAgentSubscribers: vi.fn(),
}));

vi.mock("../../src/engine/agent-manager.js", () => ({
  refreshContextUsageOnIdle: vi.fn(),
}));

import { handleAgentEvent, type AgentHistoryEvent } from "../../src/engine/event-handler.js";

describe("event-handler status authority", () => {
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
});
