import { describe, expect, it } from "vitest";
import {
  bucketSeries,
  daysInclusive,
  isoDaysAgo,
  minTrendDate,
  resolveTotalQuery,
  resolveTrendQuery,
  sanitizeRange,
  shouldGroupWeekly,
  tickIndices,
  TREND_LOOKBACK_DAYS,
  WEEKLY_THRESHOLD_DAYS,
} from "../../web/src/utils/usage-view.js";

const NOW = new Date("2026-07-29T08:00:00Z");

describe("usage-view date ranges", () => {
  it("isoDaysAgo spans N days inclusive of today", () => {
    expect(isoDaysAgo(7, NOW)).toBe("2026-07-23");
    expect(isoDaysAgo(1, NOW)).toBe("2026-07-29");
    expect(isoDaysAgo(30, NOW)).toBe("2026-06-30");
  });

  it("minTrendDate is the lookback window start", () => {
    expect(minTrendDate(NOW)).toBe(isoDaysAgo(TREND_LOOKBACK_DAYS, NOW));
    expect(daysInclusive(minTrendDate(NOW), "2026-07-29")).toBe(TREND_LOOKBACK_DAYS);
  });

  it("sanitizeRange swaps inverted ranges", () => {
    expect(sanitizeRange("2026-07-20", "2026-07-10")).toEqual({ from: "2026-07-10", to: "2026-07-20" });
    expect(sanitizeRange("2026-07-10", "2026-07-20")).toEqual({ from: "2026-07-10", to: "2026-07-20" });
  });

  it("daysInclusive counts both ends", () => {
    expect(daysInclusive("2026-07-23", "2026-07-29")).toBe(7);
    expect(daysInclusive("2026-07-29", "2026-07-29")).toBe(1);
  });

  it("resolveTotalQuery presets map to bounded spans", () => {
    expect(resolveTotalQuery(7, "", "", NOW)).toEqual({ from: "2026-07-23", to: "2026-07-29", label: "7d" });
    expect(resolveTotalQuery(90, "", "", NOW).label).toBe("90d");
  });

  it("resolveTotalQuery All time has no lower bound", () => {
    const q = resolveTotalQuery(0, "", "", NOW);
    expect(q.from).toBeUndefined();
    expect(q.label).toBe("All time");
  });

  it("resolveTotalQuery Custom uses the picked range (sanitized) and labels it", () => {
    const q = resolveTotalQuery(-1, "2026-06-20", "2026-06-01", NOW);
    expect(q).toEqual({ from: "2026-06-01", to: "2026-06-20", label: "2026-06-01 → 2026-06-20" });
  });

  it("resolveTrendQuery quick presets recompute from today; custom passes through sanitized", () => {
    expect(resolveTrendQuery(14, "2026-01-01", "2026-01-02", NOW)).toEqual({ from: "2026-07-16", to: "2026-07-29" });
    expect(resolveTrendQuery(0, "2026-05-10", "2026-05-01", NOW)).toEqual({ from: "2026-05-01", to: "2026-05-10" });
  });
});

describe("usage-view weekly bucketing", () => {
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      byAgent: { developer: i + 1, qa: 2 },
    }));

  it("daily up to the threshold, weekly above it", () => {
    expect(shouldGroupWeekly(WEEKLY_THRESHOLD_DAYS)).toBe(false);
    expect(shouldGroupWeekly(WEEKLY_THRESHOLD_DAYS + 1)).toBe(true);
    expect(bucketSeries(series(30), ["developer", "qa"]).weekly).toBe(false);
    expect(bucketSeries(series(61), ["developer", "qa"]).weekly).toBe(true);
  });

  it("weekly mode chunks 7 days from the range start and sums per agent", () => {
    const { rows, weekly } = bucketSeries(series(15), ["developer", "qa"]);
    expect(weekly).toBe(false); // 15 ≤ 60 → daily
    const w = bucketSeries(series(70), ["developer", "qa"]);
    expect(w.weekly).toBe(true);
    expect(w.rows.length).toBe(10); // 70 / 7
    expect(w.rows[0].label).toBe("2026-05-01");
    expect(w.rows[0].dayCount).toBe(7);
    expect(w.rows[0].per.developer).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7);
    expect(w.rows[0].per.qa).toBe(14);
  });

  it("last weekly bucket may be partial", () => {
    const { rows } = bucketSeries(series(65), ["developer"]);
    expect(rows.length).toBe(10); // 9 full weeks + 2 days
    expect(rows[9].dayCount).toBe(2);
  });

  it("agents missing from a day contribute zero", () => {
    const { rows } = bucketSeries([{ date: "2026-07-01", byAgent: { qa: 5 } }], ["developer", "qa"]);
    expect(rows[0].per).toEqual({ developer: 0, qa: 5 });
  });
});

describe("usage-view x ticks", () => {
  it("last bucket always labeled, ≤ maxTicks, ascending", () => {
    const ticks = tickIndices(30);
    expect(ticks[ticks.length - 1]).toBe(29);
    expect(ticks.length).toBeLessThanOrEqual(10);
    expect([...ticks]).toEqual([...ticks].sort((a, b) => a - b));
  });

  it("small series labels every bucket", () => {
    expect(tickIndices(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("long weekly series stays within budget", () => {
    const ticks = tickIndices(26); // ~180 days weekly
    expect(ticks.length).toBeLessThanOrEqual(10);
    expect(ticks[ticks.length - 1]).toBe(25);
  });

  it("empty series → no ticks", () => {
    expect(tickIndices(0)).toEqual([]);
  });
});
