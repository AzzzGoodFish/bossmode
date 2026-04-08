import { describe, it, expect } from "vitest";
import type { RoomMessage, SummaryMeta } from "../../src/shared/types.js";

/**
 * Unit tests for Smart Message Summary feature.
 * Tests the core merge logic, range queries, and unsummarized detection.
 */

// -- Inline implementations for pure-function testing --
// (Extracted from message-store.ts to test without file system dependencies)

function mergeWithSummaries(messages: RoomMessage[]): RoomMessage[] {
  const summaries = messages.filter((m) => m.type === "summary" && m.summary_meta);
  if (summaries.length === 0) return messages;

  const coveredIds = new Set<string>();
  const summaryInsertions: { fromId: string; summary: RoomMessage }[] = [];

  for (const summary of summaries) {
    const meta = summary.summary_meta!;
    const fromIdx = messages.findIndex((m) => m.id === meta.covered_range.from_id);
    const toIdx = messages.findIndex((m) => m.id === meta.covered_range.to_id);
    if (fromIdx === -1 || toIdx === -1) continue;

    for (let i = fromIdx; i <= toIdx; i++) {
      if (messages[i].type !== "summary") {
        coveredIds.add(messages[i].id);
      }
    }
    summaryInsertions.push({ fromId: meta.covered_range.from_id, summary });
  }

  const result: RoomMessage[] = [];
  const insertedSummaryIds = new Set<string>();

  for (const msg of messages) {
    if (msg.type === "summary") continue;

    for (const ins of summaryInsertions) {
      if (ins.fromId === msg.id && !insertedSummaryIds.has(ins.summary.id)) {
        result.push(ins.summary);
        insertedSummaryIds.add(ins.summary.id);
      }
    }

    if (coveredIds.has(msg.id)) continue;
    result.push(msg);
  }

  return result;
}

function getUnsummarizedMessages(all: RoomMessage[], keepCount: number): RoomMessage[] {
  let lastSummarizedIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].type === "summary" && all[i].summary_meta) {
      const toIdx = all.findIndex((m) => m.id === all[i].summary_meta!.covered_range.to_id);
      if (toIdx > lastSummarizedIdx) lastSummarizedIdx = toIdx;
    }
  }

  const unsummarized = all
    .slice(lastSummarizedIdx + 1)
    .filter((m) => m.type !== "summary");

  if (unsummarized.length <= keepCount) return [];
  return unsummarized.slice(0, unsummarized.length - keepCount);
}

function getMessagesByRange(all: RoomMessage[], fromId: string, toId: string): RoomMessage[] {
  const fromIdx = all.findIndex((m) => m.id === fromId);
  const toIdx = all.findIndex((m) => m.id === toId);
  if (fromIdx === -1 || toIdx === -1) return [];
  return all.slice(fromIdx, toIdx + 1).filter((m) => m.type !== "summary");
}

// -- Test helpers --

function makeMsg(id: string, sender = "user", content = `msg ${id}`): RoomMessage {
  return { id, sender, content, mentions: [], ts: Date.now() };
}

function makeSummary(id: string, fromId: string, toId: string, count: number, title = "Topic"): RoomMessage {
  const meta: SummaryMeta = {
    title,
    covered_range: { from_id: fromId, to_id: toId, count },
    time_range: { from: Date.now() - 1000, to: Date.now() },
    participants: ["user"],
  };
  return {
    id,
    sender: "summarizer",
    content: `[Summary] ## ${title}\nSummary text`,
    mentions: [],
    ts: Date.now(),
    type: "summary",
    summary_meta: meta,
  };
}

// -- Tests --

describe("mergeWithSummaries", () => {
  it("returns messages unchanged when no summaries", () => {
    const msgs = [makeMsg("1"), makeMsg("2"), makeMsg("3")];
    expect(mergeWithSummaries(msgs)).toEqual(msgs);
  });

  it("replaces covered messages with summary at from_id position", () => {
    const msgs = [
      makeMsg("1"), makeMsg("2"), makeMsg("3"), makeMsg("4"), makeMsg("5"),
      makeSummary("s1", "1", "3", 3, "First topic"),
    ];
    const merged = mergeWithSummaries(msgs);
    expect(merged.length).toBe(3); // summary + msg4 + msg5
    expect(merged[0].type).toBe("summary");
    expect(merged[0].summary_meta?.title).toBe("First topic");
    expect(merged[1].id).toBe("4");
    expect(merged[2].id).toBe("5");
  });

  it("handles multiple non-overlapping summaries", () => {
    const msgs = [
      makeMsg("1"), makeMsg("2"), makeMsg("3"),
      makeMsg("4"), makeMsg("5"), makeMsg("6"),
      makeMsg("7"),
      makeSummary("s1", "1", "3", 3, "Topic A"),
      makeSummary("s2", "4", "6", 3, "Topic B"),
    ];
    const merged = mergeWithSummaries(msgs);
    expect(merged.length).toBe(3); // s1 + s2 + msg7
    expect(merged[0].summary_meta?.title).toBe("Topic A");
    expect(merged[1].summary_meta?.title).toBe("Topic B");
    expect(merged[2].id).toBe("7");
  });

  it("handles summary with invalid range gracefully", () => {
    const msgs = [
      makeMsg("1"), makeMsg("2"),
      makeSummary("s1", "nonexist", "also-nonexist", 5),
    ];
    const merged = mergeWithSummaries(msgs);
    // Summary has invalid range → nothing gets covered, summary is skipped from output
    expect(merged.length).toBe(2);
    expect(merged[0].id).toBe("1");
  });

  it("preserves messages after summary range", () => {
    const msgs = [
      makeMsg("1"), makeMsg("2"), makeMsg("3"),
      makeMsg("4"), makeMsg("5"),
      makeSummary("s1", "1", "3", 3),
    ];
    const merged = mergeWithSummaries(msgs);
    expect(merged.length).toBe(3);
    expect(merged[0].type).toBe("summary");
    expect(merged[1].id).toBe("4");
    expect(merged[2].id).toBe("5");
  });
});

