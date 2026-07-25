// Projection lifecycle: open the DB, decide backfill vs catch-up, expose status.
//
// Startup policy (spec v1):
//   - DB missing  → create schema, kick async backfill; status = "running"
//                   until done, then "ready". APIs may return partial data.
//   - DB present   → open (migrations apply), status = "ready". Incremental
//                   catch-up for files newer than their watermark is handled by
//                   the live write path (S2/S3) + `bossmode db rebuild`.
//
// The projection is best-effort: if node:sqlite is unavailable the whole layer
// disables and the product keeps working on files alone.
import { existsSync } from "node:fs";
import { BossmodeDb, getDbPath, isDbAvailable, openDb } from "./sqlite.js";
import { backfillAll, type BackfillProgress } from "./backfill.js";
import { backfillModelHistory, type ModelBackfillReport } from "./model-history-backfill.js";
import { logger } from "../../foundation/logger.js";

export type BackfillStatus = "idle" | "running" | "ready" | "unavailable" | "error";

interface ProjectionState {
  db: BossmodeDb | null;
  status: BackfillStatus;
  progress: BackfillProgress | null;
  error: string | null;
}

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

  const fresh = !existsSync(path);
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

  if (fresh) {
    state.status = "running";
    // Fire and forget; never block startup.
    void backfillAll(db)
      .then((progress) => {
        state.progress = progress;
        // Attribute historical unknown usage to real models from session timelines.
        try { backfillModelHistory(db); } catch (err) { logger.error("db", "model-history backfill failed", { error: String(err) }); }
        state.status = "ready";
      })
      .catch((err) => {
        state.status = "error";
        state.error = String(err);
        logger.error("db", "background backfill failed", { error: String(err) });
      });
  } else {
    state.status = "ready";
  }

  return db;
}

/**
 * Synchronous full rebuild (used by `bossmode db rebuild` CLI and tests).
 * Opens the DB (creating schema), runs backfill to completion, returns progress.
 */
export async function rebuildProjection(path: string = getDbPath()): Promise<BackfillProgress> {
  if (!isDbAvailable()) {
    throw new Error("node:sqlite is unavailable; cannot rebuild projection");
  }
  const db = openDb(path);
  const progress = await backfillAll(db);
  // Attribute historical unknown usage to real models (task ④). Idempotent.
  try {
    const report = backfillModelHistory(db);
    progress.modelHistory = report;
  } catch (err) {
    logger.error("db", "model-history backfill failed", { error: String(err) });
  }
  state.db = db;
  state.progress = progress;
  state.status = "ready";
  return progress;
}
