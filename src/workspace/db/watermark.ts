// Ingest watermarks for incremental backfill / catch-up (0.19.1 S1).
//
// A watermark records how far we have ingested a given source file so restarts
// can resume instead of rescanning. For agent-events we track last_seq +
// last_mtime_ms per (room, member); for tasks we track last_mtime_ms per room.
import type { BossmodeDb } from "./sqlite.js";

export type WatermarkKind = "events" | "tasks";

export interface Watermark {
  kind: WatermarkKind;
  roomId: string;
  memberId: string;
  lastTs: number | null;
  lastSeq: number | null;
  lastMtimeMs: number | null;
}

export function getWatermark(
  db: BossmodeDb,
  kind: WatermarkKind,
  roomId: string,
  memberId = "",
): Watermark | undefined {
  const row = db.get<{
    last_ts: number | null;
    last_seq: number | null;
    last_mtime_ms: number | null;
  }>(
    "SELECT last_ts, last_seq, last_mtime_ms FROM ingest_watermark WHERE kind = ? AND room_id = ? AND member_id = ?",
    kind,
    roomId,
    memberId,
  );
  if (!row) return undefined;
  return {
    kind,
    roomId,
    memberId,
    lastTs: row.last_ts,
    lastSeq: row.last_seq,
    lastMtimeMs: row.last_mtime_ms,
  };
}

export function setWatermark(
  db: BossmodeDb,
  kind: WatermarkKind,
  roomId: string,
  memberId: string,
  update: { lastTs?: number | null; lastSeq?: number | null; lastMtimeMs?: number | null },
): void {
  db.run(
    `INSERT INTO ingest_watermark (kind, room_id, member_id, last_ts, last_seq, last_mtime_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, room_id, member_id) DO UPDATE SET
       last_ts = excluded.last_ts,
       last_seq = excluded.last_seq,
       last_mtime_ms = excluded.last_mtime_ms`,
    kind,
    roomId,
    memberId,
    update.lastTs ?? null,
    update.lastSeq ?? null,
    update.lastMtimeMs ?? null,
  );
}
