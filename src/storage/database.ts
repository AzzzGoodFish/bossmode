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
}

export class Database {
  private depth = 0;
  private savepoint = 0;
  private closed = false;
  private transactionFailure: Error | undefined;
  private unusable: Error | undefined;

  constructor(private readonly connection: DatabaseSync, readonly path: string) {}

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
      return result;
    } catch (error) {
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
export function openDatabase(path: string): Database {
  if (!isAbsolute(path)) throw new Error("Database path must be absolute");
  const require = createRequire(import.meta.url);
  const { DatabaseSync: Connection } = require("node:sqlite") as typeof import("node:sqlite");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const connection = new Connection(path);
  const db = new Database(connection, path);
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
    db.transaction(tx => {
      if (tx.get("SELECT 1 FROM storage_schema_versions WHERE id=?", migration.id)) return;
      tx.exec(migration.sql);
      tx.run("INSERT INTO storage_schema_versions (id, checksum, applied_at) VALUES (?, ?, ?)", migration.id, checksum, Date.now());
    });
  }
}
