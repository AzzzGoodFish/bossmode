// Historical model attribution backfill (0.19.1 rc.2, task ④).
//
// Pre-0.19.1 events have no `model` field, so S1 backfill put all their usage in
// the `unknown` bucket of token_usage_daily. But pi session files record a full
// per-member model timeline: each session opens with a `model_change` entry and
// every switch logs another (provider/modelId + timestamp). We can therefore
// reconstruct which model was in effect at each historical message_end's ts and
// move that usage out of `unknown` into the real model bucket.
//
// Authority + safety:
//  - Files remain authority; this rewrites only the disposable projection.
//  - Full re-derivation per member: token_usage_daily rows for a member are
//    recomputed from that member's agent-events in one transaction (delete-all +
//    insert). Each message_end uses its stamped model when present (S2 live
//    path), else the timeline-resolved model, else 'unknown'. This is idempotent
//    and loses nothing (live rows re-derive from the same jsonl they came from).
//  - Events whose ts predates the member's earliest model_change (e.g. a session
//    that was reset/deleted) cannot be attributed and stay in `unknown` — the
//    honest bucket. The report states attributed vs remaining.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BossmodeDb } from "./sqlite.js";
import { getProjectionDb } from "./projection.js";
import { resolveMemberEventFiles } from "./backfill.js";
import { getRoomsDir, roomDir } from "../room-store.js";
import { getBossmodeDir } from "../../shared/config.js";
import { logger } from "../../foundation/logger.js";

interface ModelChange {
  ts: number;
  model: string; // "provider/modelId" — same canonical form S2 stamps live
}

function utcDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function piRuntimeRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime");
}

/**
 * Build a member's model timeline from all its pi session files, ascending by ts.
 * Each session's opening model_change + any later switches contribute a point.
 */
export function buildMemberModelTimeline(roomId: string, memberId: string): ModelChange[] {
  const sessionsDir = join(piRuntimeRoot(), roomId, memberId, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const points: ModelChange[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(sessionsDir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.includes('"model_change"')) continue;
      let entry: { type?: string; timestamp?: string; provider?: string; modelId?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "model_change" || !entry.provider || !entry.modelId) continue;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ts)) continue;
      points.push({ ts, model: `${entry.provider}/${entry.modelId}` });
    }
  }
  points.sort((a, b) => a.ts - b.ts);
  return points;
}

/**
 * The model in effect at `tsMs` = the last model_change with ts <= tsMs.
 * Returns null when tsMs predates the earliest change (unattributable → unknown).
 */
export function resolveModelAt(timeline: ModelChange[], tsMs: number): string | null {
  if (timeline.length === 0 || tsMs < timeline[0].ts) return null;
  // Binary search for the rightmost point with ts <= tsMs.
  let lo = 0;
  let hi = timeline.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].ts <= tsMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return timeline[ans].model;
}

