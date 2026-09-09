// Startup-only authority cutover. No CLI action flags and no live legacy fallback.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { applyStorageMigrations, validateStorageMigrationHistory, openDatabase, type Database, type StorageMigration } from "./database.js";
import { copyDurably, publishAssetDurably, ensurePrivateDirectory, hashFile, managedPath, moveDurably, requireRegularFile, syncDirectory, syncFile, writeDurably } from "./upgrade-files.js";

type NativeSqlite = typeof import("node:sqlite");
export type UpgradePhase = "checking" | "backing-up" | "importing" | "validating" | "cutover" | "retiring" | "ready";
export interface UpgradeProgress { phase: UpgradePhase; completed?: number; total?: number; }
export interface UpgradeImportContext {
  readonly db: Database;
  readonly root: string;
  readonly sourceRoot: string;
  readonly previousDatabase: string | undefined;
  /** Only these snapshotted sources may be read by legacy import adapters. */
  readonly sourceFiles: readonly string[];
  readonly legacy: boolean;
  progress(completed: number, total?: number): void;
  /** New allowed file bodies only; existing different content is never overwritten. */
  stageAsset(relativePath: string, bytes: Uint8Array): void;
}
export interface UpgradeOptions {
  root: string;
  formatVersion: number;
  migrations: readonly StorageMigration[];
  collectLegacySources(root: string): Promise<readonly string[]>;
  importData(context: UpgradeImportContext): Promise<void>;
  validate(context: UpgradeImportContext): Promise<void>;
  onProgress?(progress: UpgradeProgress): void;
  /** Production binds/starts consumers and publishes PID ownership before the lease is released. */
  activate?(db: Database): Promise<void>;
  /** Dependency-injected failure hook for isolated tests, never read from environment. */
  checkpoint?(phase: "backup" | "import" | "validated" | "activated"): void;
}
export interface UpgradeResult { db: Database; migrated: boolean; backupDirectory?: string; warnings: string[]; }
interface Authority { format: number; schema: string; }
interface SourceRecord { path: string; backup_path: string; hash: string; }
interface PreparedAsset { path: string; staged: string; hash: string; }
const authorityKey = "core-authority";

function native(): NativeSqlite {
  return createRequire(import.meta.url)("node:sqlite") as NativeSqlite;
}
function schemaDigest(migrations: readonly StorageMigration[]): string {
  return createHash("sha256").update(JSON.stringify(migrations.map(m => [m.id, m.sql]))).digest("hex");
}
function inspectAuthority(path: string): Authority | undefined {
  if (!existsSync(path)) return undefined;
  requireRegularFile(path);
  const db = new (native().DatabaseSync)(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_meta'").get()) return undefined;
    const row = db.prepare("SELECT value FROM storage_meta WHERE key=?").get(authorityKey) as { value: string } | undefined;
    if (!row) return undefined;
    const marker = JSON.parse(row.value) as Authority;
    if (!Number.isSafeInteger(marker.format) || marker.format < 1 || typeof marker.schema !== "string") throw new Error("Invalid core storage authority marker");
    return marker;
  } finally { db.close(); }
}

function assertServiceStopped(root: string): void {
  const path = join(root, "bossmode.pid");
  if (!existsSync(path)) return;
  requireRegularFile(path);
  const value = readFileSync(path, "utf8").trim();
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Cannot verify service ownership: invalid PID record");
  const pid = Number(value);
  if (pid === process.pid) return;
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
  throw new Error("Another Bossmode process still owns this data directory");
}

/** Independent SQLite lease is released by the OS on process death, never unlink it. */
function acquireLease(root: string): () => void {
  const directory = managedPath(root, "upgrades");
  ensurePrivateDirectory(directory); syncDirectory(root);
  const path = managedPath(root, "upgrades/lease.sqlite");
  if (existsSync(path)) requireRegularFile(path);
  const lease = new (native().DatabaseSync)(path);
  try { chmodSync(path, 0o600); lease.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER)"); }
  catch (error) { lease.close(); throw new Error("Cannot acquire startup upgrade lease", { cause: error }); }
  return () => { try { lease.exec("ROLLBACK"); } finally { lease.close(); } };
}

async function snapshotDatabase(source: string, target: string): Promise<void> {
  requireRegularFile(source);
  const db = new (native().DatabaseSync)(source, { readOnly: true });
  try { await native().backup(db, target); }
  finally { db.close(); }
  chmodSync(target, 0o600); syncFile(target);
}

