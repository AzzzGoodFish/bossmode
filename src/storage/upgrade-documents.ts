import {readFileSync} from "node:fs";
import {isDeepStrictEqual} from "node:util";
import type {UpgradeImportContext} from "./upgrade-runner.js";
import type {MemberSourceImport} from "./upgrade-members.js";
import {readLegacyJson,readLegacyJsonl,type LegacySourceEntry} from "./legacy-inventory.js";
import {managedPath,requireRegularFile} from "./upgrade-files.js";
import {ensureImportedScope} from "./upgrade-conversations.js";
import {documentContentMeta,importDocument,type DocumentImport,type DocumentIdentity,type ImportedDocumentHistory} from "./document-repository.js";
import type {PrinciplesMeta} from "../shared/types.js";

function object(value:unknown,path:string):Record<string,any>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid legacy document object: ${path}`);
 return value as Record<string,any>;
}
function text(bytes:Uint8Array,path:string):string{
 try{return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Error(`Invalid document UTF-8: ${path}`);}
}
/** Current layouts and old copy-forward layouts remain separate document identities.
 * History is never fabricated from today's body; body assets stay outside SQLite. */
export async function importLegacyDocuments(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],personas:MemberSourceImport["personas"]):Promise<Set<string>>{
 ctx.db.assertOutsideTransaction();const consumed=new Set<string>();const plans=new Map<string,DocumentImport>();
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
  const safe=owner?.replace(/[^a-zA-Z0-9._-]/g,"_");
  const path=e.layout==="copy-forward"
   ?owner?`${root}/${e.layer==="mainline"?"mainlines":"prompt-supplements"}/members/${safe}.md`:`${root}/prompt-supplements/room.md`
   :owner?`${root}/memory/members/${safe}/${e.layer}.md`:`${root}/memory/room-principles.md`;
  if(!e.layer||!owner&&e.layer!=="principles")throw new Error(`Invalid room document subject: ${e.path}`);
  return plan({path,layer:e.layer,memberId:owner,scopeId:scope(e.scopeId)},"file");
 };
 // Metadata/history contain unsanitized legacy subject keys. Process them first so
 // a sanitized body basename cannot silently choose between colliding identities.
 let completed=0;
 for(const e of entries.filter(e=>e.kind==="document-meta"||e.kind==="document-history")){
  check(e);
  if(e.kind==="document-meta"){
   const meta=object(readLegacyJson(ctx.sourceRoot,e),e.path);
   if(meta.room!==undefined)roomDocument(e).meta=object(meta.room,e.path) as PrinciplesMeta;
   if(meta.members!==undefined)for(const [owner,value]of Object.entries(object(meta.members,e.path)))roomDocument(e,owner).meta=object(value,e.path) as PrinciplesMeta;
  }else{
   for await(const row of readLegacyJsonl(ctx.sourceRoot,e)){
    const event=object(row.value,e.path);
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
 for(const e of entries.filter(e=>e.kind==="document-body")){
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
  importDocument(ctx.db,ctx,p);ctx.progress(++completed);
 }
 // Existing content-addressed snapshots remain assets, not legacy metadata.
 for(const e of entries.filter(e=>e.kind==="document-snapshot")){check(e);consumed.add(e.path);}
 return consumed;
}
