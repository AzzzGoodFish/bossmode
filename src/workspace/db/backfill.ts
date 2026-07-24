// Backfill framework: rebuild the SQLite projection from file authority (S1).
//
// Streams each room's agent-events *.jsonl and tasks.json into the projection
// tables. Two properties matter most:
//
//  1. DEDUP (spec, fish-approved): a member can have BOTH a legacy name-keyed
//     file (<name>.jsonl) and a current id-keyed file (rm_<id>.jsonl). The
//     id-keyed file is a verified superset (same first event). Ingesting both
//     double-counts usage. Rule: when a member has an id-keyed file, skip its
//     name-keyed file; use the name-keyed file only for legacy members that
//     never got an id-keyed one.
//
//  2. IDEMPOTENT + BATCHED: PRIMARY-KEY upserts make re-runs safe; lines are
//     processed in batches so a huge room does not block the event loop.
//
// This S1 module lays token_usage_daily rows with model="unknown" (S2 stamps
// real model on the live write path) and activity_events rows with byte
// offsets (S3 uses offsets for O(1) line fetch). It is intentionally the single
// place that knows the file layout + dedup so S2/S3 build on it, not beside it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { BossmodeDb } from "./sqlite.js";
import { setWatermark } from "./watermark.js";
import { getRoomsDir, roomDir, deriveRoomMembers, getRoom } from "../room-store.js";
import { logger } from "../../foundation/logger.js";

const BATCH_SIZE = 5000;

export interface BackfillProgress {
  rooms: number;
  members: number;
  events: number;
  usageRows: number;
  tasks: number;
  skippedNameKeyedFiles: number;
}

interface AgentEvent {
  type: string;
  ts?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
  };
}

// Activity event types worth indexing for the Activity UI (skip high-churn
// streaming updates). Kept in sync with the spec's "Activity which types" list.
const INDEXED_TYPES = new Set([
  "agent_start",
  "agent_end",
  "message_end",
  "tool_start",
  "tool_end",
  "compaction_start",
  "compaction_end",
]);

function utcDate(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

/**
 * Resolve which event files to ingest for a room, applying the dedup rule.
 * Returns a list of { memberId, file, isNameKeyed } plus a count of skipped
 * name-keyed files (for observability / tests).
 */
export function resolveMemberEventFiles(roomId: string): {
  files: Array<{ memberId: string; file: string }>;
  skippedNameKeyed: number;
} {
  const dir = join(roomDir(roomId), "agent-events");
  if (!existsSync(dir)) return { files: [], skippedNameKeyed: 0 };

  const present = new Set(
    readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.endsWith(".stats.json")),
  );

  const room = getRoom(roomId);
  const members = room ? deriveRoomMembers(room) : [];

  // Map each member's canonical id-keyed file and its legacy name-keyed file.
  const nameKeyedToSkip = new Set<string>();
  const chosen: Array<{ memberId: string; file: string }> = [];
  const claimed = new Set<string>();

  for (const m of members) {
    const idFile = `${m.id}.jsonl`;
    const nameFile = `${m.name}.jsonl`;
    if (present.has(idFile)) {
      chosen.push({ memberId: m.id, file: idFile });
      claimed.add(idFile);
      if (present.has(nameFile) && nameFile !== idFile) {
        nameKeyedToSkip.add(nameFile); // dedup: id-keyed wins
      }
    } else if (present.has(nameFile)) {
      // Legacy member with no id-keyed file: use name-keyed, keyed by member id.
      chosen.push({ memberId: m.id, file: nameFile });
      claimed.add(nameFile);
    }
  }

  // Any remaining files not tied to a current room member (e.g. removed member
  // whose file lingers). Ingest under the file stem, but still honor dedup:
  // if a `rm_<id>` file's bare name also lingers, prefer the id-keyed one.
  for (const f of present) {
    if (claimed.has(f) || nameKeyedToSkip.has(f)) continue;
    const stem = f.slice(0, -".jsonl".length);
    chosen.push({ memberId: stem, file: f });
    claimed.add(f);
  }

  return { files: chosen, skippedNameKeyed: nameKeyedToSkip.size };
}

/**
 * Stream one member's jsonl into activity_events + token_usage_daily.
 * Computes byte offsets per line for later O(1) fetch. Returns rows processed.
 */