/** Quarantine an interrupted staging database. Authoritative source data is unchanged. */
function quarantineStage(root: string, stage: string): void {
  if (!existsSync(stage)) return;
  requireRegularFile(stage);
  const destination = managedPath(root, `upgrades/interrupted-${randomUUID()}`);
  ensurePrivateDirectory(destination);
  // Keep the whole WAL bundle; do not guess whether a killed process checkpointed.
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = stage + suffix;
    if (existsSync(source)) { requireRegularFile(source); moveDurably(source, join(destination, "staging.sqlite" + suffix)); }
  }
}

async function retireSources(root: string, db: Database, warnings: string[], report: (p: UpgradeProgress) => void): Promise<void> {
  const rows = db.all<SourceRecord>("SELECT path, backup_path, hash FROM storage_upgrade_files WHERE retired_at IS NULL ORDER BY path");
  let completed = 0;
  for (const record of rows) {
    try {
      const source = managedPath(root, record.path);
      const backup = managedPath(root, record.backup_path);
      if (await hashFile(backup) !== record.hash) throw new Error("Recovery backup no longer matches its recorded source");
      if (existsSync(source)) {
        if (await hashFile(source) !== record.hash) throw new Error("Legacy source changed after cutover; preserved without overwriting");
        const destination = backup + ".retired";
        if (existsSync(destination)) throw new Error("Retirement destination already exists");
        moveDurably(source, destination); chmodSync(destination, 0o600);
      }
      db.run("UPDATE storage_upgrade_files SET retired_at=? WHERE path=?", Date.now(), record.path);
    } catch {
      // Authority has already switched. Retain old files and report, never fall back.
      warnings.push(`Legacy source retirement pending: ${record.path}`);
    }
    report({ phase: "retiring", completed: ++completed, total: rows.length });
  }
}

