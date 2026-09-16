import { type Database, type StorageMigration, inspectDatabase, lockDatabase, backupDatabase, applyStorageMigrations, validateStorageMigrationHistory, openDatabase, checkpointDatabase, bindDatabase } from "../../data/database.js";
import { type UpgradeProgress, type UpgradeImportContext, type UpgradeSource, discoverLegacyInventory, type LegacySourceEntry, assertNoMissingMemberDatabase } from "./inventory.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, chmodSync, realpathSync, renameSync } from "node:fs";
import { requireRegularFile, ensurePrivateDirectory, managedPath, syncPath, moveDurably, hashFile, copyDurably, publishAssetDurably, syncDirectoryChain, writeDurably } from "../../files/io.js";
import { join, isAbsolute, relative } from "node:path";
import { replayShortIdJournalFromDisk, migrateShortIds } from "./ids.js";
import { type BossmodeConfig } from "../../kernel/types.js";
import { logger } from "../../kernel/logger.js";
import { coreStorageMigrations, CORE_STORAGE_FORMAT } from "../../data/schema.js";
import { importLegacyArchives, importLegacyDocuments, verifyActiveMemberAssets } from "./assets.js";
import { importLegacyMembers, importLegacySettings, importLegacyExecution, importAgentTemplates } from "./records.js";
import { importLegacyConversations } from "./conversations.js";
import { archiveRetiredTasks, cleanupRetiredTopicSessionFiles, cleanupRetiredBackgroundSessionFiles, archiveRetiredScopeSessions, archiveLegacySharedMemory, cleanupMemberMemoryScopes, copyRoomPrinciplesToDescriptions } from "./retirements.js";
import { SettingsRepository } from "../../data/repositories/settings.js";

export interface UpgradeOptions {
  root: string;
  formatVersion: number;
  migrations: readonly StorageMigration[];
  collectLegacySources(root: string): Promise<readonly UpgradeSource[]>;
  importData(context: UpgradeImportContext): Promise<void>;
  validate(context: UpgradeImportContext): Promise<void>;
  onProgress?(progress: UpgradeProgress): void;
  /** Read-only live-asset checks before retirement/activation, including current-generation reopen. */
  verifyReady?(db: Database): void;
  /** Production binds/starts consumers and publishes PID ownership before the lease is released. */
  activate?(db: Database): Promise<void>;
  /** Dependency-injected failure hook for isolated tests, never read from environment. */
  checkpoint?(phase: "backup" | "import" | "validated" | "activated"): void;
  /** Archive data that a later migration is about to drop, from the staging database,
   *  before migrations apply. Receives the staging DB (still at the pre-migration
   *  schema) and the archive root. Throws to abort the upgrade if archiving fails. */
  archiveRetiredData?(stagingDb: Database, root: string): void | Promise<void>;
}

export interface UpgradeResult { db: Database; migrated: boolean; backupDirectory?: string; warnings: string[]; }

interface Authority { format: number; schema: string; }

interface SourceRecord { path: string; backup_path: string; hash: string; retire: number; }

interface PreparedAsset { path: string; staged: string; hash: string; }

const authorityKey = "core-authority";

function schemaDigest(migrations: readonly StorageMigration[]): string {
  return createHash("sha256").update(JSON.stringify(migrations.map(m => [m.id, m.sql]))).digest("hex");
}

