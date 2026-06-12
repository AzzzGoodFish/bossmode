import { describe, it, expect, beforeAll, vi } from "vitest";

let getAgentHistorySyncPlan: typeof import("../../web/src/components/AgentTab").getAgentHistorySyncPlan;
let buildAgentHistoryState: typeof import("../../web/src/components/AgentTab").buildAgentHistoryState;
let getAgentTabHeaderControls: typeof import("../../web/src/components/AgentTab").getAgentTabHeaderControls;
let buildRawEventLines: typeof import("../../web/src/components/AgentTab").buildRawEventLines;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  ({ getAgentHistorySyncPlan, buildAgentHistoryState, getAgentTabHeaderControls, buildRawEventLines } = await import("../../web/src/components/AgentTab"));
}, 30000);

describe("agent tab history sync", () => {
  it("still fetches authoritative history even when cached events exist", () => {
    const plan = getAgentHistorySyncPlan([{ type: "agent_start", ts: 1 }]);

    expect(plan.showCachedImmediately).toBe(true);
    expect(plan.initialLoading).toBe(false);
    expect(plan.shouldFetchHistory).toBe(true);
  });

  it("marks agent as working when fetched history ends after agent_start without agent_end", () => {
    const state = buildAgentHistoryState([
      { type: "agent_start", ts: 1 },
      { type: "message_end", text: "Working...", ts: 2 },
    ]);

    expect(state.isWorking).toBe(true);
    expect(state.committed).toContainEqual(expect.objectContaining({ type: "agent_start" }));
    expect(state.committed).toContainEqual(expect.objectContaining({ type: "message", text: "Working..." }));
  });

  it("marks agent as idle when fetched history already includes agent_end", () => {
    const state = buildAgentHistoryState([
      { type: "agent_start", ts: 1 },
      { type: "agent_end", ts: 2 },
    ]);

    expect(state.isWorking).toBe(false);
    expect(state.committed).toEqual([
      expect.objectContaining({ type: "agent_start" }),
      expect.objectContaining({ type: "agent_end" }),
    ]);
  });

  it("builds raw rows from durable structured SDK events without CLI stdout/stderr", () => {
    const raw = buildRawEventLines([
      { type: "agent_start", ts: 1 },
      { type: "message_update", text: "hi", ts: 2 },
      { type: "tool_update", toolName: "read", toolCallId: "t1", partialResult: "delta", ts: 3 },
      { type: "tool_start", toolName: "read", toolCallId: "t1", args: { path: "x" }, ts: 4 },
      { type: "message_end", text: "done", ts: 5 },
    ]);

    expect(raw.map((line) => line.type)).toEqual(["agent_start", "tool_start", "message_end"]);
    expect(raw.some((line) => line.type === "message_update" || line.type === "tool_update")).toBe(false);
  });

  it("keeps legacy CLI stdout/stderr as raw event rows", () => {
    const raw = buildRawEventLines([{ type: "cli:stdout", text: "legacy", ts: 9 }]);

    expect(raw).toEqual([expect.objectContaining({ type: "cli:stdout", event: expect.objectContaining({ text: "legacy" }), ts: 9 })]);
  });

  it("keeps activity mode toggle visible while interrupt is available", () => {
    expect(getAgentTabHeaderControls("activity", true)).toEqual({
      showActivityModeToggle: true,
      showInterrupt: true,
    });
  });

  it("hides activity-only controls outside activity view", () => {
    expect(getAgentTabHeaderControls("chat", false)).toEqual({
      showActivityModeToggle: false,
      showInterrupt: false,
    });
    expect(getAgentTabHeaderControls("chat", true)).toEqual({
      showActivityModeToggle: false,
      showInterrupt: true,
    });
  });
});
