// Explicit SQLite lifecycle. Importing this module and obtaining a missing context
// never creates a directory, opens a database, or runs a migration.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface StorageMigration {
  readonly id: string;
  readonly sql: string;
  /** Table rebuilds only: run this migration with `foreign_keys=OFF` (the pragma
   *  is a no-op inside a transaction, so the runner toggles it around the step)
   *  and restore enforcement after. Use for dropping/renaming a table that other
   *  tables reference; the SQL must end with `PRAGMA foreign_key_check;`. */
  readonly foreignKeysOff?: boolean;
}

export class Database {
  private depth = 0;
  private savepoint = 0;
  private closed = false;
  private transactionFailure: Error | undefined;
  private unusable: Error | undefined;
  private commitCallbacks: Array<() => void> = [];

  constructor(
    private readonly connection: DatabaseSync,
    readonly path: string,
    private readonly onPostCommitError: (error: unknown) => void = () => console.warn("Database post-commit observer failed"),
  ) {}

  /** Notifications/cache changes only; durable delivery belongs in the outbox.
   * Nested registrations wait for outer commit and are discarded on rollback.
   * Outside a transaction the preceding write is already committed, so run now.
   * Observer failures never misreport a committed transaction as rolled back.
   */
  afterCommit(callback: () => void): void {
    this.assertOpen();
    if (typeof callback !== "function") throw new Error("Post-commit callback must be a function");
    if (this.depth) this.commitCallbacks.push(callback);
    else this.observeCommit(callback);
  }

  /** File preparation/async services must not run inside an ambient SQL transaction. */
  assertOutsideTransaction(): void {
    this.assertOpen();
    if (this.connection.isTransaction) throw new Error("Operation requires no enclosing database transaction");
  }

  private observeCommit(callback: () => void): void {
    const report = (error: unknown) => { try { this.onPostCommitError(error); } catch { /* Commit already succeeded. */ } };
    try {
      const result = callback() as unknown;
      if (result && typeof (result as any).then === "function") void Promise.resolve(result).catch(report);
    } catch (error) { report(error); }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Database context is closed");
    if (this.unusable) throw this.unusable;
    if (this.depth > 0 && (this.transactionFailure || !this.connection.isTransaction)) {
      this.transactionFailure ??= new Error("Database transaction was aborted; further operations are refused until rollback");
      throw this.transactionFailure;
    }
  }

  exec(sql: string): void { this.assertOpen(); this.connection.exec(sql); }
  run(sql: string, ...params: unknown[]): void {
    this.assertOpen();
    this.connection.prepare(sql).run(...params as any[]);
  }
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    this.assertOpen();
    return this.connection.prepare(sql).get(...params as any[]) as T | undefined;
  }
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    this.assertOpen();
    return this.connection.prepare(sql).all(...params as any[]) as T[];
  }

  /** Synchronous only. Nested calls use savepoints, not independent commits. */
  transaction<T>(fn: (db: Database) => T): T {
    this.assertOpen();
    if (fn.constructor.name === "AsyncFunction") {
      throw new Error("Database transactions must be synchronous");
    }
    const outer = this.depth === 0;
    const callbackMark = this.commitCallbacks.length;
    let committed = false;
    const name = `bossmode_sp_${++this.savepoint}`;
    if (outer) this.transactionFailure = undefined;
    this.connection.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${name}`);
    this.depth++;
    let valid = true;
    const scoped = new Proxy(this, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!valid) throw new Error("Transaction context has expired");
          return value.apply(target, args);
        };
      },
    });
    transactionContexts.add(scoped);
    try {
      const result = fn(scoped);
      if (result != null && typeof (result as any).then === "function") {
        // Observe a rejected promise without treating it as committed work.
        void Promise.resolve(result).catch(() => {});
        throw new Error("Database transactions must not return promises");
      }
      this.assertOpen();
      this.connection.exec(outer ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
      committed = true;
      return result;
    } catch (error) {
      this.commitCallbacks.splice(callbackMark);
      try {
        if (this.connection.isTransaction) {
          this.connection.exec(outer ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}`);
          if (!outer) this.connection.exec(`RELEASE SAVEPOINT ${name}`);
        } else if (!outer) {
          this.transactionFailure = new Error("Database transaction was aborted while handling a nested operation");
        }
      } catch {
        this.transactionFailure = new Error("Database savepoint cleanup failed; outer transaction must roll back");
      }
      throw error;
    } finally {
      valid = false;
      this.depth--;
      if (outer) {
        if (this.connection.isTransaction) this.unusable = new Error("Database rollback failed; close this context before continuing");
        this.transactionFailure = undefined;
        const callbacks = this.commitCallbacks.splice(0);
        if (committed) for (const callback of callbacks) this.observeCommit(callback);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.depth) throw new Error("Cannot close a database during a transaction");
    this.connection.close();
    this.closed = true;
    if (active === this) active = undefined;
  }
}