/** Returns an unbound context. Bootstrap binds it only before initializing consumers. */
export async function prepareStorageUpgrade(options: UpgradeOptions): Promise<UpgradeResult> {
  if (!isAbsolute(options.root)) throw new Error("Upgrade data root must be absolute");
  if (!Number.isSafeInteger(options.formatVersion) || options.formatVersion < 1) throw new Error("Invalid target storage version");
  if (!existsSync(options.root)) ensurePrivateDirectory(options.root);
  const root = realpathSync(options.root);
  assertServiceStopped(root);
  const release = acquireLease(root);
  const warnings: string[] = [];
  const report = (progress: UpgradeProgress) => {
    try { options.onProgress?.(progress); }
    catch { warnings.push("Upgrade progress observer failed"); }
  };
  let db: Database | undefined;
  let sourceGuard: import("node:sqlite").DatabaseSync | undefined;
  try {
    report({ phase: "checking" });
    assertServiceStopped(root);
    const main = managedPath(root, "bossmode.db");
    const expected: Authority = { format: options.formatVersion, schema: schemaDigest(options.migrations) };
    const previous = inspectAuthority(main);
    if (previous && previous.format > expected.format) throw new Error("Database was written by a newer storage format; refusing a downgrade");
    if (previous?.format === expected.format && previous.schema === expected.schema) {
      db = openDatabase(main);
      validateStorageMigrationHistory(db, options.migrations);
      await retireSources(root, db, warnings, report);
      await options.activate?.(db);
      report({ phase: "ready" });
      const result = db; db = undefined;
      return { db: result, migrated: false, warnings };
    }

    if (existsSync(main)) {
      sourceGuard = new (native().DatabaseSync)(main);
      sourceGuard.exec("BEGIN IMMEDIATE");
    }
    const stage = managedPath(root, "upgrades/staging.sqlite");
    quarantineStage(root, stage);
    const backupName = `backups/core-upgrade-${randomUUID()}`;
    const backupDirectory = managedPath(root, backupName);
    ensurePrivateDirectory(backupDirectory); syncDirectory(root);
    const sourceRoot = join(backupDirectory, "files");
    ensurePrivateDirectory(sourceRoot);
    const sourceFiles = previous ? [] : [...new Set(await options.collectLegacySources(root))].sort();
    const records: SourceRecord[] = [];
    report({ phase: "backing-up", completed: 0, total: sourceFiles.length });
    for (const name of sourceFiles) {
      const source = managedPath(root, name);
      // Coordinator artifacts/database are never ordinary legacy sources.
      if (/^(?:bossmode\.db(?:-|$)|bossmode\.pid$|upgrades\/|backups\/)/.test(name)) throw new Error("Invalid legacy source inventory");
      const destination = managedPath(sourceRoot, name);
      const hash = await hashFile(source);
      copyDurably(source, destination);
      if (await hashFile(destination) !== hash || await hashFile(source) !== hash) throw new Error(`Source changed during backup: ${name}`);
      records.push({ path: name, backup_path: relative(root, destination), hash });
      report({ phase: "backing-up", completed: records.length, total: sourceFiles.length });
    }
    let previousDatabase: string | undefined;
    if (existsSync(main)) {
      previousDatabase = join(backupDirectory, "database-before.sqlite");
      await snapshotDatabase(main, previousDatabase);
      copyDurably(previousDatabase, stage);
    }
    syncDirectory(backupDirectory);
    options.checkpoint?.("backup");

    db = openDatabase(stage);
    applyStorageMigrations(db, options.migrations);
    db.exec("CREATE TABLE IF NOT EXISTS storage_upgrade_files (path TEXT NOT NULL PRIMARY KEY, backup_path TEXT NOT NULL, hash TEXT NOT NULL, retired_at INTEGER)");
    db.transaction(tx => {
      for (const row of records) tx.run("INSERT INTO storage_upgrade_files(path,backup_path,hash) VALUES(?,?,?)", row.path, row.backup_path, row.hash);
    });
    const prepared: PreparedAsset[] = [];
    const context: UpgradeImportContext = {
      db, root, sourceRoot, previousDatabase, sourceFiles, legacy: !previous,
      progress: (completed, total) => report({ phase: "importing", completed, total }),
      stageAsset: (name, bytes) => {
        const live = managedPath(root, name);
        if (!/^(?:members|rooms|memory|agents)\/.+\.md$/.test(name) || sourceFiles.includes(name)) throw new Error("Generated asset must be a retained Markdown body, not application storage");
        const hash = createHash("sha256").update(bytes).digest("hex");
        if (prepared.some(asset => asset.path === name)) throw new Error("Duplicate generated asset path");
        const staged = managedPath(backupDirectory, "assets/" + name);
        writeDurably(staged, bytes);
        prepared.push({ path: relative(root, live), staged, hash });
      },
    };
    report({ phase: "importing", completed: 0 });
    await options.importData(context);
    options.checkpoint?.("import");
    report({ phase: "validating" });
    await options.validate(context);
    if (db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check !== "ok" || db.all("PRAGMA foreign_key_check").length) throw new Error("Staging database validation failed");
    for (const record of records) if (await hashFile(managedPath(root, record.path)) !== record.hash) throw new Error(`Source changed before cutover: ${record.path}`);
    for (const asset of prepared) {
      const destination = managedPath(root, asset.path);
      if (existsSync(destination)) {
        if (await hashFile(destination) !== asset.hash) throw new Error(`Existing asset differs: ${asset.path}`);
      } else publishAssetDurably(asset.staged, destination);
    }
    options.checkpoint?.("validated");
    db.transaction(tx => tx.run("INSERT INTO storage_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", authorityKey, JSON.stringify(expected)));
    const checkpoint = db.get<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
    if (!checkpoint || checkpoint.busy) throw new Error("Staging database is still in use; cutover refused");
    db.close(); db = undefined;
    if (existsSync(stage + "-wal") || existsSync(stage + "-shm")) throw new Error("Staging database sidecars remain in use; cutover refused");
    syncFile(stage);
    report({ phase: "cutover" });
    // The old file's WAL must not be replayed onto the replacement DB.
    if (sourceGuard) { sourceGuard.exec("ROLLBACK"); sourceGuard.close(); sourceGuard = undefined; }
    if (existsSync(main)) {
      const old = new (native().DatabaseSync)(main);
      try {
        const checkpoint = old.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
        if (checkpoint.busy) throw new Error("Authoritative database is still in use");
      } finally { old.close(); }
      if (existsSync(main + "-wal") || existsSync(main + "-shm")) throw new Error("Old database sidecars remain in use; cutover refused");
    }
    renameSync(stage, main); syncDirectory(root); syncDirectory(join(root, "upgrades"));
    options.checkpoint?.("activated");
    db = openDatabase(main);
    await retireSources(root, db, warnings, report);
    await options.activate?.(db);
    report({ phase: "ready" });
    const result = db; db = undefined;
    return { db: result, migrated: true, backupDirectory, warnings };
  } finally {
    try { db?.close(); }
    finally {
      try {
        if (sourceGuard) {
          try { if (sourceGuard.isTransaction) sourceGuard.exec("ROLLBACK"); }
          finally { sourceGuard.close(); }
        }
      } finally { release(); }
    }
  }
}
