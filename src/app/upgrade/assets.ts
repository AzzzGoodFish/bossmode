import { type MemberRecord } from "../../member/identity.js";
import { validateArchivePath } from "../../files/layout.js";
import { type ArchiveCatalogSource, importMemberArchiveCatalog, readMemberArchiveIntent } from "../../member/archive.js";
import { readFileSync, lstatSync } from "node:fs";
import { type UpgradeImportContext, type LegacySourceEntry, readLegacyJson, readLegacyJsonl } from "./inventory.js";
import { managedPath, requireRegularFile, syncPath, syncDirectoryChain } from "../../files/io.js";
import { parseLegacyMemberPersona, parseLegacyMemberRecord, type MemberSourceImport } from "./records.js";
import { getRetainedMember, importArchivedMember, getMember, memberArchivePath } from "../../member/identity.js";
import { requireObject } from "../../kernel/json.js";
import { isDeepStrictEqual } from "node:util";
import { dirname } from "node:path";
import { ensureImportedScope, retiredTopicScope } from "./conversations.js";
import { documentContentMeta, importDocument, type DocumentImport, type DocumentIdentity, type DocumentMeta, type ImportedDocumentHistory } from "../../member/assets.js";
import { type Database } from "../../data/database.js";
export interface FiredArchiveSource {
  archivePath: string;
  member: Pick<MemberRecord, "name" | "agentTemplate" | "global"> & Partial<Pick<MemberRecord, "id" | "title">>;
  persona?: {path:string; format:"plain" | "frontmatter"; hasContent:boolean};
}
export function catalogFromFiredExport(source: FiredArchiveSource): ArchiveCatalogSource {
  validateArchivePath(source.archivePath);
  return {archivePath:source.archivePath, name:source.member.name, template:source.member.agentTemplate || "general",
    title:source.member.title, global:source.member.global ?? {}, personaPath:source.persona?.path,
    personaFormat:source.persona?.format ?? "plain", hasPersona:source.persona?.hasContent ?? false, roomScopes:[], kind:"fired"};
}
export interface LegacyArchiveManifestSource {
  archivePath: string;
  members: Array<{
    name:string; sourceAgent?:string; credentialId?:string; conflicts?:string[];
    rooms?:Array<{room:string; hasPrinciples?:boolean; hasMainline?:boolean}>;
    personaPath?:string;
    hasPersona?:boolean;
  }>;
}
export function catalogFromLegacyManifest(source: LegacyArchiveManifestSource): ArchiveCatalogSource[] {
  validateArchivePath(source.archivePath);
  const byName = new Map<string, ArchiveCatalogSource>();
  for (const member of source.members) {
    const rooms = (member.rooms ?? []).map(r => ({room:r.room, hasPrinciples:!!r.hasPrinciples, hasMainline:!!r.hasMainline}));
    const previous = byName.get(member.name);
    if (previous) {
      if (previous.personaPath && member.personaPath && previous.personaPath !== member.personaPath) throw new Error("ambiguous_legacy_persona");
      previous.roomScopes.push(...rooms);
      previous.conflicts = [...(previous.conflicts ?? []), ...(member.conflicts ?? [])];
      previous.personaPath ??= member.personaPath;
      previous.hasPersona ||= member.hasPersona ?? !!member.personaPath;
    } else byName.set(member.name, {archivePath:source.archivePath, name:member.name, template:member.sourceAgent || "general",
      global:{credentialId:member.credentialId ?? null}, personaPath:member.personaPath, personaFormat:"plain",
      hasPersona:member.hasPersona ?? !!member.personaPath, roomScopes:rooms, conflicts:member.conflicts, kind:"legacy"});
  }
  return [...byName.values()];
}
function archiveTime(path:string):number|undefined{
 const match=path.match(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/);
 if(!match)return;
 const value=Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
 return Number.isFinite(value)?value:undefined;
}

/** Archive manifests are imported once. Immutable export contents remain backups,
 * not another live source consulted by archive listing/import or member lookup. */
