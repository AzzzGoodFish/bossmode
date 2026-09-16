import { parseDocument, parse } from "yaml";
import { type MemberRecord } from "../../data/types.js";
import { readFileSync, lstatSync } from "node:fs";
import { MembersRepository } from "../../data/repositories/members.js";
import { ConversationsRepository } from "../../data/repositories/conversations.js";
import { managedPath, requireRegularFile } from "../../files/io.js";
import { assertLegacyMemberDirectories, type LegacySourceEntry, type UpgradeImportContext, readLegacyJson } from "./inventory.js";
import { type TemplateMetadata, templateMetadataKeys, validateTemplateSlug, validateTemplatePath, TemplateRepository } from "../../data/repositories/templates.js";
import { asString, asStringArray } from "../../kernel/markdown.js";
import { isAbsolute, join } from "node:path";
import { type Database } from "../../data/database.js";
import { createHash } from "node:crypto";
import { requireObject } from "../../kernel/json.js";
import { getDefaultConfig } from "../../config/config.js";
import { type BossmodeConfig } from "../../kernel/types.js";
import { normalizeLegacyCredentialImport } from "../../config/model-credentials.js";
import { McpOauthRepository, decodeLegacyMcpOauthEntry } from "../../data/repositories/mcp-oauth.js";
import { SettingsRepository } from "../../data/repositories/settings.js";
import { ModelCredentialsRepository } from "../../data/repositories/model-settings.js";
import { CatalogRepository } from "../../config/pi-adapt/models-store.js";
import { McpSettingsRepository } from "../../data/repositories/mcp-settings.js";
import { WorkspacesRepository, SshCredentialsRepository } from "../../data/repositories/workspace-settings.js";
import { isDeepStrictEqual } from "node:util";
import { RuntimeRepository } from "../../data/repositories/runtime-repository.js";
import { executionScopeId, importExecutionAmbiguity } from "../../data/repositories/execution-identity.js";
import { ensureImportedScope, retiredTopicScope } from "./conversations.js";

function text(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder("utf-8", {fatal:true}).decode(bytes); }
  catch { throw new Error(`Invalid UTF-8 in legacy member source: ${path}`); }
}

/** Same byte boundary as the accepted member-storage-v1 conversion; never trims body. */
export function parseLegacyMemberPersona(bytes: Uint8Array, path: string): {body: Uint8Array; title?: string; profileName?: string} {
  const decoded=text(bytes,path);
  const prefix=decoded.match(/^(?:\uFEFF)?---\r?\n/);
  if (!prefix) return {body:bytes};
  const remaining=decoded.slice(prefix[0].length);
  const close=/^(?:---|\.\.\.)\r?(?:\n|$)/m.exec(remaining);
  if (!close) throw new Error(`Unterminated legacy member frontmatter: ${path}`);
  let meta: any;
  try {
    const document=parseDocument(remaining.slice(0,close.index),{uniqueKeys:true});
    if (document.errors.length) throw new Error("invalid YAML");
    meta=document.contents===null?{}:document.toJS({maxAliasCount:100});
  } catch { throw new Error(`Invalid legacy member frontmatter: ${path}`); }
  if (!meta || typeof meta!=="object" || Array.isArray(meta) || (meta.title!==undefined && typeof meta.title!=="string") || (meta.name!==undefined && typeof meta.name!=="string")) throw new Error(`Invalid legacy member profile metadata: ${path}`);
  const consumed=prefix[0]+remaining.slice(0,close.index+close[0].length);
  const bom=bytes[0]===0xef && bytes[1]===0xbb && bytes[2]===0xbf && !decoded.startsWith("\uFEFF") ? 3 : 0;
  return {body:bytes.subarray(Buffer.byteLength(consumed,"utf8")+bom),...(meta.title?.trim()?{title:meta.title.trim()}:{}),...(meta.name!==undefined?{profileName:meta.name}:{})};
}

/** Legacy member.json owns identity; a differing profile header never renames it. */
export function parseLegacyMemberRecord(bytes: Uint8Array, memberId: string, path: string): MemberRecord {
  let value: any;
  try { value=JSON.parse(text(bytes,path)); }
  catch { throw new Error(`Invalid legacy member record: ${path}`); }
  if (!value || value.id!==memberId || !/^mem_[a-zA-Z0-9_-]+$/.test(memberId) ||
    typeof value.name!=="string" || !value.name.trim() || value.name.trim().length>64 || /[/\0]/.test(value.name) ||
    typeof value.agentTemplate!=="string" || !value.agentTemplate || !value.global || typeof value.global!=="object" || Array.isArray(value.global) ||
    !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)) throw new Error(`Invalid legacy member record: ${path}`);
  const {extensions:_retired,...global}=value.global;
  return {id:memberId,name:value.name.trim(),agentTemplate:value.agentTemplate,global,createdAt:value.createdAt,updatedAt:value.updatedAt,
    unifiedModel:true,unifiedExtensions:true,scopeOverrides:{}};
}