interface UsageAgg {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

function emptyAgg(): UsageAgg {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export interface ModelBackfillReport {
  rooms: number;
  members: number;
  membersWithTimeline: number;
  attributedTokens: number;
  unknownRemainingTokens: number;
  attributedRows: number;
  byMember: Array<{ roomId: string; memberId: string; attributedTokens: number; unknownRemainingTokens: number; hasTimeline: boolean }>;
}

/**
 * Re-derive a member's ENTIRE token_usage_daily from agent-events, using each
 * message_end's stamped model when present and the session timeline otherwise
 * (unattributable → 'unknown'). Fully replaces the member's rows in one
 * transaction, so it is idempotent (a re-run recomputes identical rows) and
 * correct for both live-stamped and historical events. Live rows written after
 * startup are re-derived from the same jsonl they were appended to, so nothing
 * is lost.
 */
function backfillMember(
  db: BossmodeDb,
  roomId: string,
  memberId: string,
  file: string,
  report: ModelBackfillReport,
): void {
  const timeline = buildMemberModelTimeline(roomId, memberId);
  const hasTimeline = timeline.length > 0;
  if (hasTimeline) report.membersWithTimeline += 1;

  const filePath = join(roomDir(roomId), "agent-events", file);
  if (!existsSync(filePath)) return;
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  // key = `${date}\u0000${model}`
  const buckets = new Map<string, UsageAgg>();
  let attributedTokens = 0;
  let unknownRemainingTokens = 0;

  for (const line of content.split("\n")) {
    if (!line.includes('"message_end"')) continue;
    let ev: { type?: string; ts?: number; model?: string; usage?: Record<string, number> };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "message_end" || !ev.usage) continue;
    const ts = typeof ev.ts === "number" ? ev.ts : 0;
    // Prefer the event's own stamped model (S2 live path); else resolve from the
    // session timeline (historical attribution); else honest 'unknown'.
    const stamped = ev.model && String(ev.model).trim() ? String(ev.model) : null;
    const resolved = stamped ?? (ts ? resolveModelAt(timeline, ts) : null);
    const model = resolved ?? "unknown";
    const key = `${utcDate(ts)}\u0000${model}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = emptyAgg();
      buckets.set(key, agg);
    }
    const u = ev.usage;
    agg.input += u.inputTokens || 0;
    agg.output += u.outputTokens || 0;
    agg.cacheRead += u.cacheRead || 0;
    agg.cacheWrite += u.cacheWrite || 0;
    agg.cost += u.cost || 0;
    agg.turns += 1;
    const tokens = (u.inputTokens || 0) + (u.outputTokens || 0);
    // "Attributed" = moved out of unknown by the timeline (not already stamped).
    if (!stamped && resolved) attributedTokens += tokens;
    else if (!resolved) unknownRemainingTokens += tokens;
  }

  db.transaction((tx) => {
    // Full replace: drop all this member's rows, then insert the recomputed set.
    tx.run("DELETE FROM token_usage_daily WHERE room_id = ? AND member_id = ?", roomId, memberId);
    const insert = tx.raw.prepare(
      `INSERT INTO token_usage_daily (room_id, member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [key, agg] of buckets) {
      const [date, model] = key.split("\u0000");
      insert.run(roomId, memberId, date, model, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.cost, agg.turns);
      report.attributedRows += 1;
    }
  });

  report.attributedTokens += attributedTokens;
  report.unknownRemainingTokens += unknownRemainingTokens;
  report.byMember.push({ roomId, memberId, attributedTokens, unknownRemainingTokens, hasTimeline });
}

/**
 * Attribute all rooms' historical unknown usage to real models via session
 * timelines. Idempotent. Returns a coverage report (attributed vs remaining).
 */
export function backfillModelHistory(db: BossmodeDb | null = getProjectionDb()): ModelBackfillReport {
  const report: ModelBackfillReport = {
    rooms: 0,
    members: 0,
    membersWithTimeline: 0,
    attributedTokens: 0,
    unknownRemainingTokens: 0,
    attributedRows: 0,
    byMember: [],
  };
  if (!db) return report;

  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return report;

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    logger.error("db", "model-history backfill failed to list rooms", { error: String(err) });
    return report;
  }

  for (const roomId of roomIds) {
    try {
      const { files } = resolveMemberEventFiles(roomId);
      for (const { memberId, file } of files) {
        backfillMember(db, roomId, memberId, file, report);
        report.members += 1;
      }
      report.rooms += 1;
    } catch (err) {
      logger.error("db", "model-history backfill failed for room", { roomId, error: String(err) });
    }
  }

  logger.info("db", "model-history backfill complete", {
    rooms: report.rooms,
    members: report.members,
    membersWithTimeline: report.membersWithTimeline,
    attributedTokens: report.attributedTokens,
    unknownRemainingTokens: report.unknownRemainingTokens,
    attributedRows: report.attributedRows,
  });
  return report;
}
