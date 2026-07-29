// Usage view helpers (v4 split: Total / Trend) — pure date-range and series
// bucketing logic, extracted from UsagePage for focused tests.
//
// Total: free span — presets 7/30/90d, All time (no lower bound), or Custom.
// Trend: bounded span — quick 7/14/30d or a Custom range within the last
// TREND_LOOKBACK_DAYS days; > WEEKLY_THRESHOLD_DAYS days groups weekly.

export type TotalPreset = 7 | 30 | 90 | 0 | -1; // 0 = All time, -1 = Custom
export type TrendQuick = 7 | 14 | 30 | 0; // 0 = Custom

export const TREND_LOOKBACK_DAYS = 180;
export const WEEKLY_THRESHOLD_DAYS = 60;
export const TREND_MAX_TICKS = 10;

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** N-day span ending today, inclusive: 7d → today-6 … today. */
export function isoDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

/** Earliest selectable Trend custom date (TREND_LOOKBACK_DAYS-day window incl. today). */
export function minTrendDate(now: Date = new Date()): string {
  return isoDaysAgo(TREND_LOOKBACK_DAYS, now);
}

/** Swap an inverted range; otherwise pass through. */
export function sanitizeRange(from: string, to: string): { from: string; to: string } {
  return from > to ? { from: to, to: from } : { from, to };
}

export function daysInclusive(from: string, to: string): number {
  const ms = Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z");
  return Math.floor(ms / 86_400_000) + 1;
}

export interface TotalQuery {
  /** undefined = no lower bound (All time). */
  from?: string;
  to?: string;
  label: string;
}

/** Total tab → backend query params + readout label. All time omits `from`. */
export function resolveTotalQuery(
  preset: TotalPreset,
  customFrom: string,
  customTo: string,
  now: Date = new Date(),
): TotalQuery {
  if (preset === 0) return { to: todayIso(now), label: "All time" };
  if (preset === -1) {
    const { from, to } = sanitizeRange(customFrom, customTo);
    return { from, to, label: `${from} → ${to}` };
  }
  return { from: isoDaysAgo(preset, now), to: todayIso(now), label: `${preset}d` };
}

/** Trend tab → backend query params (always a concrete from/to). */
export function resolveTrendQuery(
  quick: TrendQuick,
  customFrom: string,
  customTo: string,
  now: Date = new Date(),
): { from: string; to: string } {
  if (quick !== 0) return { from: isoDaysAgo(quick, now), to: todayIso(now) };
  return sanitizeRange(customFrom, customTo);
}

export function shouldGroupWeekly(dayCount: number): boolean {
  return dayCount > WEEKLY_THRESHOLD_DAYS;
}

export interface SeriesPointLike {
  date: string;
  byAgent?: Record<string, number>;
}

export interface TrendBucket {
  /** First date of the bucket (x-axis label / tooltip). */
  label: string;
  /** Days included (1 = daily bucket). */
  dayCount: number;
  per: Record<string, number>;
}

/**
 * Bucket a daily zero-filled series for the trend chart: daily up to
 * WEEKLY_THRESHOLD_DAYS points, else 7-day chunks from the range start.
 */
export function bucketSeries(series: SeriesPointLike[], agents: string[]): { rows: TrendBucket[]; weekly: boolean } {
  const weekly = shouldGroupWeekly(series.length);
  const rows: TrendBucket[] = [];
  const chunk = weekly ? 7 : 1;
  for (let i = 0; i < series.length; i += chunk) {
    const days = series.slice(i, i + chunk);
    const per: Record<string, number> = {};
    for (const a of agents) per[a] = 0;
    for (const d of days) {
      for (const a of agents) per[a] += d.byAgent?.[a] || 0;
    }
    rows.push({ label: days[0].date, dayCount: days.length, per });
  }
  return { rows, weekly };
}

/**
 * X-axis tick indices: step back from the LAST bucket so the most recent date
 * is always labeled, even spacing, ≤ maxTicks, no collision.
 */
export function tickIndices(count: number, maxTicks: number = TREND_MAX_TICKS): number[] {
  if (count <= 0) return [];
  const interval = Math.max(1, Math.ceil(count / maxTicks));
  const out: number[] = [];
  for (let i = count - 1; i >= 0; i -= interval) out.unshift(i);
  return out;
}