async function backfillMemberFile(
  db: BossmodeDb,
  roomId: string,
  memberId: string,
  filePath: string,
  progress: BackfillProgress,
): Promise<void> {
  const stat = statSync(filePath);
  const fh = await open(filePath, "r");
  try {
    let seq = 0;
    let byteOffset = 0;
    let lastTs: number | null = null;
    let batch: Array<() => void> = [];

    const insertActivity = db.raw.prepare(
      `INSERT OR REPLACE INTO activity_events (room_id, member_id, ts, seq, type, turn_id, summary, byte_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const upsertUsage = db.raw.prepare(
      `INSERT INTO token_usage_daily (room_id, member_id, date, model, input_tokens, output_tokens, cache_read, cache_write, cost, turns)
       VALUES (?, ?, ?, 'unknown', ?, ?, ?, ?, ?, 1)
       ON CONFLICT(room_id, member_id, date, model) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens,
         cache_read = cache_read + excluded.cache_read,
         cache_write = cache_write + excluded.cache_write,
         cost = cost + excluded.cost,
         turns = turns + excluded.turns`,
    );

    const flush = () => {
      if (batch.length === 0) return;
      db.raw.exec("BEGIN");
      try {
        for (const op of batch) op();
        db.raw.exec("COMMIT");
      } catch (err) {
        db.raw.exec("ROLLBACK");
        throw err;
      }
      batch = [];
    };

    // Read the whole file then split; jsonl lines are newline-delimited. We need
    // byte offsets, so measure each line's UTF-8 byte length as we go.
    const content = (await fh.readFile("utf-8"));
    const lines = content.length ? content.split("\n") : [];
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, "utf-8");
      const thisOffset = byteOffset;
      byteOffset += lineBytes + 1; // +1 for the '\n' separator
      if (!line.trim()) continue;

      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        continue; // tolerate a partial/corrupt trailing line
      }
      seq += 1;
      const ts: number = typeof event.ts === "number" ? event.ts : lastTs ?? 0;
      lastTs = ts;

      if (INDEXED_TYPES.has(event.type)) {
        const capturedSeq = seq;
        const capturedOffset = thisOffset;
        const capturedType = event.type;
        batch.push(() =>
          insertActivity.run(roomId, memberId, ts, capturedSeq, capturedType, null, null, capturedOffset),
        );
        progress.events += 1;
      }

      if (event.type === "message_end" && event.usage) {
        const u = event.usage;
        const date = utcDate(ts);
        batch.push(() =>
          upsertUsage.run(
            roomId,
            memberId,
            date,
            u.inputTokens || 0,
            u.outputTokens || 0,
            u.cacheRead || 0,
            u.cacheWrite || 0,
            u.cost || 0,
          ),
        );
        progress.usageRows += 1;
      }

      if (batch.length >= BATCH_SIZE) flush();
    }
    flush();

    setWatermark(db, "events", roomId, memberId, {
      lastTs,
      lastSeq: seq,
      lastMtimeMs: stat.mtimeMs,
    });
    progress.members += 1;
  } finally {
    await fh.close();
  }
}

function backfillRoomTasks(db: BossmodeDb, roomId: string, progress: BackfillProgress): void {
  const tasksPath = join(roomDir(roomId), "tasks.json");
  if (!existsSync(tasksPath)) return;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(tasksPath, "utf-8"));
  } catch {
    return;
  }
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.tasks) ? (raw as any).tasks : [];
  if (list.length === 0) return;

  const upsert = db.raw.prepare(
    `INSERT OR REPLACE INTO tasks (room_id, task_id, title, status, priority, assignee, created_at, updated_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.raw.exec("BEGIN");
  try {
    for (const t of list) {
      if (!t || typeof t.id !== "string") continue;
      upsert.run(
        roomId,
        t.id,
        String(t.title ?? ""),
        String(t.status ?? "todo"),
        t.priority ?? null,
        t.assignee ?? null,
        typeof t.createdAt === "number" ? t.createdAt : null,
        typeof t.updatedAt === "number" ? t.updatedAt : null,
        JSON.stringify(t),
      );
      progress.tasks += 1;
    }
    db.raw.exec("COMMIT");
  } catch (err) {
    db.raw.exec("ROLLBACK");
    throw err;
  }
  const stat = statSync(tasksPath);
  setWatermark(db, "tasks", roomId, "", { lastMtimeMs: stat.mtimeMs });
}

/**
 * Full rebuild of the projection from files. Idempotent (upserts). Yields the
 * event loop between rooms so startup / CLI stays responsive.
 */
export async function backfillAll(db: BossmodeDb): Promise<BackfillProgress> {
  const progress: BackfillProgress = {
    rooms: 0,
    members: 0,
    events: 0,
    usageRows: 0,
    tasks: 0,
    skippedNameKeyedFiles: 0,
  };
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return progress;

  // A full backfill is authoritative from files. token_usage_daily uses additive
  // upserts (correct for the live incremental write path), so re-running on a
  // populated DB would double-count. Clear the projection tables this framework
  // owns first — the DB is disposable and every row is re-derived below.
  db.transaction((tx) => {
    tx.exec("DELETE FROM token_usage_daily");
    tx.exec("DELETE FROM activity_events");
    tx.exec("DELETE FROM tasks");
    tx.exec("DELETE FROM ingest_watermark");
  });

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    logger.error("db", "backfill failed to list rooms", { error: String(err) });
    return progress;
  }

  for (const roomId of roomIds) {
    try {
      const { files, skippedNameKeyed } = resolveMemberEventFiles(roomId);
      progress.skippedNameKeyedFiles += skippedNameKeyed;
      for (const { memberId, file } of files) {
        await backfillMemberFile(
          db,
          roomId,
          memberId,
          join(roomDir(roomId), "agent-events", file),
          progress,
        );
      }
      backfillRoomTasks(db, roomId, progress);
      progress.rooms += 1;
    } catch (err) {
      logger.error("db", "backfill failed for room", { roomId, error: String(err) });
    }
    // Yield between rooms so a large workspace does not stall the loop.
    await new Promise((r) => setImmediate(r));
  }

  logger.info("db", "backfill complete", { ...progress });
  return progress;
}
