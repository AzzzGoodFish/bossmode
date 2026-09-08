// Projection lifecycle. Only projection tables may be rebuilt; members are authoritative.
// Initialization is tracked in SQLite rather than inferred from database file existence.
import { BossmodeDb, getDbPath, isDbAvailable, openDb } from "./sqlite.js";
import { backfillAll, type BackfillProgress } from "./backfill.js";
import { logger } from "../../foundation/logger.js";

export type BackfillStatus = "idle" | "running" | "ready" | "unavailable" | "error";

interface ProjectionState {
  db: BossmodeDb | null;
  status: BackfillStatus;
  progress: BackfillProgress | null;
  error: string | null;
}

let initialization: Promise<void> = Promise.resolve();

/** Startup awaits file reconstruction before event rekeying or live writes. */
export function waitForProjectionInitialization(): Promise<void> { return initialization; }

const state: ProjectionState = {
  db: null,
  status: "idle",
  progress: null,
  error: null,
};

export function getProjectionDb(): BossmodeDb | null {
  return state.db;
}

export function getBackfillStatus(): { status: BackfillStatus; progress: BackfillProgress | null; error: string | null } {
  return { status: state.status, progress: state.progress, error: state.error };
}

/**
 * Initialize the projection at startup. Non-blocking: when a fresh DB needs a
 * backfill, it runs in the background and status flips to "ready" on completion.
 * Returns immediately with the opened DB (or null if unavailable).
 */
export function initProjection(path: string = getDbPath()): BossmodeDb | null {
  if (!isDbAvailable()) {
    state.status = "unavailable";
    return null;
  }

  let db: BossmodeDb;
  try {
    db = openDb(path);
  } catch (err) {
    state.status = "error";
    state.error = String(err);
    logger.error("db", "failed to open projection", { error: String(err) });
    return null;
  }
  state.db = db;

  const initialized = db.get("SELECT value FROM projection_state WHERE key = ?", "backfill-complete");
  if (!initialized) {
    state.status = "running";
    // Fire and forget; never block startup.
    initialization = backfillAll(db)
      .then((progress) => {
        db.run("INSERT OR REPLACE INTO projection_state (key, value) VALUES (?, ?)", "backfill-complete", String(Date.now()));
        state.progress = progress;
        state.status = "ready";
      })
      .catch((err) => {
        state.status = "error";
        state.error = String(err);
        logger.error("db", "background backfill failed", { error: String(err) });
      });
  } else {
    state.status = "ready";
    // No startup scan: historical projection gaps (e.g. event types added to
    // INDEXED_TYPES after their watermark passed) are repaired on demand via
    // `bossmode heal-activity` (fish 2026-08-10: don't pay the scan every boot).
  }

  return db;
}

/** Rebuild projection tables only. Never removes authoritative members. */
export async function rebuildProjection(path: string = getDbPath()): Promise<BackfillProgress> {
  if (!isDbAvailable()) {
    throw new Error("node:sqlite is unavailable; cannot rebuild projection");
  }
  const db = openDb(path);
  db.run("DELETE FROM projection_state WHERE key = ?", "backfill-complete");
  const progress = await backfillAll(db);
  db.run("INSERT OR REPLACE INTO projection_state (key, value) VALUES (?, ?)", "backfill-complete", String(Date.now()));
  state.db = db;
  state.progress = progress;
  state.status = "ready";
  return progress;
}
