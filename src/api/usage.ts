// Usage API (0.19.1 S2): token usage read endpoints backed by the SQLite
// projection's token_usage_daily rollup.
//
//   GET /api/rooms/:id/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&member=&model=
//     → { kpis, series, breakdown, byAgent, backfillStatus }
//
// The prototype's identity dimension (agent → room → member) needs member→agent
// mapping, which lives in room.json, not the DB. We resolve names/agents here and
// join them onto the rollup rows so the frontend gets ready-to-render buckets.
import { addRoute, sendJson } from "./index.js";
import { getProjectionDb } from "../workspace/db/projection.js";
import { getBackfillStatus } from "../workspace/db/projection.js";
import { getRoom, deriveRoomMembers, listRooms } from "../workspace/room-store.js";
import { logger } from "../foundation/logger.js";

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
    { date: string; cost: number; inputTokens: number; outputTokens: number; cacheRead: number; byModel: Record<string, ModelBucket> }
  >();
  for (const r of rows) {
    let s = seriesMap.get(r.date);
    if (!s) {
      s = { date: r.date, cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, byModel: {} };
      seriesMap.set(r.date, s);
    }
    s.cost += r.cost;
    s.inputTokens += r.input_tokens;
    s.outputTokens += r.output_tokens;
    s.cacheRead += r.cache_read;
    addToBucket((s.byModel[r.model] ||= emptyBucket()), r);
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
  const modelFilter = url.searchParams.get("model") || undefined;

  const db = getProjectionDb();
  if (!db) {
    // Projection unavailable → honest empty payload (file-only mode).
    sendJson(res, 200, {
      kpis: emptyKpis(),
      series: [],
      breakdown: [],
      byAgent: [],
      backfillStatus: getBackfillStatus().status,
    });
    return;
  }

  // member→{name, agent} map for joining identity onto rollup rows.
  const members = deriveRoomMembers(room);
  const memberMeta = new Map<string, { name: string; agent: string }>();
  for (const m of members) memberMeta.set(m.id, { name: m.name, agent: m.sourceAgent });

  const where: string[] = ["room_id = ?"];
  const args: unknown[] = [roomId];
  if (from) {
    where.push("date >= ?");
    args.push(from);
  }
  if (to) {
    where.push("date <= ?");
    args.push(to);
  }
  if (memberFilter) {
    where.push("member_id = ?");
    args.push(memberFilter);
  }
  if (modelFilter) {
    where.push("model = ?");
    args.push(modelFilter);
  }
  const whereSql = where.join(" AND ");

  let rows: RollupRow[];
  try {
    rows = db.all<RollupRow>(
      `SELECT member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns
       FROM token_usage_daily WHERE ${whereSql}`,
      ...args,
    );
  } catch (err) {
    logger.error("db", "usage query failed", { roomId, error: String(err) });
    sendJson(res, 500, { error: "usage query failed" });
    return;
  }

  const { kpis, series, breakdown, byAgent } = aggregateUsage(rows, memberMeta);

  sendJson(res, 200, {
    kpis,
    series,
    breakdown,
    byAgent,
    backfillStatus: getBackfillStatus().status,
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

  const db = getProjectionDb();
  if (!db) {
    sendJson(res, 200, {
      kpis: emptyKpis(),
      series: [],
      breakdown: [],
      byAgent: [],
      byRoom: [],
      backfillStatus: getBackfillStatus().status,
    });
    return;
  }

  // Build the platform-wide member→{name,agent} map + room name map from every
  // room's room.json (this is where the identity mapping lives, not the DB).
  const memberMeta = new Map<string, { name: string; agent: string }>();
  const roomNames = new Map<string, string>();
  for (const room of listRooms()) {
    roomNames.set(room.id, room.name);
    for (const m of deriveRoomMembers(room)) memberMeta.set(m.id, { name: m.name, agent: m.sourceAgent });
  }

  const where: string[] = [];
  const args: unknown[] = [];
  if (from) {
    where.push("date >= ?");
    args.push(from);
  }
  if (to) {
    where.push("date <= ?");
    args.push(to);
  }
  if (modelFilter) {
    where.push("model = ?");
    args.push(modelFilter);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  let rows: RollupRowWithRoom[];
  try {
    rows = db.all<RollupRowWithRoom>(
      `SELECT room_id, member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns
       FROM token_usage_daily ${whereSql}`,
      ...args,
    );
  } catch (err) {
    logger.error("db", "platform usage query failed", { error: String(err) });
    sendJson(res, 500, { error: "usage query failed" });
    return;
  }

  // Agent filter is applied here (not in SQL) since agent lives in room.json, not
  // the rollup: keep only rows whose member maps to the requested agent.
  if (agentFilter) {
    rows = rows.filter((r) => memberMeta.get(r.member_id)?.agent === agentFilter);
  }

  const { kpis, series, breakdown, byAgent, byRoom } = aggregatePlatformUsage(rows, memberMeta, roomNames);

  sendJson(res, 200, {
    kpis,
    series,
    breakdown,
    byAgent,
    byRoom,
    backfillStatus: getBackfillStatus().status,
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
