/**
 * 0.20 read-side key merge (pre-F5 bridge) — a member's stats/events may exist
 * under mem_ id, legacy rm_ room-member id, or bare name keys in the same
 * room. Reads merge across every existing form so pre-0.20 history stays
 * visible on the unified panel (designer alignment finding: fish's dev room
 * showed "0 turns" with 25k lines of name-keyed history on disk).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

const ROOM = "room-1";

function seedStats(ref: string, turns: number, cost = 0) {
  const d = join(dir, "rooms", ROOM, "agent-events");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${ref}.stats.json`), JSON.stringify({ turns, toolCalls: turns, activeMs: turns * 10, tokens: { input: turns, output: turns, cacheRead: 0, cacheWrite: 0 }, cost }), "utf-8");
}

function seedEvents(ref: string, events: Array<{ type: string; ts: number; text?: string }>) {
  const d = join(dir, "rooms", ROOM, "agent-events");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${ref}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

describe("member artifact key merge (pre-F5)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-keymerge-"));
    vi.resetModules();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("listMemberArtifactRefs finds every key form, mem_ first", async () => {
    const { listMemberArtifactRefs } = await import("../../src/workspace/member-artifact-refs.js");
    seedStats("mem_aaa", 1);
    seedStats("rm_bbb", 1);
    seedEvents("architect", [{ type: "agent_start", ts: 1 }]);
    seedStats("unrelated", 99);

    const refs = listMemberArtifactRefs(ROOM, [{ id: "mem_aaa", name: "architect" }, { id: "rm_bbb", name: "architect" }]);
    expect(refs).toEqual(["mem_aaa", "architect", "rm_bbb"]);
  });

  it("missing agent-events dir → empty refs", async () => {
    const { listMemberArtifactRefs } = await import("../../src/workspace/member-artifact-refs.js");
    expect(listMemberArtifactRefs("no-such-room", [{ id: "mem_x", name: "n" }])).toEqual([]);
  });

  it("readMemberStatsMerged sums across key forms", async () => {
    const { readMemberStatsMerged } = await import("../../src/workspace/member-stats-store.js");
    seedStats("mem_aaa", 5, 0.5);
    seedStats("architect", 20, 1.5);
    const merged = readMemberStatsMerged(ROOM, ["mem_aaa", "architect"]);
    expect(merged.turns).toBe(25);
    expect(merged.toolCalls).toBe(25);
    expect(merged.activeMs).toBe(250);
    expect(merged.tokens.input).toBe(25);
    expect(merged.cost).toBe(2);
  });

  it("loadEventsPaginatedMerged ts-orders the union and windows by index cursor", async () => {
    const { loadEventsPaginatedMerged } = await import("../../src/engine/event-handler.js");
    seedEvents("architect", [
      { type: "agent_start", ts: 1000 },
      { type: "agent_reply", ts: 3000, text: "old reply" },
    ]);
    seedEvents("mem_aaa", [
      { type: "agent_start", ts: 2000 },
      { type: "agent_reply", ts: 4000, text: "new reply" },
    ]);

    const page1 = loadEventsPaginatedMerged(ROOM, ["mem_aaa", "architect"], 3);
    expect(page1.total).toBe(4);
    expect(page1.hasMore).toBe(true);
    expect(page1.events.map((e) => (e as { ts?: number }).ts)).toEqual([2000, 3000, 4000]);

    const page2 = loadEventsPaginatedMerged(ROOM, ["mem_aaa", "architect"], 3, page1.total - page1.events.length);
    expect(page2.hasMore).toBe(false);
    expect(page2.events.map((e) => (e as { ts?: number }).ts)).toEqual([1000]);
  });
});
