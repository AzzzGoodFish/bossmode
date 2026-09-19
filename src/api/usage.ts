// Usage reports read authoritative SQL facts and stable identity metadata.
import { addRoute, sendJson } from "./http.js";
import { getRoom, listRooms } from "../chat/conversations.js";
import { getRetainedMember } from "../member/identity.js";

export interface UsageFactRow {
  memberId: string | null;
  historicalOwnerKey: string | null;
  sourceRef: string | null;
  historicalSourceKey: string | null;
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
export interface UsageHttpQueries {
  readUsageRows(options?: { from?: string; to?: string; sourceRef?: string }): UsageFactRow[];
}
let usageQueries: UsageHttpQueries | undefined;
export function connectUsageHttpQueries(queries: UsageHttpQueries): () => void {
  usageQueries = queries;
  return () => { if (usageQueries === queries) usageQueries = undefined; };
}

// Platform-level rollup row carries its room so cross-room aggregation can group
// by room without a second query.
interface UsageReportRow extends UsageFactRow {
  roomId: string;
}

interface UsageTotals { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }
function emptyTotals(): UsageTotals { return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }; }
function addTotals(total: UsageTotals, row: UsageFactRow): void {
  total.inputTokens += row.inputTokens; total.outputTokens += row.outputTokens;
  total.cacheRead += row.cacheRead; total.cacheWrite += row.cacheWrite;
  total.cost += row.cost; total.turns += row.turns;
}
function grouped<R extends UsageFactRow, T extends UsageTotals>(
  rows: R[], keyOf: (row: R) => string | undefined, create: (row: R) => T,
): T[] {
  const groups = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row); if (key === undefined) continue;
    const group = groups.get(key) ?? create(row); groups.set(key, group); addTotals(group, row);
  }
  return [...groups.values()].sort((a, b) => b.inputTokens - a.inputTokens);
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
  rows: UsageFactRow[],
  memberMeta: Map<string, { name: string; agent: string }>,
): { kpis: Kpis; series: any[]; breakdown: BreakdownRow[]; byAgent: AgentBucket[] } {
  const kpis = emptyKpis();
  rows.forEach(row => addTotals(kpis, row));
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
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.cacheRead += r.cacheRead;
    addToBucket((s.byModel[r.model] ||= emptyBucket()), r);
    // Per-day tokens by agent identity — drives the agent-colored trend (v3).
    if (r.memberId) {
      const agent = memberMeta.get(r.memberId)?.agent || r.memberId;
      s.byAgent[agent] = (s.byAgent[agent] || 0) + r.inputTokens + r.outputTokens + r.cacheRead + r.cacheWrite;
    }
  }
  const series = [...seriesMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  const breakdown = grouped<UsageFactRow, BreakdownRow>(rows,
    r => r.memberId ? `${r.memberId}\u0000${r.model}` : undefined,
    r => ({ ...emptyTotals(), memberId: r.memberId!, memberName: memberMeta.get(r.memberId!)?.name,
      agent: memberMeta.get(r.memberId!)?.agent, model: r.model }));
  const byAgent = grouped<UsageFactRow, AgentBucket>(rows,
    r => r.memberId ? memberMeta.get(r.memberId)?.agent || r.memberId : undefined,
    r => ({ ...emptyTotals(), agent: memberMeta.get(r.memberId!)?.agent || r.memberId! }));

  return { kpis, series, breakdown, byAgent };
}

function readReport(options: { from?: string; to?: string; sourceRef?: string } = {}): {
  rows: UsageReportRow[];
  memberMeta: Map<string, { name: string; agent: string }>;
  roomNames: Map<string, string>;
} {
  if (!usageQueries) throw new Error("Usage HTTP queries are not connected");
  const facts = usageQueries.readUsageRows(options);
  const memberMeta = new Map<string, { name: string; agent: string }>();
  for (const id of new Set(facts.flatMap((row) => row.memberId ? [row.memberId] : []))) {
    const member = getRetainedMember(id);
    if (member) memberMeta.set(id, { name: member.name, agent: member.agentTemplate });
  }
  const roomNames = new Map(listRooms().map((room) => [room.id, room.name]));
  const rows = facts.map((row): UsageReportRow => ({ ...row, roomId: row.sourceRef?.startsWith("room:")
    ? row.sourceRef.slice("room:".length) : row.sourceRef || row.historicalSourceKey || "historical-unattributed" }));
  return { rows, memberMeta, roomNames };
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

  const report = readReport({ sourceRef: `room:${roomId}`, from, to });
  const { memberMeta } = report;
  let rows = report.rows;
  if (memberFilter) rows = rows.filter((row) => row.memberId === memberFilter);
  if (modelFilter) rows = rows.filter((row) => row.model === modelFilter);
  if (agentFilter) rows = rows.filter((row) => row.memberId !== null && memberMeta.get(row.memberId)?.agent === agentFilter);

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
  rows: UsageReportRow[],
  memberMeta: Map<string, { name: string; agent: string }>,
  roomNames: Map<string, string>,
): {
  kpis: Kpis;
  series: any[];
  breakdown: BreakdownRow[];
  byAgent: AgentBucket[];
  byRoom: RoomBucket[];
} {
  // Reuse the single-room aggregation for kpis/series/breakdown/byAgent — the
  // member ids are globally unique (rm_<uuid>) so cross-room mixing is safe.
  const base = aggregateUsage(rows, memberMeta);

  const byRoom = grouped(rows, r => r.roomId,
    r => ({ ...emptyTotals(), roomId: r.roomId, roomName: roomNames.get(r.roomId) }));

  return { ...base, byRoom };
}

addRoute("GET", "/api/usage", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const from = parseDate(url.searchParams.get("from"));
  const to = parseDate(url.searchParams.get("to"));
  const agentFilter = url.searchParams.get("agent") || undefined;
  const modelFilter = url.searchParams.get("model") || undefined;

  const report = readReport({ from, to });
  const { memberMeta, roomNames } = report;
  let rows = report.rows;
  if (modelFilter) rows = rows.filter((row) => row.model === modelFilter);
  if (agentFilter) rows = rows.filter((row) => row.memberId !== null && memberMeta.get(row.memberId)?.agent === agentFilter);

  const { kpis, series, breakdown, byAgent, byRoom } = aggregatePlatformUsage(rows, memberMeta, roomNames);

  sendJson(res, 200, {
    kpis,
    series: fillSeriesGaps(series, from, to),
    breakdown,
    byAgent,
    byRoom,
  });
});

interface Kpis extends UsageTotals { cacheHitRate: number }
function emptyKpis(): Kpis { return { ...emptyTotals(), cacheHitRate: 0 }; }

interface ModelBucket {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
}
function emptyBucket(): ModelBucket {
  return { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0 };
}
function addToBucket(b: ModelBucket, r: UsageFactRow): void {
  b.cost += r.cost;
  b.inputTokens += r.inputTokens;
  b.outputTokens += r.outputTokens;
  b.cacheRead += r.cacheRead;
}

interface BreakdownRow extends UsageTotals { memberId: string; memberName?: string; agent?: string; model: string }
interface AgentBucket extends UsageTotals { agent: string }
interface RoomBucket extends UsageTotals { roomId: string; roomName?: string }
