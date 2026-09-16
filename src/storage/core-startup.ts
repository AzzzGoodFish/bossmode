import {createRequire} from "node:module";
import {logger} from "../kernel/logger.js";
import {readFileSync} from "node:fs";
import {assertServiceStopped,prepareStorageUpgrade,type UpgradeOptions,type UpgradeImportContext} from "./upgrade-runner.js";
import {coreStorageMigrations,CORE_STORAGE_FORMAT} from "./migrations.js";
import {discoverLegacyInventory,type LegacySourceEntry} from "./legacy-inventory.js";
import {importLegacyArchives} from "./upgrade-archives.js";
import {importLegacyMembers} from "./upgrade-members.js";
import {importLegacySettings} from "./upgrade-settings.js";
import {importLegacyConversations} from "./upgrade-conversations.js";
import {importLegacyExecution} from "./upgrade-execution.js";
import {importLegacyDocuments} from "./upgrade-documents.js";
import {importAgentTemplates} from "../workforce/template-files.js";
import {archiveRetiredTasks} from "./task-retirement.js";
import {cleanupRetiredTopicSessionFiles} from "./topic-session-cleanup.js";
import {cleanupRetiredBackgroundSessionFiles} from "./background-session-cleanup.js";
import {archiveRetiredScopeSessions} from "./member-session-archive.js";
import {archiveLegacySharedMemory,cleanupMemberMemoryScopes} from "./memory-retirement-migration.js";
import {copyRoomPrinciplesToDescriptions} from "./room-description-migration.js";
import {migrateShortIds,replayShortIdJournalFromDisk} from "./short-id-migration.js";
import {managedPath,requireRegularFile} from "./upgrade-files.js";
import {bindDatabase} from "./database.js";
import {SettingsRepository} from "./repositories/settings.js";
import {assertNoMissingMemberDatabase,verifyActiveMemberAssets} from "./startup-member-verification.js";
import type {BossmodeConfig} from "../kernel/types.js";

function memberAuthority(ctx:UpgradeImportContext):"files"|"database"{
 if(!ctx.previousDatabase)return "files";
 const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
 const previous=new DatabaseSync(ctx.previousDatabase,{readOnly:true});
 try{
  const members=!!previous.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='members'").get();
  const history=previous.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const marked=!!history&&!!previous.prepare("SELECT 1 FROM schema_migrations WHERE id='member-storage-v1'").get();
  if(members!==marked)throw new Error("Unrecognized previous member authority; no source was replaced");
  return marked?"database":"files";
 }finally{previous.close();}
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
 // Batch 5 (short ids): finish any interrupted renames before ANY verifier inspects
 // the filesystem — the DB rewrite commits before the filesystem renames, so a crash
 // window leaves new ids in SQL against old names on disk. Guarded by the same
 // no-live-service check as the upgrade runner (never rename under a running daemon).
 assertServiceStopped(options.root);
 const shortIdReplay=replayShortIdJournalFromDisk(options.root);
 if(shortIdReplay.status==="failed")throw new Error(`Short-id rename journal replay failed: ${shortIdReplay.failures.join("; ")}`);
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
  activate:options.activate?async db=>{bindDatabase(db);await options.activate!(db);}:undefined,
 });
 if(quarantinedEvents){
  const warning=`Preserved ${quarantinedEvents} unreadable legacy runtime-event lines in SQL quarantine; original files remain in the upgrade backup.`;
  result.warnings.push(warning);logger.warn("storage-upgrade",warning);
 }
 // Batch 5 (short ids): the one-shot rewrite (blocking — a partial migration fails
 // startup instead of running half-old/half-new). An interrupted rename journal was
 // already replayed at the top of prepareCoreStorage, before filesystem verifiers.
 migrateShortIds(options.root,result.db);
 // Topic retirement §3.4 (fish #19358): retire topic session files once the DB settles.
 cleanupRetiredTopicSessionFiles(options.root,result.db);
 // Background retirement (fish #19454): retire background task directories once the DB settles.
 cleanupRetiredBackgroundSessionFiles(options.root,result.db);
 // Member-centric sessions (① A3): park retired per-scope session files in the member archive.
 archiveRetiredScopeSessions(options.root,result.db);
 // Assets batch ④ (fish #20035): legacy shared memory → global archive; member memory/scopes folded.
 archiveLegacySharedMemory(options.root,result.db);
 cleanupMemberMemoryScopes(options.root,result.db);
 // ⑤ A (fish #20135): legacy room principles content → rooms.description.
 copyRoomPrinciplesToDescriptions(options.root,result.db);
 return result;
}
