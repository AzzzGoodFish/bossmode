/**
 * Migration: agent-events-rekey-v1 (F5)
 *
 * Rekeys legacy member activity artifacts under rooms/<id>/agent-events/ to the
 * member's mem_ identity, using the room roster as the explicit evidence chain
 * (roomMembers[].sourceMemberId → registry; no fuzzy matching):
 *
 *   rm_<uuid>  → roomMembers id match → sourceMemberId (mem_) → else name → registry unique hit
 *   bare name  → roomMembers name match → sourceMemberId → else registry unique hit
 *   mem_<uuid> → registry exists → skip
 *   unresolvable → orphan: left in place + warn (never guessed, never deleted)
 *
 * Merge rule: when both the legacy key and the mem_ key have a jsonl, the
 * legacy file (historical segment) goes first, then the current one; the merge
 * point's ts is checked for monotonicity — non-monotonic merges still merge
 * (ts-sorted) but warn.
 *
 * Derived projections are NOT migrated — they are discarded and rebuilt:
 *   - <key>.stats.json caches: both the old and the mem_ key cache are deleted;
 *     member-stats-store re-derives from the merged jsonl on next read.
 *   - SQLite activity_events rows + ingest watermarks for every affected
 *     (room_id, member_id): deleted; catchUpActivityIndex re-backfills from the
 *     merged jsonl (avoids byte_offset bookkeeping entirely).
 *
 * Safety: a snapshot of each affected room's agent-events/ dir (plus the
 * projection DB when present) is copied to backups/agent-events-rekey-<ts>/
 * before any mutation. Data-driven idempotency: re-running finds no resolvable
 * legacy files → no-op. Runs once per startup in the migration chain.
 *
 * Boundaries (explicitly out of scope): rooms/dm:* phantom dirs are skipped
 * (their keys are already mem_); room.json is never modified.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getRoomsDir, listRooms, getRoom } from "./room-store.js";
import { getMember, listMembers, type MemberRecord } from "./member-registry.js";
import { getProjectionDb } from "./db/projection.js";
import { catchUpActivityIndex } from "./db/activity-index.js";
import { DB_FILE_NAME } from "./db/sqlite.js";
import { computeStatsFromEvents, writeBackfilledStats } from "./member-stats-store.js";

const MIGRATION_ID = "agent-events-rekey-v1";
const EVENTS_DIR = "agent-events";

export interface AgentEventsRekeyResult {
  skipped: boolean;
  roomsScanned: number;
  roomsWithChanges: number;
  filesRenamed: number;
  filesMerged: number;
  statsCachesRemoved: number;
  orphans: Array<{ roomId: string; key: string }>;
  dbRowsRemoved: number;
}

/** Unique registry hit by normalized name — the spec's "唯一命中才可". */
function uniqueMemberByName(name: string): MemberRecord | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const hits = listMembers().filter((m) => m.name.trim().toLowerCase() === n);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Resolve a legacy artifact key to a mem_ member id through the explicit
 * evidence chain. Returns null when the key is not resolvable (orphan).
 */
function resolveLegacyKey(roomId: string, key: string): { memId: string } | null {
  if (key.startsWith("mem_")) {
    // Already current identity — only skip when the member exists.
    return getMember(key) ? { memId: key } : null;
  }
  const room = getRoom(roomId);
  const rosterHit = room?.roomMembers?.find((m) => m.id === key || m.name === key);
  if (rosterHit?.sourceMemberId?.startsWith("mem_") && getMember(rosterHit.sourceMemberId)) {
    return { memId: rosterHit.sourceMemberId };
  }
  const byName = uniqueMemberByName(rosterHit?.name || key);
  return byName ? { memId: byName.id } : null;
}

function eventsDir(roomId: string): string {
  return join(getRoomsDir(), roomId, EVENTS_DIR);
}

function keyFiles(dir: string): Array<{ key: string; jsonl?: string; stats?: string }> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".stats.json"));
  const byKey = new Map<string, { key: string; jsonl?: string; stats?: string }>();
  for (const f of files) {
    const m = f.match(/^(.*)\.(jsonl|stats\.json)$/);
    if (!m) continue;
    const entry = byKey.get(m[1]) || { key: m[1] };
    if (m[2] === "jsonl") entry.jsonl = f;
    else entry.stats = f;
    byKey.set(m[1], entry);
  }
  return [...byKey.values()];
}