export interface MemberSourceImport {
 consumed:Set<string>;
 /** Converted bodies for the document-metadata importer; current rc.1 bodies remain snapshot inputs. */
 personas:Array<{memberId:string;path:string;body:Uint8Array;updatedAt:number}>;
 /** Retired-looking files in DB-authoritative input must remain inert, not be re-imported. */
 ignoredLegacyPaths:string[];
}

/** Startup chooses source generation from the previous database, not row count or file presence.
 * In particular an empty converted registry does not authorize importing old member.json files. */
export function importLegacyMembers(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],authority:"files"|"database"):MemberSourceImport{
 ctx.db.assertOutsideTransaction();
 const consumed=new Set<string>();const personas:MemberSourceImport["personas"]=[];
 const legacyEntries=entries.filter(e=>e.kind==="member-metadata"||e.kind==="member-profile-mixed");
 const read=(path:string)=>{
  if(!ctx.sourceFiles.includes(path))throw new Error(`Missing snapshotted member source: ${path}`);
  const file=managedPath(ctx.sourceRoot,path);requireRegularFile(file);return readFileSync(file);
 };
 const members=new MembersRepository(ctx.db);const conversations=new ConversationsRepository(ctx.db);
 if(authority==="database"){
  for(const record of members.list()){
   const path=`members/${record.id}/persona.md`;
   const bytes=read(path);
   try{new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{throw new Error(`Invalid current persona UTF-8: ${record.id}`);}
   conversations.ensureDmScope(record.id);
  }
  for(const e of legacyEntries)consumed.add(e.path);
  return {consumed,personas,ignoredLegacyPaths:legacyEntries.map(e=>e.path)};
 }
 const prepared:Array<{record:MemberRecord;path:string;body:Uint8Array}>=[];
 for(const entry of legacyEntries.filter(e=>e.kind==="member-metadata")){
  if(!entry.memberId)throw new Error("Legacy member metadata has no ID");
  const record=parseLegacyMemberRecord(read(entry.path),entry.memberId,entry.path);
  const profilePath=`members/${record.id}/member.md`;
  const profile=entries.find(e=>e.path===profilePath&&e.kind==="member-profile-mixed");
  const converted:ReturnType<typeof parseLegacyMemberPersona>=profile?parseLegacyMemberPersona(read(profilePath),profilePath):{body:Buffer.alloc(0)};
  if(converted.title!==undefined)record.title=converted.title;
  const unmigrated=`members/${record.id}/memory/persona.md`;
  if(ctx.sourceFiles.includes(unmigrated)){
   const legacyBody=read(unmigrated);
   try{new TextDecoder("utf-8",{fatal:true}).decode(legacyBody);}catch{throw new Error(`Invalid legacy persona UTF-8: ${record.id}`);}
   // Before member.md existed, memory/persona.md was the current persona, not
   // an unresolved merge. Copy its exact bytes only when that newer profile is
   // absent. An existing profile, including an explicitly empty one, must not
   // silently resurrect an older body. The document importer retains history.
   if(!profile)converted.body=legacyBody;
   else if(legacyBody.toString("utf8").trim())throw new Error(`Unmerged legacy persona: ${record.id}`);
  }
  prepared.push({record,path:`members/${record.id}/persona.md`,body:converted.body});
  consumed.add(entry.path);if(profile)consumed.add(profilePath);
 }
 for(const entry of legacyEntries)if(!consumed.has(entry.path))throw new Error(`Legacy profile has no identity metadata: ${entry.path}`);
 assertLegacyMemberDirectories(ctx.root,new Set(prepared.map(item=>item.record.id)));
 for(const item of prepared){
  if(ctx.sourceFiles.includes(item.path)){
   // An earlier attempt may have published this generated persona before DB cutover.
   // Reuse only this importer's ID-owned retained body, byte-identical to conversion
   // of the verified snapshot's selected persona source. Never relax stageAsset's
   // application-storage/source protection. The runner rechecks all live source
   // hashes before cutover; the document importer still verifies body ownership.
   const source=entries.find(e=>e.path===item.path);
   if(!source||source.kind!=="document-body"||source.format!=="text"||source.retire||source.scopeId!==undefined
    ||source.memberId!==item.record.id||source.layer!=="persona"||source.layout!=="member"||source.documentPath!==item.path
    ||!read(item.path).equals(Buffer.from(item.body))){
    throw new Error(`Existing asset differs or has unverified member ownership: ${item.path}`);
   }
  }else ctx.stageAsset(item.path,item.body);
 }
 ctx.db.transaction(tx=>{
  const registry=new MembersRepository(tx);const scopes=new ConversationsRepository(tx);
  for(const {record}of prepared){registry.insert(record);scopes.ensureDmScope(record.id);}
 });
 for(const {record,path,body}of prepared)personas.push({memberId:record.id,path,body,updatedAt:record.updatedAt});
 return {consumed,personas,ignoredLegacyPaths:[]};
}

export interface ParsedTemplate {
  metadata: Omit<TemplateMetadata, "personaPath">;
  body: string;
}

/** Split only the YAML envelope; retain every persona byte after the closing delimiter. */
export function parseAgentDefinitionMarkdown(slug: string, markdown: string): ParsedTemplate {
  validateTemplateSlug(slug);
  // Zero YAML lines is a valid empty envelope; the closing delimiter owns its newline.
  const match = markdown.match(/^---\r?\n((?:[^\n]*\n)*?)---(?:\r?\n|$)([\s\S]*)$/);
  if (/^---\r?\n/.test(markdown) && !match) throw new Error("Unterminated agent frontmatter");
  const meta = match ? (parse(match[1]) ?? {}) : {};
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("Agent frontmatter must be a mapping");
  const extensions = Object.fromEntries(Object.entries(meta).filter(([key]) => !templateMetadataKeys.includes(key as typeof templateMetadataKeys[number])));
  return {
    metadata: {
      slug, name: asString(meta.name, slug), description: asString(meta.description),
      avatar: meta.avatar == null ? undefined : asString(meta.avatar),
      model: meta.model == null ? undefined : asString(meta.model),
      tags: meta.tags === undefined ? undefined : asStringArray(meta.tags),
      skills: meta.skills === undefined ? undefined : asStringArray(meta.skills),
      extensions,
    },
    body: match ? match[2] : markdown,
  };
}

function assetPath(root: string, slug: string, relativePath: string): string {
  if (!isAbsolute(root)) throw new Error("Agent asset root must be absolute");
  validateTemplatePath(slug, relativePath);
  let path = root;
  // Managed data root is supplied by bootstrap. Reject symlinks within it, including root itself.
  for (const part of ["", ...relativePath.split("/")]) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Agent asset path contains a symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path;
}

export function readTemplateBody(root: string, metadata: TemplateMetadata): string {
  const path = assetPath(root, metadata.slug, metadata.personaPath);
  if (!lstatSync(path).isFile()) throw new Error("Agent persona must be a regular file");
  return readFileSync(path, "utf8");
}

export interface TemplateSource {
  /** Historical inventory path; never opened here. */
  path: string;
  slug: string;
  markdown: string;
}

export interface TemplateImportContext {
  db: Database;
  stageAsset(relativePath: string, bytes: Uint8Array): void;
}

/** Pure source-inventory filter for parent's backup/retirement coordinator. */
export function legacyAgentTemplateSources(sourceFiles: readonly string[]): {path: string; retire: true}[] {
  return sourceFiles.filter(path => /^agents\/[^/\\]+\.md$/.test(path)).map(path => ({ path, retire: true }));
}

/** Parent reads its explicit backup inventory and supplies bytes. No filesystem discovery or lifecycle. */
export function importAgentTemplates(ctx: TemplateImportContext, sources: readonly TemplateSource[]): void {
  const seen = new Set<string>();
  const prepared = sources.map(source => {
    if (seen.has(source.slug)) throw new Error(`Duplicate agent template slug: ${source.slug}`);
    seen.add(source.slug);
    const parsed = parseAgentDefinitionMarkdown(source.slug, source.markdown);
    const hash = createHash("sha256").update(parsed.body).digest("hex");
    return { ...parsed, personaPath: `agents/${source.slug}/import-${hash}/persona.md` };
  });
  // No SQL transaction spans staging file IO. A staging failure publishes no metadata.
  for (const item of prepared) ctx.stageAsset(item.personaPath, Buffer.from(item.body, "utf8"));
  ctx.db.transaction(tx => {
    const repository = new TemplateRepository(tx);
    for (const item of prepared) repository.upsert({ ...item.metadata, personaPath: item.personaPath });
  });
}

export function decodeLegacyConfig(value:unknown):BossmodeConfig{
 const row=requireObject(value, `Invalid legacy settings object: ${"config.json"}`);const auth=requireObject(row.auth, `Invalid legacy settings object: ${"config.json"}`);const defaults=requireObject(row.defaults, `Invalid legacy settings object: ${"config.json"}`);
 if(typeof auth.username!=="string"||typeof auth.passwordHash!=="string"||typeof defaults.host!=="string"||!defaults.host||!Number.isInteger(defaults.port)||defaults.port<1||defaults.port>65535)throw new Error("Invalid legacy application configuration");
 const apiKeys=requireObject(row.apiKeys??{}, `Invalid legacy settings object: ${"config.json"}`);if(Object.values(apiKeys).some(v=>typeof v!=="string"))throw new Error("Invalid legacy provider keys");
 const base=getDefaultConfig();
 return {...base,...row,auth:{username:auth.username,passwordHash:auth.passwordHash},apiKeys,defaults:{host:defaults.host,port:defaults.port}};
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
  const value=requireObject(read(entry), `Invalid legacy settings object: ${entry.path}`);
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
    const value=requireObject(read(entry), `Invalid legacy settings object: ${entry.path}`);
    if(!Array.isArray(value.profiles)||value.migrations!==undefined&&!Array.isArray(value.migrations))throw new Error("Invalid legacy credential store");
    const normalized=normalizeLegacyCredentialImport({...value,profiles:value.profiles,migrations:value.migrations??[]} as any,catalog.remote()?.models??[...bundledCatalog]);
    new ModelCredentialsRepository(ctx.db).replace({profiles:normalized.profiles,migrations:normalized.migrations??[]});break;
   }
   case "mcp-oauth":{
    if(!entry.serverKey)throw new Error("Missing MCP OAuth source key");
    new McpOauthRepository(ctx.db).importHashedAuthEntry(entry.serverKey,decodeLegacyMcpOauthEntry(read(entry)));break;
   }
   case "mcp-config":new McpSettingsRepository(ctx.db).importConfig(requireObject(read(entry), `Invalid legacy settings object: ${entry.path}`));break;
   case "member-mcp":{
    new McpSettingsRepository(ctx.db).importMemberConfig(owner(entry.memberId),requireObject(read(entry), `Invalid legacy settings object: ${entry.path}`));break;
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

/** rc.28/current-member generation. Member-centric sessions (① A1/A3): legacy
 * per-scope associations are a retired generation, quarantined as historical
 * records and never resumed. No SDK history is opened, copied, rewritten or
 * replayed by this adapter. */
export function importLegacyExecution(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[]):Set<string>{
 ctx.db.assertOutsideTransaction();const consumed=new Set<string>();
 const runtime=new RuntimeRepository(ctx.db);
 const seen=new Map<string,unknown>();
 const unique=(key:string,value:unknown)=>{
  if(!seen.has(key)){seen.set(key,value);return true;}
  if(!isDeepStrictEqual(seen.get(key),value))throw new Error(`Conflicting execution source: ${key}`);
  return false;
 };
 const known=(id:string|undefined):id is string=>!!id&&!!ctx.db.get("SELECT id FROM members WHERE id=?",id);
 const quarantine=(e:LegacySourceEntry,key:string,domain:"session"|"runtime",value:unknown,reason:string)=>{
  importExecutionAmbiguity(ctx.db,{sourcePath:e.path,sourceKey:key,domain,recordJson:JSON.stringify(value),reason,importedAt:Math.trunc(e.mtimeMs)});
 };
 for(const e of entries){
  if(e.kind==="background-task"){consumed.add(e.path);continue;} // background tasks retired (fish #19454); files dropped with the feature
  if(!["current-sessions","old-sessions","runtime-state"].includes(e.kind))continue;
  if(!ctx.sourceFiles.includes(e.path))throw new Error(`Unsnapshotted execution source: ${e.path}`);
  const data=requireObject(readLegacyJson(ctx.sourceRoot,e), `Invalid legacy execution object: ${e.path}`);const at=Math.trunc(e.mtimeMs);
  if(e.kind==="current-sessions"){
   // Member-centric sessions (① A1/A3): one session per member across all chats.
   // Legacy per-scope associations are a retired generation — preserved here as
   // historical records, never resumed; the startup upgrade archives their files.
   for(const [key,value]of Object.entries(data)){
    if(retiredTopicScope(key))continue; // topic scope retired (fish #19358)
    quarantine(e,key,"session",value,"retired-scope-session-generation");
   }
  }else if(e.kind==="old-sessions"){
   for(const [key,value]of Object.entries(data))quarantine(e,key,"session",value,"retired-room-session-generation");
  }else{
   for(const [key,value]of Object.entries(data)){
    const split=key.lastIndexOf(":");const member=key.slice(split+1);const rawScope=key.slice(0,split);
    if(retiredTopicScope(rawScope))continue; // topic scope retired (fish #19358)
    if(split<1||!known(member)||e.memberId!==undefined&&e.memberId!==member){quarantine(e,key,"runtime",value,"unresolved-runtime-owner");continue;}
    let scope:string;try{scope=executionScopeId(rawScope);}catch{quarantine(e,key,"runtime",value,"invalid-runtime-scope");continue;}
    ensureImportedScope(ctx.db,scope);
    const entry=requireObject(value, `Invalid legacy execution object: ${e.path}`);
    if(unique(`runtime:${scope}:${member}`,entry))runtime.importEntry(member,entry,at);
   }
  }
  consumed.add(e.path);
 }
 return consumed;
}