const transactionContexts = new WeakSet<Database>();
let active: Database | undefined;

/** A consumer can use an initialized context, never initialize one implicitly. */
export function getDatabase(): Database {
  if (!active) throw new Error("Core database is not initialized; bootstrap must initialize storage before consumers run");
  return active;
}

/** Open a connection only. Schema/import/readiness and context binding are explicit. */
export function openDatabase(path: string, options: {onPostCommitError?: (error: unknown) => void} = {}): Database {
  if (!isAbsolute(path)) throw new Error("Database path must be absolute");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const connection = connect(path);
  const db = new Database(connection, path, options.onPostCommitError);
  try {
    // Settings and credentials share this store; sidecars must be private too.
    chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    for (const suffix of ["-wal", "-shm"]) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function sqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite");
}
function connect(path: string, readOnly = false): DatabaseSync {
  if (!isAbsolute(path)) throw new Error("Database path must be absolute");
  return new (sqlite().DatabaseSync)(path, { readOnly });
}

/** Synchronous inspection only; no directory creation, schema changes or context binding. */
export function inspectDatabase<T>(path: string, inspect: (db: Pick<Database, "get" | "all">) => T): T {
  const db = new Database(connect(path, true), path);
  try {
    const result = inspect(db);
    if (result && typeof (result as any).then === "function") {
      void Promise.resolve(result).catch(() => {});
      throw new Error("Database inspections must be synchronous");
    }
    return result;
  } finally { db.close(); }
}

/** SQLite-consistent backup; filesystem publication and durability belong to the caller. */
export async function backupDatabase(source: string, destination: string): Promise<void> {
  const connection = connect(source, true);
  try { await sqlite().backup(connection, destination); }
  finally { connection.close(); }
}

/** A process-death-safe SQL lock. Never unlink the database carrying the lock. */
export function lockDatabase(path: string, mode: "exclusive" | "immediate"): () => void {
  const connection = connect(path);
  try {
    connection.exec(mode === "exclusive" ? "BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER)" : "BEGIN IMMEDIATE");
  } catch (error) { connection.close(); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (connection.isTransaction) connection.exec("ROLLBACK"); }
    finally { connection.close(); }
  };
}

/** Checkpoint a closed application's WAL before replacing its database file. */
export function checkpointDatabase(path: string): { busy: number } | undefined {
  const db = new Database(connect(path), path);
  try { return db.get<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)"); }
  finally { db.close(); }
}

/** Only the composition root/test fixture binds the process context. */
export function bindDatabase(db: Database): void {
  if (transactionContexts.has(db)) throw new Error("Cannot bind a transaction-scoped database context");
  if (active && active !== db) throw new Error("A different database context is already bound");
  db.get("SELECT 1");
  active = db;
}

/** Applied history must be an exact, checksummed prefix of supported history. */
export function validateStorageMigrationHistory(db: Database, migrations: readonly StorageMigration[]): void {
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (!migration.id || ids.has(migration.id)) throw new Error(`Duplicate or empty storage migration ID: ${migration.id}`);
    ids.add(migration.id);
  }
  if (!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_schema_versions'")) return;
  const applied = db.all<{id: string; checksum: string}>("SELECT id, checksum FROM storage_schema_versions ORDER BY rowid");
  for (const [index, row] of applied.entries()) {
    const supported = migrations[index];
    if (!supported || supported.id !== row.id) throw new Error(`Unsupported or reordered storage migration history: ${row.id}`);
    if (row.checksum !== createHash("sha256").update(supported.sql).digest("hex")) throw new Error(`Applied storage migration changed: ${row.id}`);
  }
}

/** Ordered, transactional schema steps. Applied SQL cannot silently change. */
export function applyStorageMigrations(db: Database, migrations: readonly StorageMigration[]): void {
  validateStorageMigrationHistory(db, migrations);
  db.exec("CREATE TABLE IF NOT EXISTS storage_schema_versions (id TEXT NOT NULL PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  for (const migration of migrations) {
    const checksum = createHash("sha256").update(migration.sql).digest("hex");
    // foreign_keys can only be toggled outside a transaction; the runner never
    // holds one between migrations, so rebuild steps bracket their own step.
    if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.transaction(tx => {
        if (tx.get("SELECT 1 FROM storage_schema_versions WHERE id=?", migration.id)) return;
        tx.exec(migration.sql);
        tx.run("INSERT INTO storage_schema_versions (id, checksum, applied_at) VALUES (?, ?, ?)", migration.id, checksum, Date.now());
      });
    } finally {
      if (migration.foreignKeysOff) db.exec("PRAGMA foreign_keys=ON");
    }
  }
}

/** Encode an optional boolean for a nullable SQLite integer column. */
export function sqliteBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value);
}