/** Snapshot a room's agent-events dir into backups/ (the event files are the
 * source of truth — this is the rollback material). */
function snapshotRoom(roomId: string, snapRoot: string): void {
  const src = eventsDir(roomId);
  const dst = join(snapRoot, roomId);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    copyFileSync(join(src, f), join(dst, f));
  }
}

/** Best-effort snapshot of the projection DB (WAL files included). The DB is a
 * rebuildable projection, so this is belt-and-suspenders, not the safety core. */
function snapshotDb(snapRoot: string): void {
  mkdirSync(snapRoot, { recursive: true });
  const base = join(getBossmodeDir(), DB_FILE_NAME);
  if (!existsSync(base)) return;
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = base + suffix;
    if (existsSync(p)) copyFileSync(p, join(snapRoot, DB_FILE_NAME + suffix));
  }
}

/** Merge legacy jsonl (historical) + current jsonl into one ts-ordered stream. */
function mergeJsonl(legacyPath: string, currentPath: string): { lines: string[]; nonMonotonic: boolean } {
  const readLines = (p: string): Array<{ line: string; ts: number | null }> => {
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((line) => {
        let ts: number | null = null;
        try {
          const parsed = JSON.parse(line) as { ts?: number };
          ts = typeof parsed.ts === "number" ? parsed.ts : null;
        } catch { /* keep null */ }
        return { line, ts };
      });
  };
  const legacy = readLines(legacyPath);
  const current = readLines(currentPath);
  let nonMonotonic = false;
  if (legacy.length && current.length) {
    const lastLegacy = legacy[legacy.length - 1].ts;
    const firstCurrent = current[0].ts;
    if (lastLegacy != null && firstCurrent != null && lastLegacy > firstCurrent) nonMonotonic = true;
  }
  const merged = [...legacy, ...current];
  if (nonMonotonic) {
    // Keep stable order within each segment; only cross-segment inversions sort.
    merged.sort((a, b) => {
      const at = a.ts ?? 0;
      const bt = b.ts ?? 0;
      if (at !== bt) return at - bt;
      return 0;
    });
  }
  return { lines: merged.map((m) => m.line), nonMonotonic };
}

