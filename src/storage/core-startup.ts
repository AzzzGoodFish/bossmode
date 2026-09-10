import {createRequire} from "node:module";
import {readFileSync} from "node:fs";
import {prepareStorageUpgrade,type UpgradeOptions,type UpgradeImportContext} from "./upgrade-runner.js";
import {coreStorageMigrations,CORE_STORAGE_FORMAT} from "./migrations.js";
import {discoverLegacyInventory,type LegacySourceEntry} from "./legacy-inventory.js";
import {importLegacyArchives} from "./upgrade-archives.js";
import {importLegacyMembers} from "./upgrade-members.js";
import {importLegacySettings} from "./upgrade-settings.js";
import {importLegacyConversations} from "./upgrade-conversations.js";
import {importLegacyExecution} from "./upgrade-execution.js";
import {importLegacyDocuments} from "./upgrade-documents.js";
import {importAgentTemplates} from "../workforce/template-files.js";
import {managedPath,requireRegularFile} from "./upgrade-files.js";
import {bindDatabase} from "./database.js";
import {SettingsRepository} from "./repositories/settings.js";
import {assertNoMissingMemberDatabase,verifyActiveMemberAssets} from "./startup-member-verification.js";
import type {BossmodeConfig} from "../shared/types.js";

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
 let entries:LegacySourceEntry[]=[];
 return prepareStorageUpgrade({root:options.root,formatVersion:CORE_STORAGE_FORMAT,migrations:coreStorageMigrations,
  onProgress:options.onProgress,
  collectLegacySources:async root=>{assertNoMissingMemberDatabase(root);entries=discoverLegacyInventory(root).entries;return entries;},
  verifyReady:db=>verifyActiveMemberAssets(options.root,db),
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
}
