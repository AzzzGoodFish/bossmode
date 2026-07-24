// Token usage daily rollup (0.19.1 S2).
//
// Live write path: after a message_end event's jsonl append succeeds, upsert an
// additive row into token_usage_daily keyed by (room, member, utc-date, model).
// This mirrors the SQL the S1 backfill uses; the only difference is the model is
// the stamped live model instead of the 'unknown' bucket.
//
// Best-effort: any DB error is logged and swallowed — a stats write must never
// fail the agent turn (file authority already succeeded upstream).
import type { BossmodeDb } from "./sqlite.js";
import { getProjectionDb } from "./projection.js";
import { logger } from "../../foundation/logger.js";

export interface UsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

function utcDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

const UPSERT_SQL = `INSERT INTO token_usage_daily
  (room_id, member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT(room_id, member_id, date, model) DO UPDATE SET
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read = cache_read + excluded.cache_read,
    cache_write = cache_write + excluded.cache_write,
    cost = cost + excluded.cost,
    turns = turns + excluded.turns`;

/**
 * Upsert one message_end's usage into the daily rollup. `model` should be the
 * live "provider/modelId"; pass undefined/empty to record it in the 'unknown'
 * bucket (mirrors backfill of pre-stamp history).
 */
export function recordDailyUsage(
  roomId: string,
  memberId: string,
  tsMs: number,
  usage: UsageDelta,
  model?: string,
  db: BossmodeDb | null = getProjectionDb(),
): void {
  if (!db) return; // projection unavailable → file-only, no-op
  try {
    db.run(
      UPSERT_SQL,
      roomId,
      memberId,
      utcDate(tsMs),
      model && model.trim() ? model : "unknown",
      usage.inputTokens || 0,
      usage.outputTokens || 0,
      usage.cacheRead || 0,
      usage.cacheWrite || 0,
      usage.cost || 0,
    );
  } catch (err) {
    logger.error("db", "recordDailyUsage failed", { roomId, memberId, error: String(err) });
  }
}
