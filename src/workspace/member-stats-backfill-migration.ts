// Migration: member-stats-backfill-v1
// One-time backfill of the persistent per-member stats file (turns/tool
// calls/active time/tokens) from each member's existing agent-events JSONL.
// After this runs, the running server keeps stats current incrementally
// (event-handler.ts); this migration only seeds history that predates the
// stats accumulator so existing members show real historical numbers instead
// of starting from zero.
//
// Idempotent by existence: a member's stats file is only computed once (a
// running server keeps it current afterward, so re-deriving unconditionally
// on every startup would both be wasteful and could double-count events the
// accumulator already recorded). Skips cleanly when there is no agent-events
// data yet.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getRoomsDir } from "./room-store.js";
import { computeStatsFromEvents, statsFileExists, writeBackfilledStats } from "./member-stats-store.js";

const MIGRATION_ID = "member-stats-backfill-v1";

function markerPath(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime", ".migrations", `${MIGRATION_ID}.json`);
}
interface MigrationMarker {
  rooms: Record<string, boolean>;
}
function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return fallback; }
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}
function readMarker(): MigrationMarker {
  const marker = readJson<Partial<MigrationMarker>>(markerPath(), {});
  return { rooms: marker.rooms || {} };
}
function writeMarker(marker: MigrationMarker): void {
  writeJson(markerPath(), { migration: MIGRATION_ID, ...marker, updatedAt: Date.now() });
}

function migrateRoom(roomId: string): number {
  const dir = join(getRoomsDir(), roomId, "agent-events");
  if (!existsSync(dir)) return 0;
  let seeded = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const memberRef = file.slice(0, -".jsonl".length);
    if (statsFileExists(roomId, memberRef)) continue; // already seeded or already live-accumulating
    try {
      const content = readFileSync(join(dir, file), "utf-8").trim();
      if (!content) continue;
      const events = content.split("\n").map((line) => JSON.parse(line));
      const stats = computeStatsFromEvents(events);
      writeBackfilledStats(roomId, memberRef, stats);
      seeded += 1;
    } catch (err) {
      logger.error("migration", "member-stats-backfill-v1 failed to backfill member", { roomId, memberRef, error: String(err) });
    }
  }
  return seeded;
}

export function runMemberStatsBackfillMigration(): void {
  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) return;
  const marker = readMarker();
  let markerChanged = false;

  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    logger.error("migration", "member-stats-backfill-v1 failed to list rooms", { error: String(err) });
    return;
  }

  for (const roomId of roomIds) {
    let seeded = 0;
    try {
      seeded = migrateRoom(roomId);
    } catch (err) {
      logger.error("migration", "member-stats-backfill-v1 failed to migrate room", { roomId, error: String(err) });
    }
    if (seeded > 0) logger.info("migration", "member-stats-backfill-v1 seeded room", { roomId, seeded });
    if (!marker.rooms[roomId]) {
      marker.rooms[roomId] = true;
      markerChanged = true;
    }
  }

  if (markerChanged) writeMarker(marker);
}