export function importLegacyArchives(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[]):Set<string>{
 ctx.db.assertOutsideTransaction();const sources=entries.filter(e=>e.kind==="export-snapshot");const consumed=new Set<string>();
 const paths=new Set(sources.map(e=>e.path));
 const read=(path:string)=>{
  if(!paths.has(path)||!ctx.sourceFiles.includes(path))throw new Error(`Unsnapshotted archive source: ${path}`);
  const file=managedPath(ctx.sourceRoot,path);requireRegularFile(file);return readFileSync(file);
 };
 const text=(path:string)=>{try{return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(read(path));}catch{throw new Error(`Invalid archive text: ${path}`);}};
 const object=(path:string):Record<string,any>=>{
  let value:any;try{value=JSON.parse(text(path));}catch{throw new Error(`Invalid archive metadata: ${path}`);}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid archive metadata: ${path}`);return value;
 };
 const catalog=ctx.db;const members=ctx.db;
 for(const archivePath of new Set(sources.map(e=>e.archivePath!))){
  if(!archivePath)throw new Error("Missing export archive identity");
  if(archivePath.startsWith("backups/fired-")){
   const metadataPath=`${archivePath}/member.json`;
   if(paths.has(metadataPath)){
    const raw=object(metadataPath);if(typeof raw.name!=="string"||!raw.name)throw new Error("Invalid fired member name");
    const personaPath=[`${archivePath}/persona.md`,`${archivePath}/member.md`,`${archivePath}/memory/persona.md`].find(p=>paths.has(p));
    const format=personaPath?.endsWith("/member.md")?"frontmatter":"plain";
    const parsed:ReturnType<typeof parseLegacyMemberPersona>|undefined=personaPath?(format==="frontmatter"?parseLegacyMemberPersona(read(personaPath),personaPath):{body:Buffer.from(text(personaPath))}):undefined;
    const source=catalogFromFiredExport({archivePath,member:{name:raw.name,agentTemplate:raw.agentTemplate||"general",global:raw.global??{},title:raw.title??parsed?.title},
     persona:personaPath?{path:personaPath,format,hasContent:!!(parsed&&Buffer.from(parsed.body).toString("utf8").trim())}:undefined});
    const at=archiveTime(archivePath);
    // A complete stable-ID export can retain a deleted identity. It cannot steal
    // a still-live ID, or associate a name-only export with a current name.
    if(typeof raw.id==="string"&&at!==undefined&&raw.createdAt!==undefined&&raw.updatedAt!==undefined&&raw.agentTemplate!==undefined&&raw.global!==undefined){
     const record=parseLegacyMemberRecord(read(metadataPath),raw.id,metadataPath);
     if(!getRetainedMember(record.id, members))importArchivedMember(record,archivePath,at, members);
     if(!getMember(record.id, members)){
      if(memberArchivePath(record.id, members)!==archivePath)throw new Error("Conflicting archived identity locations");
      source.memberId=record.id;
     }
    }
    importMemberArchiveCatalog(source, catalog);
   }
  }else{
   const manifestPath=`${archivePath}/manifest.json`;
   if(paths.has(manifestPath)){
    const manifest=object(manifestPath);
    if(manifest.members!==undefined&&!Array.isArray(manifest.members))throw new Error("Invalid legacy archive members");
    const records=(manifest.members??[]).map((member:any)=>{
     if(!member||typeof member.name!=="string"||!member.name)throw new Error("Invalid legacy archive member");
     let personaPath:string|undefined;
     if(typeof member.principlesPath==="string"){
      const candidate=member.principlesPath.startsWith(`${archivePath}/`)?member.principlesPath
       :member.principlesPath.includes("/rooms/")?`${archivePath}/rooms/${member.principlesPath.split("/rooms/").at(-1)}`:undefined;
      if(candidate&&paths.has(candidate))personaPath=candidate;
     }
     return {...member,personaPath,hasPersona:personaPath?!!text(personaPath).trim():false};
    });
    for(const source of catalogFromLegacyManifest({archivePath,members:records}))importMemberArchiveCatalog(source, catalog);
   }
  }
 }
 for(const e of sources){if(!ctx.sourceFiles.includes(e.path))throw new Error("Incomplete export snapshot");consumed.add(e.path);}
 return consumed;
}

function text(bytes:Uint8Array,path:string):string{
 try{return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Error(`Invalid document UTF-8: ${path}`);}
}

/** Legacy writers replaced every character outside this set when deriving filesystem owner segments. */
const safeSegment=(value:string)=>value.replace(/[^a-zA-Z0-9._-]/g,"_");

/** Current layouts and old copy-forward layouts remain separate document identities.
 * History is never fabricated from today's body; body assets stay outside SQLite. */
export async function importLegacyDocuments(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],personas:MemberSourceImport["personas"]):Promise<Set<string>>{
 ctx.db.assertOutsideTransaction();const consumed=new Set<string>();const plans=new Map<string,DocumentImport>();
 // Topic feature retired (fish #19358): member-scope topic documents are not
 // imported; they follow the standard source-retire flow like other topic sources.
 // Principles/mainline retired (fish 2026-09-17): their document sources are not
 // imported either — the old files stay in place, nothing serves them.
 const retiredMemoryLayer=(layer:string|undefined)=>layer==="principles"||layer==="mainline";
 const importable=entries.filter(e=>!retiredMemoryLayer(e.layer));
 for(const e of entries)if(retiredTopicScope(e.scopeId)||retiredMemoryLayer(e.layer))consumed.add(e.path);
 const bodies=new Map(personas.map(p=>[p.path,text(p.body,p.path)]));
 const check=(e:LegacySourceEntry)=>{if(!ctx.sourceFiles.includes(e.path))throw new Error(`Unsnapshotted document source: ${e.path}`);};
 const scope=(s:string|undefined)=>s===undefined?undefined:ensureImportedScope(ctx.db,s);
 const plan=(identity:DocumentIdentity,metadataSource:DocumentImport["metadataSource"])=>{
  const previous=plans.get(identity.path);
  if(previous){if(!isDeepStrictEqual(previous.identity,identity)||previous.metadataSource!==metadataSource)throw new Error(`Ambiguous document ownership: ${identity.path}`);return previous;}
  const next:DocumentImport={identity,metadataSource,currentContent:"",history:[]};plans.set(identity.path,next);return next;
 };
 const direct=(e:LegacySourceEntry)=>{
  if(!e.documentPath||!e.layer)throw new Error(`Document source has no identity: ${e.path}`);
  return plan({path:e.documentPath,layer:e.layer,memberId:e.memberId??e.ownerKey,scopeId:scope(e.scopeId)},e.layout==="member"?"history":"file");
 };
 const roomDocument=(e:LegacySourceEntry,owner?:string)=>{
  if(owner!==undefined&&(typeof owner!=="string"||!owner))throw new Error(`Invalid document owner: ${e.path}`);
  const root=`rooms/${e.path.split("/")[1]}`;
  const safe=owner===undefined?undefined:safeSegment(owner);
  const path=e.layout==="copy-forward"
   ?owner?`${root}/${e.layer==="mainline"?"mainlines":"prompt-supplements"}/members/${safe}.md`:`${root}/prompt-supplements/room.md`
   :owner?`${root}/memory/members/${safe}/${e.layer}.md`:`${root}/memory/room-principles.md`;
  if(!e.layer||!owner&&e.layer!=="principles")throw new Error(`Invalid room document subject: ${e.path}`);
  return plan({path,layer:e.layer,memberId:owner,scopeId:scope(e.scopeId)},"file");
 };
 // Metadata/history contain unsanitized legacy subject keys. Process them first so
 // a sanitized body basename cannot silently choose between colliding identities.
 let completed=0;
 for(const e of importable.filter(e=>e.kind==="document-meta"||e.kind==="document-history")){
  if(retiredTopicScope(e.scopeId))continue;
  check(e);
  if(e.kind==="document-meta"){
   const meta=requireObject(readLegacyJson(ctx.sourceRoot,e), `Invalid legacy document object: ${e.path}`);
   if(meta.room!==undefined)roomDocument(e).meta=requireObject(meta.room, `Invalid legacy document object: ${e.path}`) as DocumentMeta;
   if(meta.members!==undefined)for(const [owner,value]of Object.entries(requireObject(meta.members, `Invalid legacy document object: ${e.path}`)))roomDocument(e,owner).meta=requireObject(value, `Invalid legacy document object: ${e.path}`) as DocumentMeta;
  }else{
   for await(const row of readLegacyJsonl(ctx.sourceRoot,e)){
    const event=requireObject(row.value, `Invalid legacy document object: ${e.path}`);
    const p=e.layout==="member"?direct(e):roomDocument(e,event.scope==="room"?undefined:event.memberId);
    if(e.layout!=="member"&&event.scope!=="room"&&typeof event.memberId!=="string")throw new Error(`Missing document history subject: ${e.path}`);
    if(typeof event.content!=="string")throw new Error(`Missing historical document body: ${e.path}`);
    const history={...event,scopeId:scope(event.scopeId)} as ImportedDocumentHistory;
    (p.history as ImportedDocumentHistory[]).push(history);
    if(++completed%128===0)ctx.progress(completed);
   }
  }
  consumed.add(e.path);
 }
 for(const e of importable.filter(e=>e.kind==="document-body")){
  if(retiredTopicScope(e.scopeId))continue;
  check(e);const file=managedPath(ctx.sourceRoot,e.path);requireRegularFile(file);const content=text(readFileSync(file),e.path);
  if(bodies.has(e.path)&&bodies.get(e.path)!==content)throw new Error(`Conflicting current document body: ${e.path}`);
  bodies.set(e.path,content);
  if(!plans.has(e.path))direct(e);
  consumed.add(e.path);
 }
 for(const p of personas)plan({path:p.path,layer:"persona",memberId:p.memberId,scopeId:undefined},"history");
 for(const p of plans.values()){
  p.currentContent=bodies.get(p.identity.path)??"";
  if(p.meta){const fallback=documentContentMeta(p.currentContent);p.meta={...p.meta,revision:p.meta.revision??0,contentHash:p.meta.contentHash||fallback.contentHash,contentLength:p.meta.contentLength??fallback.contentLength};}
  // Legacy readers presented missing current bodies as empty. Materialize that
  // empty asset, never an earlier historical revision, for the new reference.
  if(!bodies.has(p.identity.path))ctx.stageAsset(p.identity.path,Buffer.alloc(0));
  importDocument(ctx.db,{stageAsset(path,bytes){
   if(!ctx.sourceFiles.includes(path)){ctx.stageAsset(path,bytes);return;}
   // importDocument derives this exact path from the proven document identity
   // and historical body hash. Retry may have already published that snapshot.
   const source=entries.find(e=>e.path===path);
   const ownerMatches=source!==undefined&&(source.memberId??source.ownerKey)===p.identity.memberId;
   const derivedOwner=p.identity.memberId===undefined?undefined:safeSegment(p.identity.memberId);
   const sanitizedOwnerMatches=source!==undefined&&derivedOwner!==undefined&&(source.memberId??source.ownerKey)===derivedOwner;
   if(!source||source.kind!=="document-snapshot"||source.retire||source.layer!==p.identity.layer
    ||!(ownerMatches||sanitizedOwnerMatches)||scope(source.scopeId)!==p.identity.scopeId){
    throw new Error(`Unverified historical snapshot ownership: ${path}`);
   }
   const file=managedPath(ctx.sourceRoot,path);requireRegularFile(file);
   if(!readFileSync(file).equals(Buffer.from(bytes)))throw new Error(`Historical snapshot differs: ${path}`);
   const live=managedPath(ctx.root,path);requireRegularFile(live);
   if(!readFileSync(live).equals(Buffer.from(bytes)))throw new Error(`Historical snapshot changed: ${path}`);
   syncPath(live);syncDirectoryChain(dirname(live),ctx.root);
  }},p);ctx.progress(++completed);
 }
 // Existing content-addressed snapshots remain assets, not legacy metadata.
 for(const e of importable.filter(e=>e.kind==="document-snapshot")){if(retiredTopicScope(e.scopeId))continue;check(e);consumed.add(e.path);}
 return consumed;
}

/** Current SQL identity and document ownership must have a regular persona asset.
 * No content/hash comparison: legitimate current body edits remain authoritative.
 * Tombstones intentionally have no live directory. Pending archives are not active:
 * verify their recorded directory identity so activation can finish existing recovery. */
export function verifyActiveMemberAssets(root: string, db: Database): void {
  db.assertOutsideTransaction();
  const archives = db;
  for (const { id } of db.all<{ id: string }>("SELECT id FROM members WHERE archived_at IS NULL")) {
    const path = `members/${id}/persona.md`;
    if (!db.get("SELECT 1 FROM memory_documents WHERE path=? AND member_id=? AND layer='persona' AND scope_id IS NULL", path, id)) {
      throw new Error(`Member persona metadata missing: ${id}`);
    }
    const intent = readMemberArchiveIntent(id, archives);
    let assetPath = path;
    if (intent?.state === "pending") {
      // Archive movement precedes its SQL completion. Only the explicit SQL intent,
      // exact source path and original directory device/inode authorize this location.
      // Verification never reads stale legacy bodies or copies assets back.
      validateArchivePath(intent.archivePath);
      if (intent.sourcePath !== `members/${id}`) throw new Error(`Pending archive source conflict: ${id}`);
      const source = lstatSync(managedPath(root, intent.sourcePath), { throwIfNoEntry: false });
      const destination = lstatSync(managedPath(root, intent.archivePath), { throwIfNoEntry: false });
      const location = source ?? destination;
      if ((source && destination) || !location?.isDirectory() || String(location.dev) !== intent.sourceDevice || String(location.ino) !== intent.sourceInode) {
        throw new Error(`Pending archive asset identity conflict: ${id}`);
      }
      assetPath = `${source ? intent.sourcePath : intent.archivePath}/persona.md`;
    }
    try { requireRegularFile(managedPath(root, assetPath)); }
    catch { throw new Error(`Active member persona asset missing or unsafe: ${id}; no legacy body was restored`); }
  }
}
