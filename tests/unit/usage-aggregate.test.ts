import { describe, expect, it } from "vitest";
import { aggregateUsage, aggregatePlatformUsage } from "../../src/api/usage.js";

// Pure-aggregation tests for the usage API. Covers KPIs, cacheHitRate formula,
// per-date series with byModel, member×model breakdown, and identity (byAgent)
// rollup — the three prototype dimensions.

type Row = {
  member_id: string;
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  turns: number;
};

function row(p: Partial<Row> & { member_id: string; date: string; model: string }): Row {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write: 0,
    cost: 0,
    turns: 1,
    ...p,
  };
}

const meta = new Map<string, { name: string; agent: string }>([
  ["rm_dev", { name: "developer", agent: "developer" }],
  ["rm_ben", { name: "dev-ben", agent: "developer" }], // same agent, different member
  ["rm_pm", { name: "pm", agent: "pm" }],
]);

describe("aggregateUsage", () => {
  it("computes KPIs and cacheHitRate = cacheRead/(input+cacheRead)", () => {
    const rows = [
      row({ member_id: "rm_dev", date: "2026-07-24", model: "a/x", input_tokens: 300, cache_read: 100, cost: 1, turns: 2 }),
    ];
    const { kpis } = aggregateUsage(rows, meta);
    expect(kpis.inputTokens).toBe(300);
    expect(kpis.cacheRead).toBe(100);
    expect(kpis.turns).toBe(2);
    expect(kpis.cacheHitRate).toBeCloseTo(100 / 400); // 0.25
  });

  it("cacheHitRate is 0 when there is no input/cache", () => {
    const { kpis } = aggregateUsage([], meta);
    expect(kpis.cacheHitRate).toBe(0);
  });

  it("builds a per-date series with byModel buckets, sorted by date", () => {
    const rows = [
      row({ member_id: "rm_dev", date: "2026-07-24", model: "a/x", input_tokens: 100, cost: 1 }),
      row({ member_id: "rm_pm", date: "2026-07-24", model: "b/y", input_tokens: 50, cost: 0.5 }),
      row({ member_id: "rm_dev", date: "2026-07-23", model: "a/x", input_tokens: 10 }),
    ];
    const { series } = aggregateUsage(rows, meta);
    expect(series.map((s: any) => s.date)).toEqual(["2026-07-23", "2026-07-24"]);
    const day24 = series.find((s: any) => s.date === "2026-07-24");
    expect(day24.inputTokens).toBe(150);
    expect(Object.keys(day24.byModel).sort()).toEqual(["a/x", "b/y"]);
    expect(day24.byModel["a/x"].inputTokens).toBe(100);
    expect(day24.byModel["b/y"].cost).toBeCloseTo(0.5);
  });

  it("breakdown is per member×model with joined name/agent, sorted desc by input", () => {
    const rows = [
      row({ member_id: "rm_dev", date: "2026-07-24", model: "a/x", input_tokens: 500 }),
      row({ member_id: "rm_dev", date: "2026-07-25", model: "a/x", input_tokens: 100 }), // same member+model → merged
      row({ member_id: "rm_pm", date: "2026-07-24", model: "b/y", input_tokens: 200 }),
    ];
    const { breakdown } = aggregateUsage(rows, meta);
    expect(breakdown.length).toBe(2);
    expect(breakdown[0].memberId).toBe("rm_dev");
    expect(breakdown[0].memberName).toBe("developer");
    expect(breakdown[0].agent).toBe("developer");
    expect(breakdown[0].inputTokens).toBe(600); // merged across dates
    expect(breakdown[1].memberId).toBe("rm_pm");
  });

  it("byAgent aggregates members sharing the same sourceAgent", () => {
    const rows = [
      row({ member_id: "rm_dev", date: "2026-07-24", model: "a/x", input_tokens: 300 }),
      row({ member_id: "rm_ben", date: "2026-07-24", model: "a/x", input_tokens: 200 }), // agent=developer
      row({ member_id: "rm_pm", date: "2026-07-24", model: "b/y", input_tokens: 100 }),
    ];
    const { byAgent } = aggregateUsage(rows, meta);
    const dev = byAgent.find((a: any) => a.agent === "developer");
    const pm = byAgent.find((a: any) => a.agent === "pm");
    expect(dev.inputTokens).toBe(500); // rm_dev + rm_ben merged into developer
    expect(pm.inputTokens).toBe(100);
    // sorted desc by input
    expect(byAgent[0].agent).toBe("developer");
  });

  it("falls back to member_id as agent label when unmapped", () => {
    const rows = [row({ member_id: "rm_ghost", date: "2026-07-24", model: "a/x", input_tokens: 5 })];
    const { byAgent, breakdown } = aggregateUsage(rows, meta);
    expect(byAgent[0].agent).toBe("rm_ghost");
    expect(breakdown[0].memberName).toBeUndefined();
  });
});

describe("aggregatePlatformUsage (cross-room)", () => {
  const roomNames = new Map<string, string>([
    ["room-a", "bossmode dev"],
    ["room-b", "test room"],
  ]);

  function roomRow(p: Partial<Row> & { room_id: string; member_id: string; date: string; model: string }) {
    return { ...row(p), room_id: p.room_id } as any;
  }

  it("groups usage by room and aggregates identity across rooms", () => {
    const rows = [
      roomRow({ room_id: "room-a", member_id: "rm_dev", date: "2026-07-24", model: "a/x", input_tokens: 300 }),
      roomRow({ room_id: "room-b", member_id: "rm_dev", date: "2026-07-24", model: "a/x", input_tokens: 100 }),
      roomRow({ room_id: "room-a", member_id: "rm_pm", date: "2026-07-24", model: "b/y", input_tokens: 50 }),
    ];
    const { byRoom, byAgent, kpis } = aggregatePlatformUsage(rows, meta, roomNames);

    // byRoom groups + carries names, sorted desc by input.
    expect(byRoom.map((r: any) => r.roomId)).toEqual(["room-a", "room-b"]);
    expect(byRoom[0].roomName).toBe("bossmode dev");
    expect(byRoom[0].inputTokens).toBe(350); // rm_dev 300 + rm_pm 50
    expect(byRoom[1].inputTokens).toBe(100);

    // Identity aggregates the SAME agent across both rooms.
    const dev = byAgent.find((a: any) => a.agent === "developer");
    expect(dev.inputTokens).toBe(400); // rm_dev across room-a + room-b
    expect(kpis.inputTokens).toBe(450);
  });

  it("leaves roomName undefined for unknown rooms", () => {
    const rows = [roomRow({ room_id: "room-x", member_id: "rm_dev", date: "2026-07-24", model: "a/x", input_tokens: 10 })];
    const { byRoom } = aggregatePlatformUsage(rows, meta, roomNames);
    expect(byRoom[0].roomName).toBeUndefined();
  });
});
