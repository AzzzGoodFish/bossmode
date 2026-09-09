import {readFileSync} from "node:fs";
import {getDefaultConfig} from "../shared/config.js";
import type {BossmodeConfig} from "../shared/types.js";
import {normalizeLegacyCredentialImport} from "../engine/model-credentials.js";
import {SettingsRepository} from "./repositories/settings.js";
import {ModelCredentialsRepository} from "./repositories/model-settings.js";
import {CatalogRepository} from "./repositories/catalog-settings.js";
import {McpSettingsRepository} from "./repositories/mcp-settings.js";
import {WorkspacesRepository,SshCredentialsRepository} from "./repositories/workspace-settings.js";
import {readLegacyJson,type LegacySourceEntry} from "./legacy-inventory.js";
import {managedPath,requireRegularFile} from "./upgrade-files.js";
import type {UpgradeImportContext} from "./upgrade-runner.js";

function object(value:unknown,path:string):Record<string,any>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid legacy settings object: ${path}`);
 return value as Record<string,any>;
}
export function decodeLegacyConfig(value:unknown):BossmodeConfig{
 const row=object(value,"config.json");const auth=object(row.auth,"config.json");const defaults=object(row.defaults,"config.json");
 if(typeof auth.username!=="string"||typeof auth.passwordHash!=="string"||typeof defaults.host!=="string"||!defaults.host||!Number.isInteger(defaults.port)||defaults.port<1||defaults.port>65535)throw new Error("Invalid legacy application configuration");
 const apiKeys=object(row.apiKeys??{},"config.json");if(Object.values(apiKeys).some(v=>typeof v!=="string"))throw new Error("Invalid legacy provider keys");
 const base=getDefaultConfig();
 const runtime=row.runtime===undefined?{}:object(row.runtime,"config.json");
 const sessionResume=runtime.sessionResume??row.sessionResume??base.runtime!.sessionResume;
 if(typeof sessionResume!=="boolean")throw new Error("Invalid legacy session resume setting");
 return {...base,...row,auth:{username:auth.username,passwordHash:auth.passwordHash},apiKeys,defaults:{host:defaults.host,port:defaults.port},
  runtime:{...base.runtime,...runtime,sessionResume}};
}
/** Snapshot-only reads. Caller supplies packaged catalog rows without starting a runtime.
 * Returned keys identify sources this adapter consumed; other domains must account for the rest. */
export function importLegacySettings(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],bundledCatalog:readonly any[]):Set<string>{
 ctx.db.assertOutsideTransaction();
 const consumed=new Set<string>();
 const owner=(id:string|undefined):string=>{
  if(!id||!ctx.db.get("SELECT id FROM members WHERE id=?",id))throw new Error("Unproven member settings owner");
  return id;
 };
 const read=(entry:LegacySourceEntry)=>{
  if(!ctx.sourceFiles.includes(entry.path))throw new Error(`Unsnapshotted legacy source: ${entry.path}`);
  return readLegacyJson(ctx.sourceRoot,entry);
 };
 const text=(entry:LegacySourceEntry)=>{
  if(!ctx.sourceFiles.includes(entry.path))throw new Error(`Unsnapshotted legacy source: ${entry.path}`);
  const path=managedPath(ctx.sourceRoot,entry.path);requireRegularFile(path);
  try{return new TextDecoder("utf-8",{fatal:true}).decode(readFileSync(path));}
  catch{throw new Error(`Invalid legacy text source: ${entry.path}`);}
 };
 const catalog=new CatalogRepository(ctx.db);
 for(const entry of entries.filter(e=>e.kind==="catalog-remote"||e.kind==="catalog-overlays")){
  const value=object(read(entry),entry.path);
  if(entry.kind==="catalog-remote"){
   const fetchedAt=value.fetchedAt??Date.parse(value.updatedAt);
   if(!Array.isArray(value.models)||!Number.isFinite(fetchedAt))throw new Error(`Invalid legacy catalog: ${entry.path}`);
   catalog.importRemote({models:value.models,fetchedAt,updatedAt:typeof value.updatedAt==="string"?value.updatedAt:new Date(fetchedAt).toISOString()});
  }else catalog.importOverlays(value);
  consumed.add(entry.path);
 }
 const config=entries.find(e=>e.kind==="config");
 new SettingsRepository(ctx.db).importConfig(config?decodeLegacyConfig(read(config)):getDefaultConfig());
 if(config)consumed.add(config.path);
 for(const entry of entries){
  switch(entry.kind){
   case "model-credentials":{
    const value=object(read(entry),entry.path);
    if(!Array.isArray(value.profiles)||value.migrations!==undefined&&!Array.isArray(value.migrations))throw new Error("Invalid legacy credential store");
    const normalized=normalizeLegacyCredentialImport({...value,profiles:value.profiles,migrations:value.migrations??[]} as any,catalog.remote()?.models??[...bundledCatalog]);
    new ModelCredentialsRepository(ctx.db).replace({profiles:normalized.profiles,migrations:normalized.migrations??[]});break;
   }
   case "mcp-config":new McpSettingsRepository(ctx.db).importConfig(object(read(entry),entry.path));break;
   case "member-mcp":{
    new McpSettingsRepository(ctx.db).importMemberConfig(owner(entry.memberId),object(read(entry),entry.path));break;
   }
   case "mcp-status":new McpSettingsRepository(ctx.db).importStatus(read(entry) as any);break;
   case "workspaces":{
    new WorkspacesRepository(ctx.db).importRegistry(owner(entry.memberId),read(entry) as any);break;
   }
   default:continue;
  }
  consumed.add(entry.path);
 }
 const ssh=entries.filter(e=>["ssh-private-key","ssh-public-key","ssh-config"].includes(e.kind));
 for(const id of new Set(ssh.map(e=>e.memberId))){
  const memberId=owner(id);
  const owned=ssh.filter(e=>e.memberId===id);const privateKey=owned.find(e=>e.kind==="ssh-private-key");const publicKey=owned.find(e=>e.kind==="ssh-public-key");const config=owned.find(e=>e.kind==="ssh-config");
  if(!privateKey||!publicKey)throw new Error(`Incomplete owned SSH credential: ${id}`);
  new SshCredentialsRepository(ctx.db).importKey(memberId,{privateKey:text(privateKey),publicKey:text(publicKey),...(config?{config:text(config)}:{})});
  for(const entry of owned)consumed.add(entry.path);
 }
 return consumed;
}
