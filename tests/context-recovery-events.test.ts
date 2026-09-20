import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.node.js";
import { coreFixture } from "./helpers/core-fixture.js";
import { appendMemberEvent, handleAgentEvent, pageActivity, setContextUsageRefreshHook } from "../src/agent/events.js";
import { mapContextUsage, mapPiAgentEvent } from "../src/agent/runtime/events.js";
let ContextBoundaryCard: typeof import("../web/src/components/ActivityTab.js").ContextBoundaryCard;
beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  ({ ContextBoundaryCard } = await import("../web/src/components/ActivityTab.js"));
});
afterAll(() => vi.unstubAllGlobals());
import { eventSearchText, formatContextBoundaryPreview, isContextBoundaryEvent, summarizeAgentEvent } from "../web/src/components/agent-event-utils.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => {
  setContextUsageRefreshHook(undefined);
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const raw = {
  type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
  result: { summary: "Read your work log and chat history.", tokensBefore: 190_000, estimatedTokensAfter: 130 },
};

describe("context recovery facts and actual consumers", () => {
  it("uses separate live events without a summary-shaped payload", () => {
    expect(mapPiAgentEvent({ type: "compaction_start", reason: "threshold" }, { automaticRecovery: true })).toEqual({ type: "context_recovery_start", reason: "threshold" });
    const mapped = mapPiAgentEvent(raw, { automaticRecovery: true });
    expect(mapped).toEqual({ type: "context_recovery_end", reason: "threshold", aborted: false, willRetry: false,
      recoveryPrompt: raw.result.summary, tokensBefore: 190_000, estimatedTokensAfter: 130 });
    expect(mapped).not.toHaveProperty("result");
    expect(mapPiAgentEvent({ ...raw, reason: "manual" }, { automaticRecovery: true })?.type).toBe("compaction_end");
    expect(mapPiAgentEvent(raw)?.type).toBe("compaction_end");
  });

  it.each(["room:rm_test", "dm:mem_recovery", "mm:mem_other-mem_recovery", null])("replays recovery facts and refreshes context usage for %s", (sourceRef) => {
    const f = coreFixture(); fixtures.push(f);
    f.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      "mem_recovery", "Recovery", "recovery", "general", "{}", 1, 1);
    const refresh = vi.fn(); setContextUsageRefreshHook(refresh);
    appendMemberEvent({ memberId: "mem_recovery", sourceRef, event: { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, result: { summary: "Historical real summary" } } });
    const end = mapPiAgentEvent(raw, { automaticRecovery: true })!;
    handleAgentEvent(sourceRef, "Recovery", "mem_recovery", end, [], "mem_recovery");
    const page = pageActivity("mem_recovery", sourceRef ? { sourceRef } : {});
    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({ type: "compaction_end", result: { summary: "Historical real summary" } });
    expect(page.events[1]).toMatchObject({ type: "context_recovery_end", recoveryPrompt: raw.result.summary });
    expect(refresh).toHaveBeenCalledWith(sourceRef, "mem_recovery");
  });

  it("renders recovery in the shared Activity/river card without claiming completed work recovery", () => {
    const event = mapPiAgentEvent(raw, { automaticRecovery: true })!;
    const html = renderToStaticMarkup(createElement(ContextBoundaryCard, { event, time: "12:00", member: "Recovery" }));
    expect(html).toContain("RECOVERY REQUESTED");
    expect(html).not.toContain("COMPACTED");
    expect(html).not.toContain("CONTEXT RECOVERED");
    expect(isContextBoundaryEvent(event)).toBe(true);
    expect(eventSearchText(event)).toContain("work log");
    expect(formatContextBoundaryPreview(event)).toContain("recoveryPrompt");
    expect(formatContextBoundaryPreview(event)).not.toContain('"summary"');
    expect(summarizeAgentEvent({ type: "compaction_end", result: { summary: "Old summary" } }).label).toBe("COMPACTED · context");
  });

  it("separates fresh reset usage from manual/legacy compaction and clears the flag after new usage", () => {
    const empty = { tokens: null, percent: null, contextWindow: 200_000 };
    expect(mapContextUsage(empty, "model", true)).toMatchObject({ contextReset: true, totalTokens: 0 });
    expect(mapContextUsage(empty, "model", true)).not.toHaveProperty("compacted");
    expect(mapContextUsage(empty, "model")).toMatchObject({ compacted: true });
    expect(mapContextUsage({ ...empty, tokens: 500, percent: 0.25 }, "model", true)).not.toHaveProperty("contextReset");
  });

  it("reports cancellation and failure without falsely reporting recovery", () => {
    const cancelled = mapPiAgentEvent({ type: "compaction_end", reason: "overflow", aborted: true }, { automaticRecovery: true })!;
    const failed = mapPiAgentEvent({ type: "compaction_end", reason: "overflow", errorMessage: "Context overflow recovery failed after one compact-and-retry attempt." }, { automaticRecovery: true })!;
    expect(summarizeAgentEvent(cancelled).label).toBe("CONTEXT RESET CANCELLED");
    expect(summarizeAgentEvent(failed).label).toBe("CONTEXT RESET FAILED");
    expect(JSON.stringify(failed)).not.toContain("compact-and-retry");
  });
});
