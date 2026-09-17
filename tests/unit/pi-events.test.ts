import { describe, expect, it } from "vitest";
import { mapPiAgentEvent } from "../../src/agent/runtime/events.js";

describe("pi event mapping", () => {
  it("maps compaction lifecycle events", () => {
    expect(mapPiAgentEvent({ type: "compaction_start", reason: "threshold" })).toEqual({
      type: "compaction_start",
      reason: "threshold",
    });

    expect(mapPiAgentEvent({ type: "compaction_end", reason: "threshold", result: { summary: "done", tokensBefore: 28100 }, aborted: false, willRetry: false })).toEqual({
      type: "compaction_end",
      reason: "threshold",
      aborted: false,
      willRetry: false,
      tokensBefore: 28100,
      result: { summary: "done", tokensBefore: 28100 },
    });
  });

  it("maps failed and aborted compaction end events", () => {
    expect(mapPiAgentEvent({ type: "compaction_end", reason: "overflow", aborted: true, willRetry: false })).toEqual({
      type: "compaction_end",
      reason: "overflow",
      aborted: true,
      willRetry: false,
    });

    expect(mapPiAgentEvent({ type: "compaction_end", reason: "manual", errorMessage: "compact failed", aborted: false, willRetry: true })).toEqual({
      type: "compaction_end",
      reason: "manual",
      aborted: false,
      willRetry: true,
      errorMessage: "compact failed",
    });
  });
});
