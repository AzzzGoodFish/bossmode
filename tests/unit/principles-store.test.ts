import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-principles-"));
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("principles-store", () => {
  it("returns empty revision 0 for missing principles", async () => {
    const { readPrinciples } = await import("../../src/workspace/principles-store.js");
    const result = readPrinciples("room-a", "member", "rm_1");
    expect(result.content).toBe("");
    expect(result.revision).toBe(0);
  });

  it("writes metadata and increments revision", async () => {
    const { writePrinciples, readPrinciples } = await import("../../src/workspace/principles-store.js");
    const saved = writePrinciples({ roomId: "room-a", scope: "room", content: "## Rules\n- One", actor: { type: "member", memberId: "rm_1", name: "pm" }, reason: "initial" });
    expect(saved.revision).toBe(1);
    expect(saved.contentLength).toBe(saved.content.length);
    const read = readPrinciples("room-a", "room");
    expect(read.content).toContain("One");
    expect(read.updatedByMemberId).toBe("rm_1");
  });

  it("requires a non-empty reason on write and edit", async () => {
    const { writePrinciples, editPrinciples } = await import("../../src/workspace/principles-store.js");
    expect(() => writePrinciples({ roomId: "room-a", scope: "room", content: "x", actor: { type: "member" }, reason: "" })).toThrow(/reason is required/);
    writePrinciples({ roomId: "room-a", scope: "room", content: "alpha", actor: { type: "member" }, reason: "seed" });
    expect(() => editPrinciples({ roomId: "room-a", scope: "room", oldText: "alpha", newText: "beta", actor: { type: "member" }, reason: "  " })).toThrow(/reason is required/);
  });

  it("edits exactly one match", async () => {
    const { writePrinciples, editPrinciples } = await import("../../src/workspace/principles-store.js");
    writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", content: "alpha beta", actor: { type: "member", memberId: "rm_1" }, reason: "seed" });
    const edited = editPrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", oldText: "beta", newText: "gamma", actor: { type: "member", memberId: "rm_1" }, reason: "user feedback" });
    expect(edited.content).toBe("alpha gamma");
    expect(edited.revision).toBe(2);
  });

  it("rejects zero and multiple edit matches", async () => {
    const { writePrinciples, editPrinciples } = await import("../../src/workspace/principles-store.js");
    writePrinciples({ roomId: "room-a", scope: "room", content: "x x", actor: { type: "member" }, reason: "seed" });
    expect(() => editPrinciples({ roomId: "room-a", scope: "room", oldText: "z", newText: "a", actor: { type: "member" }, reason: "r" })).toThrow(/not found/);
    expect(() => editPrinciples({ roomId: "room-a", scope: "room", oldText: "x", newText: "a", actor: { type: "member" }, reason: "r" })).toThrow(/multiple/);
  });

  it("enforces per-scope budgets (member 4K / room 8K)", async () => {
    const { writePrinciples, PRINCIPLES_MEMBER_MAX_CHARS, PRINCIPLES_ROOM_MAX_CHARS } = await import("../../src/workspace/principles-store.js");
    expect(PRINCIPLES_MEMBER_MAX_CHARS).toBe(4_000);
    expect(PRINCIPLES_ROOM_MAX_CHARS).toBe(8_000);
    expect(() => writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", content: "x".repeat(4_001), actor: { type: "member" }, reason: "r" })).toThrow(/exceed its budget/);
    expect(() => writePrinciples({ roomId: "room-a", scope: "room", content: "x".repeat(8_001), actor: { type: "member" }, reason: "r" })).toThrow(/exceed its budget/);
    writePrinciples({ roomId: "room-a", scope: "room", content: "x".repeat(8_000), actor: { type: "member" }, reason: "at limit" });
  });

  it("budget error carries current full content for same-turn curation", async () => {
    const { writePrinciples, AssetBudgetError } = await import("../../src/workspace/principles-store.js");
    writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", content: "existing rules", actor: { type: "member" }, reason: "seed" });
    try {
      writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", content: "y".repeat(5_000), actor: { type: "member" }, reason: "too big" });
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(AssetBudgetError);
      expect(err.currentContent).toBe("existing rules");
      expect(err.message).toContain("existing rules");
      expect(err.message).toMatch(/Curate now/);
      // Failed write must not persist
    }
    const { readPrinciples } = await import("../../src/workspace/principles-store.js");
    expect(readPrinciples("room-a", "member", "rm_1").content).toBe("existing rules");
  });

  it("grandfathered over-budget content is flagged, not cut; a curating write is accepted", async () => {
    const { writePrinciples, readPrinciplesWithBudget, editPrinciples } = await import("../../src/workspace/principles-store.js");
    // Simulate a legacy 20K-era asset by writing under the limit then inflating the file on disk
    writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", content: "seed", actor: { type: "member" }, reason: "seed" });
    const path = join(tmpDir, "rooms", "room-a", "memory", "members", "rm_1", "principles.md");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "UNIQUE-" + "x".repeat(4_993), "utf-8");
    const flagged = readPrinciplesWithBudget("room-a", "member", "rm_1");
    expect(flagged.budget.overLimit).toBe(true);
    expect(flagged.budget.pct).toBe(125);
    // Edits that stay over budget are rejected with the current content
    expect(() => editPrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", oldText: "UNIQUE", newText: "UNIQUE-YY", actor: { type: "member" }, reason: "r" })).toThrow(/exceed its budget/);
    // A curating write that lands within budget is accepted
    const curated = writePrinciples({ roomId: "room-a", scope: "member", memberId: "rm_1", content: "curated rules", actor: { type: "member" }, reason: "curation after budget introduction" });
    expect(curated.content).toBe("curated rules");
    expect(readPrinciplesWithBudget("room-a", "member", "rm_1").budget.overLimit).toBe(false);
  });

  it("stores a content snapshot and reason in history for every revision", async () => {
    const { writePrinciples } = await import("../../src/workspace/principles-store.js");
    writePrinciples({ roomId: "room-a", scope: "room", content: "v1 content", actor: { type: "member", memberId: "rm_1" }, reason: "first" });
    writePrinciples({ roomId: "room-a", scope: "room", content: "v2 content", actor: { type: "user" }, reason: "user correction" });
    const { readFileSync } = await import("node:fs");
    const history = readFileSync(join(tmpDir, "rooms", "room-a", "memory", "principles-history.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe("v1 content");
    expect(history[0].reason).toBe("first");
    expect(history[1].content).toBe("v2 content");
    expect(history[1].reason).toBe("user correction");
    expect(history[1].revision).toBe(2);
  });

  it("computes budget headers in the plan format", async () => {
    const { computeAssetBudget, formatBudgetHeader } = await import("../../src/workspace/principles-store.js");
    expect(formatBudgetHeader(computeAssetBudget(1_340, 4_000))).toBe("34% — 1,340/4,000");
    expect(formatBudgetHeader(computeAssetBudget(19_900, 4_000))).toContain("498% — 19,900/4,000");
    expect(formatBudgetHeader(computeAssetBudget(19_900, 4_000))).toContain("pending curation");
  });
});
