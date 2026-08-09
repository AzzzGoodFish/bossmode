// Activity event index + O(1) line fetch (0.19.1 S3).
//
// S1's backfill already populated `activity_events` (room_id, member_id, ts,
// seq, type, byte_offset) for every indexed event, computing byte offsets while
// streaming each jsonl. S3 adds:
//
//  1. LIVE INSERT — the event-handler dual-writes each indexed event as it is
//     appended, keeping the index current without a rescan.
//  2. QUERY — tail/`beforeSeq` pagination over the index, then an O(1) random
//     read of the matching jsonl lines by byte offset (no full-file scan).
//
// Same dedup/authority stance as backfill: files are the truth, the index is a
// disposable projection. Every write is best-effort — a DB failure logs and the
// agent turn continues on files alone.
import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getProjectionDb } from "./projection.js";
import { getWatermark, setWatermark } from "./watermark.js";
import { getBossmodeDir } from "../../shared/config.js";
import { logger } from "../../foundation/logger.js";
import type { BossmodeDb } from "./sqlite.js";
import { resolveMemberEventFiles } from "./backfill.js";
import { getRoomsDir, roomDir } from "../room-store.js";

// Types indexed for the Activity UI — mirrors backfill.ts INDEXED_TYPES + spec §C.
// (streaming churn message_update/tool_update deliberately excluded.)
export const INDEXED_ACTIVITY_TYPES = new Set([
  "agent_start",
  "agent_end",
  "message_end",
  "tool_start",
  "tool_end",
  "compaction_start",
  "compaction_end",
  "user_prompt",
  "user_steer",
  "system",
]);

function agentEventsPath(roomId: string, memberId: string): string {
  return join(getBossmodeDir(), "rooms", roomId, "agent-events", `${memberId}.jsonl`);
}

interface ActivityRow {
  ts: number;
  seq: number;
  type: string;
  byte_offset: number;
}

/**
 * Live-index one appended event. `byteOffsetBefore` is the file size BEFORE this
 * line was appended (i.e. the byte offset where the line starts); `seq` is the
 * 1-based line number of this event in the member's jsonl. Best-effort.
 */
