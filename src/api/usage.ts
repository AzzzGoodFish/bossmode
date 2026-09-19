// Usage reports read authoritative SQL facts and stable identity metadata.
import { addRoute, sendJson } from "./http.js";
import { readUsageReport } from "../data/repositories/usage-repository.js";
import { getRoom } from "../chat/conversations.js";
import { logger } from "../kernel/logger.js";

interface RollupRow {
  member_id: string;
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  turns: number;
}

// Platform-level rollup row carries its room so cross-room aggregation can group
// by room without a second query.
interface RollupRowWithRoom extends RollupRow {
  room_id: string;
}

function cacheHitRate(inputTokens: number, cacheRead: number): number {
  const denom = inputTokens + cacheRead;
  return denom > 0 ? cacheRead / denom : 0;
}

function parseDate(v: string | null): string | undefined {
  if (!v) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
}

// UTC date helpers for zero-filling the series across every calendar day in the
// queried range (SQL GROUP BY only emits days with data → gaps in the chart).
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  // Guard against inverted/huge ranges: cap at 400 days.
  let guard = 0;
  while (d <= end && guard < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
    guard++;
  }
  return out;
}

/**
 * Fill missing calendar days in a series with empty points so the chart shows
 * one column per day across the whole range (7d → 7 columns, not "days with
 * data"). Preserves existing points; adds zero points for gaps.
 */
export function fillSeriesGaps(
  series: Array<{ date: string; cost: number; inputTokens: number; outputTokens: number; cacheRead: number; byModel: Record<string, unknown>; byAgent?: Record<string, number> }>,
  from: string | undefined,
  to: string | undefined,
): typeof series {
  // Determine the range: explicit from/to, else span the data (or today).
  const dates = series.map((s) => s.date).sort();
  const start = from || dates[0] || todayUtc();
  const end = to || todayUtc();
  if (!start || !end || start > end) return series;
  const byDate = new Map(series.map((s) => [s.date, s]));
  return eachDay(start, end).map(
    (date) => byDate.get(date) || { date, cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, byModel: {}, byAgent: {} },
  );
}

/**
 * Pure aggregation of rollup rows into the usage payload. Exported for focused
 * tests; the route handler wraps it with query + identity join.
 */