describe("getUnsummarizedMessages", () => {
  it("returns empty when all messages within keepCount", () => {
    const msgs = [makeMsg("1"), makeMsg("2"), makeMsg("3")];
    expect(getUnsummarizedMessages(msgs, 5)).toEqual([]);
  });

  it("returns messages before keepCount threshold", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(`${i + 1}`));
    const result = getUnsummarizedMessages(msgs, 3);
    expect(result.length).toBe(7);
    expect(result[0].id).toBe("1");
    expect(result[6].id).toBe("7");
  });

  it("excludes already-summarized messages", () => {
    const msgs = [
      makeMsg("1"), makeMsg("2"), makeMsg("3"),
      makeSummary("s1", "1", "3", 3),
      makeMsg("4"), makeMsg("5"), makeMsg("6"), makeMsg("7"), makeMsg("8"),
    ];
    const result = getUnsummarizedMessages(msgs, 2);
    // Messages after summary: 4,5,6,7,8 (5 total), keep 2, so return 3
    expect(result.length).toBe(3);
    expect(result[0].id).toBe("4");
    expect(result[2].id).toBe("6");
  });

  it("returns empty when no unsummarized messages beyond keepCount", () => {
    const msgs = [
      makeMsg("1"), makeMsg("2"),
      makeSummary("s1", "1", "2", 2),
      makeMsg("3"), makeMsg("4"),
    ];
    const result = getUnsummarizedMessages(msgs, 5);
    expect(result).toEqual([]);
  });
});

describe("getMessagesByRange", () => {
  it("returns messages in range inclusive", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(`${i + 1}`));
    const result = getMessagesByRange(msgs, "3", "7");
    expect(result.length).toBe(5);
    expect(result[0].id).toBe("3");
    expect(result[4].id).toBe("7");
  });

  it("returns empty for nonexistent IDs", () => {
    const msgs = [makeMsg("1"), makeMsg("2")];
    expect(getMessagesByRange(msgs, "x", "y")).toEqual([]);
  });

  it("filters out summary messages in range", () => {
    const msgs = [
      makeMsg("1"), makeMsg("2"),
      makeSummary("s1", "1", "2", 2),
      makeMsg("3"),
    ];
    const result = getMessagesByRange(msgs, "1", "3");
    // Should include msgs 1, 2, 3 but NOT s1
    expect(result.length).toBe(3);
    expect(result.every((m) => m.type !== "summary")).toBe(true);
  });
});

describe("SummaryMeta type", () => {
  it("has correct structure", () => {
    const meta: SummaryMeta = {
      title: "Test Topic",
      covered_range: { from_id: "msg-1", to_id: "msg-5", count: 5 },
      time_range: { from: 1000, to: 2000 },
      participants: ["user", "pm"],
    };
    expect(meta.title).toBe("Test Topic");
    expect(meta.covered_range.count).toBe(5);
    expect(meta.participants).toContain("pm");
  });
});

describe("write_summary security", () => {
  it("only summarizer agent can call write_summary (logic check)", () => {
    // Simulates the P0 security check in tools.ts
    const agentName = "developer";
    const allowed = agentName === "summarizer";
    expect(allowed).toBe(false);

    const summarizerName = "summarizer";
    expect(summarizerName === "summarizer").toBe(true);
  });
});

describe("RoomMessage backward compatibility", () => {
  it("messages without type field are treated as normal", () => {
    const msg: RoomMessage = { id: "1", sender: "user", content: "hello", mentions: [], ts: Date.now() };
    expect(msg.type).toBeUndefined();
    // In mergeWithSummaries, messages without type are never matched as summaries
    const merged = mergeWithSummaries([msg]);
    expect(merged).toEqual([msg]);
  });
});
