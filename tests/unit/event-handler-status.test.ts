import { coreFixture } from "../helpers/core-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { storeRoom } from "../../src/chat/conversations.js";
import { insertMemberIdentity } from "../../src/member/identity.js";
import { importAgentEvent, readAgentEvents } from "../../src/data/repositories/event-repository.js";

let fixture: ReturnType<typeof coreFixture>;



vi.mock("../../src/app/server/ws.js", () => ({
  broadcastToAgentSubscribers: vi.fn(),
}));

const agentManagerMocks = vi.hoisted(() => ({
  refreshContextUsage: vi.fn(),
}));

vi.mock("../../src/agent/orchestrator/agent-manager.js", () => ({
  refreshContextUsage: agentManagerMocks.refreshContextUsage,
}));

import { handleAgentEvent, loadEventsFromDisk, type AgentHistoryEvent } from "../../src/agent/events/event-handler.js";
import { broadcastToAgentSubscribers } from "../../src/app/server/ws.js";

describe("event-handler status authority", () => {
  beforeEach(() => {
    fixture = coreFixture();
    insertMemberIdentity({ id: "mem_dev", name: "developer", agentTemplate: "developer",
      global: {}, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 }, fixture.db);
    storeRoom({ id: "room1", name: "Room", members: ["developer"], globalMemberIds: ["mem_dev"], createdAt: 1 }, fixture.db);
    agentManagerMocks.refreshContextUsage.mockReset();
    vi.mocked(broadcastToAgentSubscribers).mockClear();
  });
  afterEach(async () => { await Promise.resolve(); fixture.close(); });
  it("maps runtime agent_start to public working status", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:mem_dev", { type: "agent_start" }, buffer, "mem_dev");

    expect(status).toBe("working");
    expect(buffer).toContainEqual(expect.objectContaining({ type: "agent_start" }));
  });

  it("maps runtime agent_end to public idle status", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:mem_dev", { type: "agent_end" }, buffer, "mem_dev");

    expect(status).toBe("idle");
    expect(buffer).toContainEqual(expect.objectContaining({ type: "agent_end" }));
  });

  it("refreshes context usage on message_end before the turn ends", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:mem_dev", { type: "message_end", text: "done" }, buffer, "mem_dev");

    expect(status).toBeUndefined();
    expect(agentManagerMocks.refreshContextUsage).toHaveBeenCalledWith("room1", "mem_dev");
  });

  it("forces and retries context usage refresh on compaction_end", () => {
    const buffer: AgentHistoryEvent[] = [];
    const status = handleAgentEvent("room1", "developer", "room1:mem_dev", { type: "compaction_end", reason: "manual", aborted: false, willRetry: false }, buffer, "mem_dev");

    expect(status).toBeUndefined();
    expect(agentManagerMocks.refreshContextUsage).toHaveBeenCalledWith("room1", "mem_dev", { acceptCompactedSnapshot: true, retries: 3, retryDelayMs: 500 });
  });

  it("stamps numeric ts on WS agent:event and SQL with the same identity", async () => {
    const roomId = "room1";
    const memberId = "mem_dev";
    const buffer: AgentHistoryEvent[] = [];
    vi.mocked(broadcastToAgentSubscribers).mockClear();

    handleAgentEvent(roomId, "developer", `${roomId}:${memberId}`, { type: "agent_start" }, buffer, memberId);

    await vi.waitFor(() => expect(broadcastToAgentSubscribers).toHaveBeenCalled());
    const wsPayload = vi.mocked(broadcastToAgentSubscribers).mock.calls.at(-1)?.[2] as { event?: { type?: string; ts?: number } };
    const wsTs = wsPayload?.event?.ts;
    expect(typeof wsTs).toBe("number");
    expect(Number.isFinite(wsTs)).toBe(true);
    expect(wsTs).toBeGreaterThan(0);

    const persisted = loadEventsFromDisk(roomId, memberId);
    const start = persisted.find((e) => e.type === "agent_start") as { ts?: number } | undefined;
    expect(start?.ts).toBe(wsTs);
    expect((buffer[0] as { ts?: number }).ts).toBe(wsTs);
  });

  it("does not overwrite an event that already carries ts", async () => {
    const roomId = "room1";
    const memberId = "mem_dev";
    const buffer: AgentHistoryEvent[] = [];
    const fixedTs = 1_700_000_000_123;
    vi.mocked(broadcastToAgentSubscribers).mockClear();

    handleAgentEvent(
      roomId,
      "developer",
      `${roomId}:${memberId}`,
      { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {}, ts: fixedTs } as any,
      buffer,
      memberId,
    );

    await vi.waitFor(() => expect(broadcastToAgentSubscribers).toHaveBeenCalled());
    const wsPayload = vi.mocked(broadcastToAgentSubscribers).mock.calls.at(-1)?.[2] as { event?: { ts?: number } };
    expect(wsPayload?.event?.ts).toBe(fixedTs);
    const persisted = loadEventsFromDisk(roomId, memberId);
    expect((persisted.find((e) => e.type === "tool_start") as { ts?: number } | undefined)?.ts).toBe(fixedTs);
  });

  it("caps runtime errors before buffering, persistence, WS publication, and imported historical reads", async () => {
    const roomId = "room1";
    const memberId = "mem_dev";
    const errorMessage = "e".repeat(5_763);
    const buffer: AgentHistoryEvent[] = [];

    handleAgentEvent(roomId, "developer", `${roomId}:${memberId}`, { type: "message_end", text: "", stopReason: "error", errorMessage }, buffer, memberId);

    const buffered = buffer[0] as Extract<AgentHistoryEvent, { type: "message_end" }>;
    expect(Array.from(buffered.errorMessage || "")).toHaveLength(300);
    expect(buffered.errorMessage?.endsWith("…")).toBe(true);
    const stored = readAgentEvents<{ errorMessage: string }>(roomId, memberId)[0];
    expect(stored.errorMessage).toBe(buffered.errorMessage);
    await vi.waitFor(() => expect(broadcastToAgentSubscribers).toHaveBeenCalled());
    expect(broadcastToAgentSubscribers).toHaveBeenCalledWith(roomId, "developer", expect.objectContaining({
      event: expect.objectContaining({ errorMessage: buffered.errorMessage }),
    }));

    // Historical payloads enter through the supported explicit importer, never a live JSONL reader.
    const historicalEvent = { type: "compaction_end", aborted: false, willRetry: false, errorMessage };
    importAgentEvent(fixture.db, { id: "historical-error", scopeId: roomId, ownerKey: "historical-developer",
      memberId: null, seq: 1, ts: 1, event: historicalEvent });
    expect(readAgentEvents(roomId, "historical-developer")).toEqual([historicalEvent]);
    const legacy = loadEventsFromDisk(roomId, "historical-developer")[0] as Extract<AgentHistoryEvent, { type: "compaction_end" }>;
    expect(Array.from(legacy.errorMessage || "")).toHaveLength(300);
    expect(legacy.errorMessage?.endsWith("…")).toBe(true);
  });
});
