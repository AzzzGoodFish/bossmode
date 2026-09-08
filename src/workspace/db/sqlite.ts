// SQLite storage: members are authoritative; message/activity/task indexes are rebuildable.
// Never delete bossmode.db to repair an index. Member read/write failures propagate.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { getBossmodeDir } from "../../shared/config.js";
import { logger } from "../../foundation/logger.js";
import { runMigrations } from "./schema.js";

// node:sqlite is experimental; import lazily so a missing/older runtime yields a
// controlled failure instead of a hard module-load crash.
type DatabaseSync = import("node:sqlite").DatabaseSync;

export const DB_FILE_NAME = "bossmode.db";

export function getDbPath(): string {
  return join(getBossmodeDir(), DB_FILE_NAME);
}

let cached: BossmodeDb | null = null;

/**
 * Thin wrapper over node:sqlite DatabaseSync exposing the small surface S2/S3
 * need. Keeping this indirection means the rest of the codebase never imports
 * node:sqlite directly and stays swappable.
 */
export class BossmodeDb {
  readonly raw: DatabaseSync;
  readonly path: string;

  constructor(raw: DatabaseSync, path: string) {
    this.raw = raw;
    this.path = path;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Prepared-statement run for a single write. */
  run(sql: string, ...params: unknown[]): void {
    this.raw.prepare(sql).run(...(params as any[]));
  }

  /** Query returning all rows. */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(params as any[])) as T[];
  }

  /** Query returning the first row or undefined. */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(params as any[])) as T | undefined;
  }

  /** Run fn inside a single transaction; rolls back on throw. */
  transaction<T>(fn: (db: BossmodeDb) => T): T {
    this.raw.exec("BEGIN");
    try {
      const result = fn(this);
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* ignore rollback failure */
      }
      throw err;
    }
  }

  close(): void {
    try {
      this.raw.close();
    } catch {
      /* ignore */
    }
    if (cached === this) cached = null;
  }
}

function loadDatabaseSync(): new (path: string) => DatabaseSync {
  try {
    // node:sqlite is a builtin; import via createRequire to keep it out of the
    // static ESM graph (older runtimes lack the module entirely).
    const require = createRequire(import.meta.url);
    const mod = require("node:sqlite") as typeof import("node:sqlite");
    return mod.DatabaseSync;
  } catch (err) {
    throw new Error(
      `node:sqlite is unavailable (requires Node >=22.5): ${String(err)}. ` +
        `Member storage is unavailable; startup cannot continue.`,
    );
  }
}

/**
 * Open (or create) the database at the given path and apply migrations.
 * Returns a process-cached singleton for the default path.
 */
export function openDb(path: string = getDbPath()): BossmodeDb {
  if (cached && cached.path === path) return cached;

  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const Ctor = loadDatabaseSync();
  const raw = new Ctor(path);
  // Member identity/configuration is authoritative: commits must be durable.
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = FULL");
  raw.exec("PRAGMA foreign_keys = ON");

  const db = new BossmodeDb(raw, path);
  try { runMigrations(db); } catch (err) { db.close(); throw err; }
  cached = db;
  return db;
}

/** Whether the projection DB is usable in this runtime (node:sqlite present). */
export function isDbAvailable(): boolean {
  try {
    loadDatabaseSync();
    return true;
  } catch (err) {
    logger.warn("db", "SQLite projection unavailable", { error: String(err) });
    return false;
  }
}

/** Test/CLI helper: drop the process cache so a fresh path opens cleanly. */
export function resetDbCache(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}