export function aggregateUsage(
  rows: RollupRow[],
  memberMeta: Map<string, { name: string; agent: string }>,
): { kpis: Kpis; series: any[]; breakdown: BreakdownRow[]; byAgent: AgentBucket[] } {
  const kpis = emptyKpis();
  for (const r of rows) {
    kpis.inputTokens += r.input_tokens;
    kpis.outputTokens += r.output_tokens;
    kpis.cacheRead += r.cache_read;
    kpis.cacheWrite += r.cache_write;
    kpis.cost += r.cost;
    kpis.turns += r.turns;
  }
  kpis.cacheHitRate = cacheHitRate(kpis.inputTokens, kpis.cacheRead);

  const seriesMap = new Map<
    string,
    { date: string; cost: number; inputTokens: number; outputTokens: number; cacheRead: number; byModel: Record<string, ModelBucket>; byAgent: Record<string, number> }
  >();
  for (const r of rows) {
    let s = seriesMap.get(r.date);
    if (!s) {
      s = { date: r.date, cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, byModel: {}, byAgent: {} };
      seriesMap.set(r.date, s);
    }
    s.cost += r.cost;
    s.inputTokens += r.input_tokens;
    s.outputTokens += r.output_tokens;
    s.cacheRead += r.cache_read;
    addToBucket((s.byModel[r.model] ||= emptyBucket()), r);
    // Per-day tokens by agent identity — drives the agent-colored trend (v3).
    const agent = memberMeta.get(r.member_id)?.agent || r.member_id;
    s.byAgent[agent] = (s.byAgent[agent] || 0) + r.input_tokens + r.output_tokens + r.cache_read + r.cache_write;
  }
  const series = [...seriesMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const breakdownMap = new Map<string, BreakdownRow>();
  for (const r of rows) {
    const key = `${r.member_id}\u0000${r.model}`;
    let b = breakdownMap.get(key);
    if (!b) {
      const meta = memberMeta.get(r.member_id);
      b = {
        memberId: r.member_id,
        memberName: meta?.name,
        agent: meta?.agent,
        model: r.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
      };
      breakdownMap.set(key, b);
    }
    b.inputTokens += r.input_tokens;
    b.outputTokens += r.output_tokens;
    b.cacheRead += r.cache_read;
    b.cacheWrite += r.cache_write;
    b.cost += r.cost;
    b.turns += r.turns;
  }
  const breakdown = [...breakdownMap.values()].sort((a, b) => b.inputTokens - a.inputTokens);

  const agentMap = new Map<string, AgentBucket>();
  for (const r of rows) {
    const agent = memberMeta.get(r.member_id)?.agent || r.member_id;
    let a = agentMap.get(agent);
    if (!a) {
      a = { agent, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      agentMap.set(agent, a);
    }
    a.inputTokens += r.input_tokens;
    a.outputTokens += r.output_tokens;
    a.cacheRead += r.cache_read;
    a.cacheWrite += r.cache_write;
    a.cost += r.cost;
    a.turns += r.turns;
  }
  const byAgent = [...agentMap.values()].sort((a, b) => b.inputTokens - a.inputTokens);

  return { kpis, series, breakdown, byAgent };
}

addRoute("GET", "/api/rooms/:id/usage", async (req, res, params) => {
  const roomId = params.id;
  const room = getRoom(roomId);
  if (!room) {
    sendJson(res, 404, { error: "room not found" });
    return;
  }

  const url = new URL(req.url || "", "http://localhost");
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  const memberFilter = url.searchParams.get("member") || undefined;
  const agentFilter = url.searchParams.get("agent") || undefined;
  const modelFilter = url.searchParams.get("model") || undefined;

  let report: ReturnType<typeof readUsageReport>;
  try { report = readUsageReport({scopeId: roomId, from, to, memberId: memberFilter, model: modelFilter}); }
  catch (err) {
    logger.error("db", "usage query failed", {roomId, error: String(err)});
    sendJson(res, 500, {error: "usage query failed"}); return;
  }
  const { memberMeta } = report;
  let rows = report.rows;

  // Join the stable member identity to its template after the SQL query:
  // keep only rows whose member maps to the requested agent — same mapping the
  // platform endpoint uses.
  if (agentFilter) {
    rows = rows.filter((r) => memberMeta.get(r.member_id)?.agent === agentFilter);
  }

  const agg = aggregateUsage(rows, memberMeta);

  sendJson(res, 200, {
    kpis: agg.kpis,
    series: fillSeriesGaps(agg.series, from, to),
    breakdown: agg.breakdown,
    byAgent: agg.byAgent,
  });
});

/**
 * Platform-level aggregation across all rooms. Same shape as aggregateUsage plus
 * a `byRoom` grouping (drives the prototype's "select agent → ring becomes By
 * room" layer). Identity join uses each room's own member→agent map.
 */
export function aggregatePlatformUsage(
  rows: RollupRowWithRoom[],
  memberMeta: Map<string, { name: string; agent: string }>,
  roomNames: Map<string, string>,
): {
  kpis: Kpis;
  series: any[];
  breakdown: BreakdownRow[];
  byAgent: AgentBucket[];
  byRoom: Array<{ roomId: string; roomName?: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }>;
} {
  // Reuse the single-room aggregation for kpis/series/breakdown/byAgent — the
  // member ids are globally unique (rm_<uuid>) so cross-room mixing is safe.
  const base = aggregateUsage(rows, memberMeta);

  const roomMap = new Map<string, { roomId: string; roomName?: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }>();
  for (const r of rows) {
    let rm = roomMap.get(r.room_id);
    if (!rm) {
      rm = { roomId: r.room_id, roomName: roomNames.get(r.room_id), inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
      roomMap.set(r.room_id, rm);
    }
    rm.inputTokens += r.input_tokens;
    rm.outputTokens += r.output_tokens;
    rm.cacheRead += r.cache_read;
    rm.cacheWrite += r.cache_write;
    rm.cost += r.cost;
    rm.turns += r.turns;
  }
  const byRoom = [...roomMap.values()].sort((a, b) => b.inputTokens - a.inputTokens);

  return { ...base, byRoom };
}

addRoute("GET", "/api/usage", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  const agentFilter = url.searchParams.get("agent") || undefined;
  const modelFilter = url.searchParams.get("model") || undefined;

  let report: ReturnType<typeof readUsageReport>;
  try { report = readUsageReport({from, to, model: modelFilter}); }
  catch (err) {
    logger.error("db", "platform usage query failed", {error: String(err)});
    sendJson(res, 500, {error: "usage query failed"}); return;
  }
  const { memberMeta, roomNames } = report;
  let rows = report.rows;

  // Keep only rows whose proven member ID maps to the requested template.
  if (agentFilter) {
    rows = rows.filter((r) => memberMeta.get(r.member_id)?.agent === agentFilter);
  }

  const { kpis, series, breakdown, byAgent, byRoom } = aggregatePlatformUsage(rows, memberMeta, roomNames);

  sendJson(res, 200, {
    kpis,
    series: fillSeriesGaps(series, from, to),
    breakdown,
    byAgent,
    byRoom,
  });
});

interface Kpis {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRate: number;
  turns: number;
}
function emptyKpis(): Kpis {
  return { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0, turns: 0 };
}

interface ModelBucket {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
}
function emptyBucket(): ModelBucket {
  return { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 };
}
function addToBucket(b: ModelBucket, r: RollupRow): void {
  b.cost += r.cost;
  b.inputTokens += r.input_tokens;
  b.outputTokens += r.output_tokens;
  b.cacheRead += r.cache_read;
}

interface BreakdownRow {
  memberId: string;
  memberName?: string;
  agent?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

interface AgentBucket {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
