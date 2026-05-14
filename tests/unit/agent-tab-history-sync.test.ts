import { describe, it, expect, beforeAll, vi } from "vitest";

let getAgentHistorySyncPlan: typeof import("../../web/src/components/AgentTab").getAgentHistorySyncPlan;
let buildAgentHistoryState: typeof import("../../web/src/components/AgentTab").buildAgentHistoryState;
let getAgentTabHeaderControls: typeof import("../../web/src/components/AgentTab").getAgentTabHeaderControls;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  ({ getAgentHistorySyncPlan, buildAgentHistoryState, getAgentTabHeaderControls } = await import("../../web/src/components/AgentTab"));
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