function deleteProjectionRows(roomId: string, keys: string[]): number {
  const db = getProjectionDb();
  if (!db) return 0;
  let removed = 0;
  try {
    db.raw.exec("BEGIN");
    try {
      const delEvents = db.raw.prepare("DELETE FROM activity_events WHERE room_id = ? AND member_id = ?");
      const delWm = db.raw.prepare("DELETE FROM ingest_watermark WHERE kind = 'events' AND room_id = ? AND member_id = ?");
      for (const key of keys) {
        removed += Number(delEvents.run(roomId, key).changes);
        delWm.run(roomId, key);
      }
      db.raw.exec("COMMIT");
    } catch (err) {
      db.raw.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    logger.error("agent-events-rekey", "projection row cleanup failed", { roomId, error: String(err) });
  }
  return removed;
}

interface RoomPlan {
  roomId: string;
  /** legacy key → mem_ target, when the mem jsonl does NOT exist yet (pure rename) */
  renames: Array<{ key: string; memId: string }>;
  /** legacy key → mem_ target, when the mem jsonl already exists (merge) */
  merges: Array<{ key: string; memId: string }>;
  /** stats cache paths to delete (old key + mem key), absolute */
  statsPaths: string[];
  affectedKeys: Set<string>;
  memTargets: Set<string>;
}

/** Phase 1 — compute what would change WITHOUT mutating or snapshotting.
 * Returns null when the room has nothing to move (re-run fast path: no
 * snapshot, no copy — architect P1 gate). Orphans are reported here. */
function planRoom(roomId: string, result: AgentEventsRekeyResult): RoomPlan | null {
  const dir = eventsDir(roomId);
  if (!existsSync(dir)) return null;
  const files = keyFiles(dir);
  if (files.length === 0) return null;

  const plan: RoomPlan = { roomId, renames: [], merges: [], statsPaths: [], affectedKeys: new Set(), memTargets: new Set() };
  for (const { key, jsonl, stats } of files) {
    const resolved = resolveLegacyKey(roomId, key);
    if (!resolved) {
      if (!key.startsWith("mem_")) {
        result.orphans.push({ roomId, key });
        logger.warn("agent-events-rekey", "orphan artifact left in place (unresolvable identity)", { roomId, key });
      }
      continue;
    }
    if (key === resolved.memId) continue; // already current identity
    plan.affectedKeys.add(key);
    plan.affectedKeys.add(resolved.memId);
    plan.memTargets.add(resolved.memId);
    if (jsonl) {
      if (existsSync(join(dir, `${resolved.memId}.jsonl`))) plan.merges.push({ key, memId: resolved.memId });
      else plan.renames.push({ key, memId: resolved.memId });
    }
    if (stats) plan.statsPaths.push(join(dir, stats));
    plan.statsPaths.push(join(dir, `${resolved.memId}.stats.json`));
  }
  return plan.affectedKeys.size > 0 ? plan : null;
}

/** Phase 2 — execute a planned room: snapshot only here, then mutate. */
function executeRoom(plan: RoomPlan, snapRoot: string, result: AgentEventsRekeyResult): void {
  const { roomId } = plan;
  const dir = eventsDir(roomId);
  snapshotRoom(roomId, snapRoot);

  for (const { key, memId } of plan.renames) {
    renameSync(join(dir, `${key}.jsonl`), join(dir, `${memId}.jsonl`));
    result.filesRenamed += 1;
  }
  for (const { key, memId } of plan.merges) {
    const legacyPath = join(dir, `${key}.jsonl`);
    const currentPath = join(dir, `${memId}.jsonl`);
    const { lines, nonMonotonic } = mergeJsonl(legacyPath, currentPath);
    if (nonMonotonic) {
      logger.warn("agent-events-rekey", "merged jsonl non-monotonic at merge point (ts-sorted)", { roomId, key, memId });
    }
    writeFileSync(currentPath, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
    rmSync(legacyPath);
    result.filesMerged += 1;
  }
  for (const p of plan.statsPaths) {
    if (existsSync(p)) {
      rmSync(p);
      result.statsCachesRemoved += 1;
    }
  }

  result.roomsWithChanges += 1;
  result.dbRowsRemoved += deleteProjectionRows(roomId, [...plan.affectedKeys]);
  for (const memId of plan.memTargets) {
    try {
      catchUpActivityIndex(roomId, memId);
    } catch (err) {
      logger.error("agent-events-rekey", "catch-up reindex failed (self-heals later)", { roomId, memberId: memId, error: String(err) });
    }
    // Re-derive the stats cache from the merged jsonl so reads are correct in
    // this very run (backfill migration only re-seeds on a later startup).
    try {
      const mergedPath = join(dir, `${memId}.jsonl`);
      if (existsSync(mergedPath)) {
        const events = readFileSync(mergedPath, "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          })
          .filter((e) => e !== null);
        writeBackfilledStats(roomId, memId, computeStatsFromEvents(events));
      }
    } catch (err) {
      logger.error("agent-events-rekey", "stats re-derivation failed (next startup backfills)", { roomId, memberId: memId, error: String(err) });
    }
  }
}

export function runAgentEventsRekeyMigration(): AgentEventsRekeyResult {
  const result: AgentEventsRekeyResult = {
    skipped: false,
    roomsScanned: 0,
    roomsWithChanges: 0,
    filesRenamed: 0,
    filesMerged: 0,
    statsCachesRemoved: 0,
    orphans: [],
    dbRowsRemoved: 0,
  };
  const rooms = listRooms().filter((r) => !r.id.startsWith("dm:"));
  result.roomsScanned = rooms.length;

  // Phase 1 — plan only. No snapshot, no copy until we know something moves.
  const plans: RoomPlan[] = [];
  for (const room of rooms) {
    try {
      const plan = planRoom(room.id, result);
      if (plan) plans.push(plan);
    } catch (err) {
      logger.error("agent-events-rekey", "room plan failed", { roomId: room.id, error: String(err) });
    }
  }

  // Gate: nothing to migrate → zero snapshots, zero copies (architect P1).
  if (plans.length === 0) {
    result.skipped = true;
    return result;
  }

  const snapRoot = join(getBossmodeDir(), "backups", `agent-events-rekey-${Date.now()}`);
  snapshotDb(snapRoot);
  for (const plan of plans) {
    try {
      executeRoom(plan, snapRoot, result);
    } catch (err) {
      logger.error("agent-events-rekey", "room migration failed", { roomId: plan.roomId, error: String(err) });
    }
  }
  return result;
}