export function indexAppendedEvent(
  roomId: string,
  memberId: string,
  seq: number,
  byteOffsetBefore: number,
  event: { type: string; ts?: number },
): void {
  if (!INDEXED_ACTIVITY_TYPES.has(event.type)) return;
  const db = getProjectionDb();
  if (!db) return;
  try {
    const ts = typeof event.ts === "number" ? event.ts : Date.now();
    db.run(
      `INSERT OR REPLACE INTO activity_events (room_id, member_id, ts, seq, type, turn_id, summary, byte_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      roomId,
      memberId,
      ts,
      seq,
      event.type,
      null,
      null,
      byteOffsetBefore,
    );
    setWatermark(db, "events", roomId, memberId, { lastTs: ts, lastSeq: seq });
  } catch (err) {
    logger.error("db", "activity live-index failed", { roomId, memberId, error: String(err) });
  }
}

/**
 * Read a single jsonl line at a known byte offset (O(1) — no full-file scan).
 * Returns the parsed JSON, or null on any read/parse failure.
 */
function readLineAtOffset(filePath: string, byteOffset: number): unknown {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    // Read a bounded chunk from the offset and take the first line. 256KB covers
    // even large enriched message_end events; falls back gracefully if a line is
    // longer (rare) by expanding once.
    let chunkSize = 256 * 1024;
    for (let attempt = 0; attempt < 2; attempt++) {
      const buf = Buffer.allocUnsafe(chunkSize);
      const bytesRead = readSync(fd, buf, 0, chunkSize, byteOffset);
      if (bytesRead === 0) return null;
      const text = buf.toString("utf-8", 0, bytesRead);
      const nl = text.indexOf("\n");
      if (nl >= 0) {
        const line = text.slice(0, nl).trim();
        if (!line) return null;
        return JSON.parse(line);
      }
      if (bytesRead < chunkSize) {
        // No newline but hit EOF — the whole remainder is the line.
        const line = text.trim();
        return line ? JSON.parse(line) : null;
      }
      chunkSize *= 8; // line longer than chunk — expand and retry once
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface ActivityPage {
  events: unknown[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
  /** true when served from the SQLite index; false when it fell back to file scan. */
  indexed: boolean;
}

/**
 * Paginated Activity events for a member, newest-first, via the index.
 *   - `beforeSeq`: return events with seq < beforeSeq (undefined = newest page)
 *   - `limit`: page size
 *   - `types`: optional filter to a subset of indexed types
 * Reads full event bodies from jsonl by byte offset (O(limit) reads).
 */
export function queryActivityPage(
  roomId: string,
  memberId: string,
  opts: { beforeSeq?: number; limit?: number; types?: string[] } = {},
): ActivityPage | null {
  const db = getProjectionDb();
  if (!db) return null;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));

  const typeFilter = (opts.types ?? []).filter((t) => INDEXED_ACTIVITY_TYPES.has(t));
  const params: unknown[] = [roomId, memberId];
  let sql = `SELECT ts, seq, type, byte_offset FROM activity_events WHERE room_id = ? AND member_id = ?`;
  if (opts.beforeSeq !== undefined) {
    sql += ` AND seq < ?`;
    params.push(opts.beforeSeq);
  }
  if (typeFilter.length) {
    sql += ` AND type IN (${typeFilter.map(() => "?").join(",")})`;
    params.push(...typeFilter);
  }
  // Fetch limit+1 to know if there is an older page.
  sql += ` ORDER BY seq DESC LIMIT ?`;
  params.push(limit + 1);

  let rows: ActivityRow[];
  try {
    rows = db.all<ActivityRow>(sql, ...params);
  } catch (err) {
    logger.error("db", "activity query failed", { roomId, memberId, error: String(err) });
    return null;
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const filePath = agentEventsPath(roomId, memberId);
  if (!existsSync(filePath)) {
    return { events: [], hasMore: false, nextBeforeSeq: null, indexed: true };
  }

  // Index returned newest-first; read each line, then reverse to chronological
  // (oldest→newest) so the UI renders in natural order like the file scan did.
  const events: unknown[] = [];
  for (const row of pageRows) {
    const parsed = readLineAtOffset(filePath, row.byte_offset);
    if (parsed) events.push(parsed);
  }
  events.reverse();

  const nextBeforeSeq = hasMore && pageRows.length ? pageRows[pageRows.length - 1].seq : null;
  return { events, hasMore, nextBeforeSeq, indexed: true };
}

/**
 * Catch-up: index any events appended to a member's jsonl beyond the watermark.
 * Called lazily before serving an Activity page so live-index gaps (e.g. events
 * written while the DB was mid-backfill) self-heal without a full rebuild.
 * Streams only the tail beyond `last_seq`. Best-effort.
 */
export function catchUpActivityIndex(roomId: string, memberId: string): void {
  const db = getProjectionDb();
  if (!db) return;
  const filePath = agentEventsPath(roomId, memberId);
  if (!existsSync(filePath)) return;
  try {
    const wm = getWatermark(db, "events", roomId, memberId);
    const lastSeq = wm?.lastSeq ?? 0;
    // Count current indexed rows as a cheap "are we behind?" proxy is unreliable
    // (types filtered), so we compare the file's total line count via seq: read
    // the file, skip up to lastSeq lines, index the rest. For very large files
    // this is still a one-time cost after which live-index keeps pace.
    const content = readFileSync(filePath, "utf-8");
    if (!content) return;
    const lines = content.split("\n");
    let seq = 0;
    let byteOffset = 0;
    let lastTs: number | null = wm?.lastTs ?? null;
    const insert = db.raw.prepare(
      `INSERT OR REPLACE INTO activity_events (room_id, member_id, ts, seq, type, turn_id, summary, byte_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let pending = 0;
    db.raw.exec("BEGIN");
    try {
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf-8");
        const thisOffset = byteOffset;
        byteOffset += lineBytes + 1;
        if (!line.trim()) continue;
        seq += 1;
        if (seq <= lastSeq) continue; // already indexed
        let event: { type: string; ts?: number };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = typeof event.ts === "number" ? event.ts : lastTs ?? Date.now();
        lastTs = ts;
        if (!INDEXED_ACTIVITY_TYPES.has(event.type)) continue;
        insert.run(roomId, memberId, ts, seq, event.type, null, null, thisOffset);
        pending += 1;
      }
      db.raw.exec("COMMIT");
    } catch (err) {
      db.raw.exec("ROLLBACK");
      throw err;
    }
    if (seq > lastSeq) {
      setWatermark(db, "events", roomId, memberId, { lastTs, lastSeq: seq });
    }
    if (pending) logger.info("db", "activity catch-up indexed", { roomId, memberId, added: pending });
  } catch (err) {
    logger.error("db", "activity catch-up failed", { roomId, memberId, error: String(err) });
  }
}


function utcDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export interface HealMissingResult {
  healed: number;
  tokenRows: number;
  scanned: number;
}

/**
 * Gap-heal: insert any INDEXED activity seq present on disk but missing from the
 * projection. Does NOT move watermarks (catch-up owns the tail). Token rollups
 * only run for newly inserted seqs — never re-add usage for already-indexed
 * rows (additive upsert would double-count).
 *
 * Data-driven: no marker. Safe to run every startup; no-op when fully covered.
 * Kills the class of bug where a type joins INDEXED_TYPES after the watermark
 * already passed those lines (user_steer history, fish 2026-08-09).
 */
export function healMissingIndexedSeqs(
  db: BossmodeDb,
  roomId: string,
  memberId: string,
  filePath: string,
): HealMissingResult {
  const empty: HealMissingResult = { healed: 0, tokenRows: 0, scanned: 0 };
  if (!existsSync(filePath)) return empty;

  let existing: Set<number>;
  try {
    const rows = db.all<{ seq: number }>(
      "SELECT seq FROM activity_events WHERE room_id = ? AND member_id = ?",
      roomId,
      memberId,
    );
    existing = new Set(rows.map((r) => r.seq));
  } catch (err) {
    logger.error("db", "activity heal failed to load existing seqs", { roomId, memberId, error: String(err) });
    return empty;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    logger.error("db", "activity heal failed to read file", { roomId, memberId, error: String(err) });
    return empty;
  }
  if (!content) return empty;

  const insertActivity = db.raw.prepare(
    `INSERT OR REPLACE INTO activity_events (room_id, member_id, ts, seq, type, turn_id, summary, byte_offset)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertUsage = db.raw.prepare(
    `INSERT INTO token_usage_daily (room_id, member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(room_id, member_id, date, model) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read = cache_read + excluded.cache_read,
       cache_write = cache_write + excluded.cache_write,
       cost = cost + excluded.cost,
       turns = turns + excluded.turns`,
  );

  let seq = 0;
  let byteOffset = 0;
  let lastTs: number | null = null;
  let healed = 0;
  let tokenRows = 0;
  let scanned = 0;
  const ops: Array<() => void> = [];

  const lines = content.split("\n");
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf-8");
    const thisOffset = byteOffset;
    byteOffset += lineBytes + 1;
    if (!line.trim()) continue;
    scanned += 1;
    let event: {
      type: string;
      ts?: number;
      model?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: number;
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue; // tolerate corrupt trailing line — same as backfill
    }
    seq += 1;
    const ts = typeof event.ts === "number" ? event.ts : lastTs ?? 0;
    lastTs = ts;

    if (!INDEXED_ACTIVITY_TYPES.has(event.type)) continue;
    if (existing.has(seq)) continue; // already projected — skip activity + token

    const capturedSeq = seq;
    const capturedOffset = thisOffset;
    const capturedType = event.type;
    const capturedTs = ts;
    ops.push(() =>
      insertActivity.run(roomId, memberId, capturedTs, capturedSeq, capturedType, null, null, capturedOffset),
    );
    healed += 1;

    // Token only for missing seqs (already-indexed message_end usage was rolled up).
    if (event.type === "message_end" && event.usage) {
      const u = event.usage;
      const date = utcDate(ts);
      const model = event.model && event.model.trim() ? event.model : "unknown";
      ops.push(() =>
        upsertUsage.run(
          roomId,
          memberId,
          date,
          model,
          u.inputTokens || 0,
          u.outputTokens || 0,
          u.cacheRead || 0,
          u.cacheWrite || 0,
          u.cost || 0,
        ),
      );
      tokenRows += 1;
    }
  }

  if (ops.length === 0) return { healed: 0, tokenRows: 0, scanned };

  try {
    db.raw.exec("BEGIN");
    try {
      for (const op of ops) op();
      db.raw.exec("COMMIT");
    } catch (err) {
      db.raw.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    logger.error("db", "activity heal write failed", { roomId, memberId, error: String(err) });
    return { healed: 0, tokenRows: 0, scanned };
  }

  if (healed) {
    logger.info("db", "activity heal filled gaps", { roomId, memberId, healed, tokenRows, scanned });
  }
  return { healed, tokenRows, scanned };
}

/**
 * Startup heal across all rooms/members. Uses resolveMemberEventFiles so
 * name-keyed vs id-keyed dedup matches backfill. Watermark untouched.
 */
export function healAllMissingIndexedSeqs(db?: BossmodeDb | null): {
  members: number;
  healed: number;
  tokenRows: number;
  skippedNameKeyed: number;
} {
  const summary = { members: 0, healed: 0, tokenRows: 0, skippedNameKeyed: 0 };
  const conn = db ?? getProjectionDb();
  if (!conn) return summary;
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return summary;

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    logger.error("db", "activity heal failed to list rooms", { error: String(err) });
    return summary;
  }

  for (const roomId of roomIds) {
    try {
      const { files, skippedNameKeyed } = resolveMemberEventFiles(roomId);
      summary.skippedNameKeyed += skippedNameKeyed;
      for (const { memberId, file } of files) {
        const filePath = join(roomDir(roomId), "agent-events", file);
        const r = healMissingIndexedSeqs(conn, roomId, memberId, filePath);
        summary.members += 1;
        summary.healed += r.healed;
        summary.tokenRows += r.tokenRows;
      }
    } catch (err) {
      logger.error("db", "activity heal failed for room", { roomId, error: String(err) });
    }
  }
  if (summary.healed) logger.info("db", "activity heal complete", summary);
  return summary;
}

/** Test/diagnostic: count indexed activity rows for a member. */
export function countActivityRows(db: BossmodeDb, roomId: string, memberId: string): number {
  const row = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM activity_events WHERE room_id = ? AND member_id = ?",
    roomId,
    memberId,
  );
  return row?.n ?? 0;
}