function inspectAuthority(path: string): Authority | undefined {
  if (!existsSync(path)) return undefined;
  requireRegularFile(path);
  return inspectDatabase(path,db=>{
    if(!db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_meta'"))return undefined;
    const row=db.get<{value:string}>("SELECT value FROM storage_meta WHERE key=?",authorityKey);
    if(!row)return undefined;
    const marker=JSON.parse(row.value) as Authority;
    if(!Number.isSafeInteger(marker.format)||marker.format<1||typeof marker.schema!=="string")throw new Error("Invalid core storage authority marker");
    return marker;
  });
}

export function assertServiceStopped(root: string): void {
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
  ensurePrivateDirectory(directory); syncPath(root);
  const path = managedPath(root, "upgrades/lease.sqlite");
  if (existsSync(path)) requireRegularFile(path);
  let release:(()=>void)|undefined;
  try { release=lockDatabase(path,"exclusive");chmodSync(path,0o600);return release; }
  catch(error){release?.();throw new Error("Cannot acquire startup upgrade lease",{cause:error});}
}

async function snapshotDatabase(source: string, target: string): Promise<void> {
  requireRegularFile(source);
  await backupDatabase(source,target);
  chmodSync(target, 0o600); syncPath(target);
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
  const rows = db.all<SourceRecord>("SELECT path, backup_path, hash, retire FROM storage_upgrade_files WHERE retire=1 AND retired_at IS NULL ORDER BY path");
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
  let releaseSource: (()=>void) | undefined;
  // Both current-generation reopen and cutover complete under the same lease.
  const finish = async (main:string,migrated:boolean,backupDirectory?:string):Promise<UpgradeResult> => {
    db=openDatabase(main);
    validateStorageMigrationHistory(db,options.migrations);
    options.verifyReady?.(db);
    await retireSources(root,db,warnings,report);
    await options.activate?.(db);
    report({phase:"ready"});
    const result=db;db=undefined;
    return {db:result,migrated,...(backupDirectory?{backupDirectory}:{}),warnings};
  };
  try {
    report({ phase: "checking" });
    assertServiceStopped(root);
    const main = managedPath(root, "bossmode.db");
    const expected: Authority = { format: options.formatVersion, schema: schemaDigest(options.migrations) };
    const previous = inspectAuthority(main);
    if (previous && previous.format > expected.format) throw new Error("Database was written by a newer storage format; refusing a downgrade");
    // Hold the startup lease before replay, but reject newer formats before any source mutation.
    const replay = replayShortIdJournalFromDisk(root);
    if (replay.status === "failed") throw new Error(`Short-id rename journal replay failed: ${replay.failures.join("; ")}`);
    if (previous?.format === expected.format && previous.schema === expected.schema) {
      return await finish(main,false);
    }

    if (existsSync(main)) {
      releaseSource = lockDatabase(main,"immediate");
    }
    const stage = managedPath(root, "upgrades/staging.sqlite");
    quarantineStage(root, stage);
    const backupName = `backups/core-upgrade-${randomUUID()}`;
    const backupDirectory = managedPath(root, backupName);
    ensurePrivateDirectory(backupDirectory); syncPath(root);
    const sourceRoot = join(backupDirectory, "files");
    ensurePrivateDirectory(sourceRoot);
    const inventory = previous ? [] : [...await options.collectLegacySources(root)].sort((a,b) => a.path.localeCompare(b.path));
    if (new Set(inventory.map(source => source.path)).size !== inventory.length || inventory.some(source => typeof source.retire !== "boolean")) throw new Error("Invalid or duplicate legacy source inventory");
    const sourceFiles = inventory.map(source => source.path);
    const records: SourceRecord[] = [];
    report({ phase: "backing-up", completed: 0, total: sourceFiles.length });
    for (const entry of inventory) {
      const name = entry.path;
      const source = managedPath(root, name);
      // Coordinator artifacts/database are never ordinary legacy sources.
      if (/^(?:bossmode\.db(?:-|$)|bossmode\.pid$|upgrades\/)/.test(name) || (name.startsWith("backups/") && (entry.retire || !/^backups\/(?:fired-|legacy-)[^/]+\//.test(name)))) throw new Error("Invalid legacy source inventory");
      const destination = managedPath(sourceRoot, name);
      const hash = await hashFile(source);
      copyDurably(source, destination);
      if (await hashFile(destination) !== hash || await hashFile(source) !== hash) throw new Error(`Source changed during backup: ${name}`);
      records.push({ path: name, backup_path: relative(root, destination), hash, retire: Number(entry.retire) });
      report({ phase: "backing-up", completed: records.length, total: sourceFiles.length });
    }
    let previousDatabase: string | undefined;
    if (existsSync(main)) {
      previousDatabase = join(backupDirectory, "database-before.sqlite");
      await snapshotDatabase(main, previousDatabase);
      copyDurably(previousDatabase, stage);
    }
    syncPath(backupDirectory);
    options.checkpoint?.("backup");

    db = openDatabase(stage);
    if (options.archiveRetiredData) await options.archiveRetiredData(db, root);
    applyStorageMigrations(db, options.migrations);
    db.transaction(tx => {
      for (const row of records) tx.run("INSERT INTO storage_upgrade_files(path,backup_path,hash,retire) VALUES(?,?,?,?)", row.path, row.backup_path, row.hash, row.retire);
    });
    const prepared: PreparedAsset[] = [];
    const context: UpgradeImportContext = {
      db, root, sourceRoot, previousDatabase, sourceFiles, legacy: !previous,
      progress: (completed, total) => report({ phase: "importing", completed, total }),
      stageAsset: (name, bytes) => {
        const live = managedPath(root, name);
        if (!/^(?:members|rooms|memory|agents)\/.+\.md$/.test(name) || sourceFiles.includes(name)) throw new Error("Generated asset must be a retained Markdown body, not application storage");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const existing = prepared.find(asset => asset.path === name);
        if (existing) {
          if (existing.hash !== hash) throw new Error("Conflicting generated asset path");
          return;
        }
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
    for (const record of records) {
      const source = managedPath(root, record.path);
      if (await hashFile(source) !== record.hash) throw new Error(`Source changed before cutover: ${record.path}`);
      if (!record.retire) { syncPath(source); syncDirectoryChain(join(source, ".."), root); }
    }
    for (const asset of prepared) {
      const destination = managedPath(root, asset.path);
      if (existsSync(destination)) {
        if (await hashFile(destination) !== asset.hash) throw new Error(`Existing asset differs: ${asset.path}`);
        syncPath(destination); syncDirectoryChain(join(destination, ".."), root);
      } else publishAssetDurably(asset.staged, destination);
    }
    options.checkpoint?.("validated");
    db.transaction(tx => tx.run("INSERT INTO storage_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", authorityKey, JSON.stringify(expected)));
    const checkpoint = db.get<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
    if (!checkpoint || checkpoint.busy) throw new Error("Staging database is still in use; cutover refused");
    db.close(); db = undefined;
    if (existsSync(stage + "-wal") || existsSync(stage + "-shm")) throw new Error("Staging database sidecars remain in use; cutover refused");
    syncPath(stage);
    report({ phase: "cutover" });
    // The old file's WAL must not be replayed onto the replacement DB.
    releaseSource?.(); releaseSource=undefined;
    if (existsSync(main)) {
      if(checkpointDatabase(main)?.busy)throw new Error("Authoritative database is still in use");
      if (existsSync(main + "-wal") || existsSync(main + "-shm")) throw new Error("Old database sidecars remain in use; cutover refused");
    }
    renameSync(stage, main); syncPath(root); syncPath(join(root, "upgrades"));
    options.checkpoint?.("activated");
    return await finish(main,true,backupDirectory);
  } finally {
    try { db?.close(); }
    finally {
      try {
        releaseSource?.();
      } finally { release(); }
    }
  }
}

function memberAuthority(ctx:UpgradeImportContext):"files"|"database"{
 if(!ctx.previousDatabase)return "files";
 return inspectDatabase(ctx.previousDatabase,previous=>{
  const members=!!previous.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='members'");
  const history=previous.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
  const marked=!!history&&!!previous.get("SELECT 1 FROM schema_migrations WHERE id='member-storage-v1'");
  if(members!==marked)throw new Error("Unrecognized previous member authority; no source was replaced");
  return marked?"database":"files";
 });
}

export interface CoreStartupOptions{
 root:string;
 initialConfig?:BossmodeConfig;
 onProgress?:UpgradeOptions["onProgress"];
 /** Tests/host can supply a static SDK catalog without creating a model session. */
 bundledCatalog?:readonly any[];
 activate?:UpgradeOptions["activate"];
}

/** Ordinary startup owns this coordinator. There is no dry-run/apply/recover mode.
 * Unhandled source domains fail before cutover rather than silently disappearing. */
export async function prepareCoreStorage(options:CoreStartupOptions){
 let entries:LegacySourceEntry[]=[];let quarantinedEvents=0;
 const result=await prepareStorageUpgrade({root:options.root,formatVersion:CORE_STORAGE_FORMAT,migrations:coreStorageMigrations,
  onProgress:options.onProgress,
  collectLegacySources:async root=>{assertNoMissingMemberDatabase(root);entries=discoverLegacyInventory(root).entries;return entries;},
  verifyReady:db=>verifyActiveMemberAssets(options.root,db),
  // Task feature retirement (fish #19259): export the four task tables to a verified
  // archive before the core-task-retirement-v1 migration drops them.
  archiveRetiredData:(stagingDb,root)=>{archiveRetiredTasks(stagingDb,root);},
  importData:async ctx=>{
   if(!ctx.legacy)return;
   const consumed=new Set<string>();const add=(paths:Iterable<string>)=>{for(const path of paths)consumed.add(path);};
   const members=importLegacyMembers(ctx,entries,memberAuthority(ctx));add(members.consumed);
   add(importLegacyArchives(ctx,entries));
   add(importLegacySettings(ctx,entries,options.bundledCatalog??[]));
   if(options.initialConfig){
    if(entries.some(e=>e.kind==="config"))throw new Error("Initial account cannot replace existing configuration");
    new SettingsRepository(ctx.db).importConfig(options.initialConfig);
   }
   const templates=entries.filter(e=>e.kind==="agent-template-mixed");
   importAgentTemplates(ctx,templates.map(e=>{
    if(!ctx.sourceFiles.includes(e.path)||!e.slug)throw new Error("Unsnapshotted template source");
    const file=managedPath(ctx.sourceRoot,e.path);requireRegularFile(file);
    let markdown:string;try{markdown=new TextDecoder("utf-8",{fatal:true}).decode(readFileSync(file));}catch{throw new Error(`Invalid template UTF-8: ${e.path}`);}
    return {path:e.path,slug:e.slug,markdown};
   }));add(templates.map(e=>e.path));
   add(await importLegacyConversations(ctx,entries));
   quarantinedEvents=ctx.db.get<{count:number}>("SELECT COUNT(*) count FROM storage_meta WHERE key LIKE 'legacy-invalid-event-v1:%'")!.count;
   add(importLegacyExecution(ctx,entries));
   add(await importLegacyDocuments(ctx,entries,members.personas));
   const remaining=entries.filter(e=>!consumed.has(e.path));
   if(remaining.length)throw new Error(`Startup source adapter missing: ${remaining.map(e=>e.kind+":"+e.path).join(", ")}`);
   ctx.db.run("INSERT INTO storage_meta(key,value) VALUES('core-import-source-count',?)",String(consumed.size));
  },
  validate:async ctx=>{
   if(!ctx.db.get("SELECT 1 FROM app_settings WHERE id=1")||!ctx.db.get("SELECT 1 FROM login_credentials WHERE id=1"))throw new Error("Startup settings are incomplete");
   for(const row of ctx.db.all<{id:string}>("SELECT id FROM members WHERE archived_at IS NULL")){
    if(!ctx.db.get("SELECT 1 FROM memory_documents WHERE path=? AND member_id=?",`members/${row.id}/persona.md`,row.id))throw new Error(`Member persona metadata missing: ${row.id}`);
   }
  },
  activate:async db=>{
   // Journal replay already ran under this lease, before any filesystem verifier.
   // Required ID migration failures stop startup; optional cleanup failures retain
   // their existing warning/retry behavior. No consumers see an intermediate state.
   migrateShortIds(options.root,db);
   cleanupRetiredTopicSessionFiles(options.root,db);
   cleanupRetiredBackgroundSessionFiles(options.root,db);
   archiveRetiredScopeSessions(options.root,db);
   archiveLegacySharedMemory(options.root,db);
   cleanupMemberMemoryScopes(options.root,db);
   copyRoomPrinciplesToDescriptions(options.root,db);
   verifyActiveMemberAssets(options.root,db);
   if(options.activate){bindDatabase(db);await options.activate(db);}
  },
 });
 if(quarantinedEvents){
  const warning=`Preserved ${quarantinedEvents} unreadable legacy runtime-event lines in SQL quarantine; original files remain in the upgrade backup.`;
  result.warnings.push(warning);logger.warn("storage-upgrade",warning);
 }
 return result;
}
