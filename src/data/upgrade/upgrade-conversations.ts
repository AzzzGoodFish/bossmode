import { requireObject } from "../../kernel/json.js";
import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {Database} from "../database.js";
import type {UpgradeImportContext} from "./upgrade-runner.js";
import {readLegacyJson,readLegacyJsonl,readLegacyEventJsonl,type LegacySourceEntry} from "./legacy-inventory.js";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {archiveRawRetiredSource} from "../migrations/task-retirement.js";
import {ConversationsRepository} from "../repositories/conversations.js";
import {MessageArchivesRepository,type ArchiveSummary} from "../repositories/message-archives.js";
import {UserCursorRepository} from "../repositories/user-cursor-repository.js";
import {executionScopeId} from "../repositories/execution-identity.js";
import {importMessage,importMessageNextSequence,importArchivedMessage,writeMemberCursor,writeDmMemberCursor} from "../repositories/message-repository.js";
import {importAgentEvent,readAgentEvent,rebuildEventAggregates,type EventPayload} from "../repositories/event-repository.js";
import type {Room,RoomMessage} from "../../kernel/types.js";


/** Topic feature retired (fish #19358, 2026-09-11): topic scopes are never
 * imported. Legacy topic sources are consumed by the standard source-retire
 * flow instead of being imported; no topic archive copy is written. */
export function retiredTopicScope(scope:string|undefined):boolean{return !!scope&&scope.startsWith("topic:");}
/** Missing historical metadata does not justify inventing a current room or member. */
export function ensureImportedScope(db:Database,input:string,_roomHint?:string):string{
 const id=executionScopeId(input);if(db.get("SELECT id FROM scopes WHERE id=?",id))return id;
 const kind=id.startsWith("dm:")?"dm":"room";
 db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES(?,?,?,?)",id,kind,kind==="room"?id:null,kind==="dm"?id.slice(3):null);
 return id;
}
/** Actor evidence is independent of execution-event evidence. Neither is inferred
 * from current names, filenames, timestamps, sequence values or equal payloads. */
export interface LegacyConversationImportOptions {
 eventOwner?:(entry:LegacySourceEntry)=>{ownerKey:string;memberId:string|null};
 /** A globally stable, nonblank identity for this particular execution event, from
  * verified historical evidence. Ordinal is the original nonblank JSONL position.
  * undefined means an independent occurrence, even when the actor/payload matches.
  * The caller owns proof authenticity; the importer validates scope/actor/payload
  * consistency and source order. Normal startup has no such evidence or callback.
  * Proof-bearing imports prepare event rows outside SQL, then commit them together.
  */
 eventProvenance?:(entry:LegacySourceEntry,ordinal:number)=>string|undefined;
}
interface ImportEventRow { ordinal:number;value:unknown;proof?:string }
interface ImportEventSource {
 entry:LegacySourceEntry;owner:string;memberId:string|null;rows:ImportEventRow[];
}
interface EventOccurrence {
 path:string;ordinal:number;eventId:string;proof:string|null;
 scopeId:string;ownerKey:string;memberId:string|null;
 sourceScopeId:string;sourceOwnerKey:string|null;sourceTimestamp:number;mtimeMs:number;
}
const occurrencePrefix="legacy-event-occurrence-v1:";
function sourceHash(path:string):string{return createHash("sha256").update(path).digest("hex");}
function eventSource(entry:LegacySourceEntry,options:LegacyConversationImportOptions):ImportEventSource{
 const identity=options.eventOwner?.(entry);
 if(options.eventOwner&&(!identity||typeof identity.ownerKey!=="string"||!identity.ownerKey
  ||(identity.memberId!==null&&(typeof identity.memberId!=="string"||!identity.memberId))))throw new Error(`Invalid legacy event owner: ${entry.path}`);
 const owner=identity?.ownerKey??(entry.ownerKey?`legacy-unresolved:${entry.ownerKey}`:"");
 const memberId=identity?.memberId??null;
 if(!owner||typeof owner!=="string"||(memberId!==null&&(typeof memberId!=="string"||!memberId)))throw new Error(`Invalid legacy event owner: ${entry.path}`);
 return {entry,owner,memberId,rows:[]};
}
/** Import-only occurrence receipts use the existing versioned storage metadata
 * namespace. They retain every source location even when several locations prove
 * one fact. They are not live SDK replay receipts or a second event authority. */
function importEventRows(db:Database,source:ImportEventSource):void{
 const {entry:e,owner,memberId}=source;
 const scope=ensureImportedScope(db,e.scopeId!,e.path.startsWith("rooms/")?e.path.split("/")[1]:undefined);
 if(memberId!==null&&!db.get("SELECT id FROM members WHERE id=?",memberId))throw new Error("Unknown imported event member ID");
 const hash=sourceHash(e.path);
 for(const row of source.rows){
  const event=requireObject(row.value, `Invalid legacy conversation object: ${e.path}`);
  if(typeof event.type!=="string"||!event.type)throw new Error(`Invalid legacy event: ${e.path}`);
  const sourceId=`legacy:${hash}:${row.ordinal}`;
  const id=row.proof===undefined?sourceId:`legacy-proven:${row.proof}`;
  const key=`${occurrencePrefix}${hash}:${row.ordinal}`;
  const stored=db.get<{value:string}>("SELECT value FROM storage_meta WHERE key=?",key);
  const receipt:EventOccurrence|undefined=stored?JSON.parse(stored.value):undefined;
  if(receipt&&(receipt.path!==e.path||receipt.ordinal!==row.ordinal||receipt.eventId!==id||receipt.proof!==(row.proof??null)
   ||receipt.scopeId!==scope||receipt.ownerKey!==owner||receipt.memberId!==memberId
   ||receipt.sourceScopeId!==e.scopeId||receipt.sourceOwnerKey!==(e.ownerKey??null)))throw new Error(`Conflicting legacy event provenance: ${e.path}:${row.ordinal}`);
  // An already imported independent occurrence cannot acquire a new identity by
  // retroactive content matching. This also covers pre-receipt importer facts.
  if(id!==sourceId&&readAgentEvent(sourceId,db))throw new Error(`Conflicting legacy event provenance: ${e.path}:${row.ordinal}`);
  const previous=readAgentEvent(id,db);
  const proofKey=row.proof===undefined?undefined:`legacy-event-proof-v1:${row.proof}`;
  const proven=proofKey===undefined?undefined:db.get<{value:string}>("SELECT value FROM storage_meta WHERE key=?",proofKey);
  // A caller-selected live event ID is not itself a historical proof receipt.
  if(proofKey!==undefined&&(previous?proven?.value!==JSON.stringify({eventId:id}):proven!==undefined))throw new Error(`Conflicting legacy event proof: ${e.path}:${row.ordinal}`);
  if(receipt&&!previous)throw new Error(`Conflicting legacy event provenance: ${e.path}:${row.ordinal}`);
  if(previous&&(previous.scopeId!==scope||previous.ownerKey!==owner||previous.memberId!==memberId||!isDeepStrictEqual(previous.event,event)))throw new Error(`Conflicting imported event identity: ${e.path}:${row.ordinal}`);
  const ts=typeof event.ts==="number"&&Number.isFinite(event.ts)?event.ts:Math.trunc(e.mtimeMs);
  if(!previous){
   const seq=(db.get<{seq:number}>("SELECT MAX(seq) seq FROM agent_events WHERE scope_id=? AND owner_key=?",scope,owner)?.seq??0)+1;
   importAgentEvent(db,{id,scopeId:scope,ownerKey:owner,memberId,seq,ts,event:event as EventPayload});
   if(proofKey!==undefined)db.run("INSERT INTO storage_meta(key,value) VALUES(?,?)",proofKey,JSON.stringify({eventId:id}));
  }
  if(!receipt){
   const value:EventOccurrence={path:e.path,ordinal:row.ordinal,eventId:id,proof:row.proof??null,
    scopeId:scope,ownerKey:owner,memberId,sourceScopeId:e.scopeId!,sourceOwnerKey:e.ownerKey??null,sourceTimestamp:ts,mtimeMs:e.mtimeMs};
   db.run("INSERT INTO storage_meta(key,value) VALUES(?,?)",key,JSON.stringify(value));
  }
 }
}
/** A fact may occupy different original ordinals in duplicate sources. Merge only
 * their explicit order constraints, not ordinal equality. Existing SQL order is
 * the tie breaker for otherwise unrelated events, not evidence of execution order.
 * A cycle means the proofs cannot all hold; never silently discard an occurrence.
 */
function orderProvenEvents(db:Database,scope:string,owner:string):boolean{
 const facts=db.all<{id:string;seq:number}>("SELECT id,seq FROM agent_events WHERE scope_id=? AND owner_key=? ORDER BY seq",scope,owner);
 const rank=new Map(facts.map((f,i)=>[f.id,i]));
 const edges=new Map(facts.map(f=>[f.id,new Set<string>()]));
 const incoming=new Map(facts.map(f=>[f.id,0]));
 const link=(a:string,b:string)=>{
  if(!edges.has(a)||!edges.has(b))throw new Error("Conflicting legacy event provenance: missing fact");
  if(a!==b&&!edges.get(a)!.has(b)){edges.get(a)!.add(b);incoming.set(b,incoming.get(b)!+1);}
 };
 const sources=new Map<string,EventOccurrence[]>();const recorded=new Set<string>();
 for(const row of db.all<{value:string}>("SELECT value FROM storage_meta WHERE key LIKE ? AND json_extract(value,'$.scopeId')=? AND json_extract(value,'$.ownerKey')=?",occurrencePrefix+"%",scope,owner)){
  const receipt=JSON.parse(row.value) as EventOccurrence;
  const source=sources.get(receipt.path)??[];source.push(receipt);sources.set(receipt.path,source);recorded.add(receipt.eventId);
 }
 for(const source of sources.values()){
  source.sort((a,b)=>a.ordinal-b.ordinal);
  for(let i=1;i<source.length;i++)link(source[i-1].eventId,source[i].eventId);
 }
 // Facts outside this importer have no occurrence receipts. Preserve their own
 // established relative order without pretending that they prove source aliases.
 const other=facts.filter(f=>!recorded.has(f.id));
 for(let i=1;i<other.length;i++)link(other[i-1].id,other[i].id);
 const ready=facts.filter(f=>incoming.get(f.id)===0).map(f=>f.id);const ordered:string[]=[];
 while(ready.length){
  const id=ready.shift()!;ordered.push(id);
  for(const next of edges.get(id)!){
   const count=incoming.get(next)!-1;incoming.set(next,count);
   if(count===0){
    let lo=0,hi=ready.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(rank.get(ready[mid])!<rank.get(next)!)lo=mid+1;else hi=mid;}
    ready.splice(lo,0,next);
   }
  }
 }
 if(ordered.length!==facts.length)throw new Error("Conflicting imported event source order");
 if(ordered.every((id,i)=>id===facts[i].id))return false;
 const max=facts.at(-1)?.seq??0;
 if(!Number.isSafeInteger(max+facts.length))throw new Error("Imported event sequence exhausted");
 // Move above the existing range first so UNIQUE(scope,owner,seq) never decides
 // which source wins. Source ordinals remain immutable in occurrence receipts.
 for(let i=0;i<ordered.length;i++)db.run("UPDATE agent_events SET seq=? WHERE id=?",max+i+1,ordered[i]);
 for(let i=0;i<ordered.length;i++)db.run("UPDATE agent_events SET seq=? WHERE id=?",i+1,ordered[i]);
 return true;
}
/** Full source order is retained, including non-activity events. Imports never emit outbox work. */
export async function importLegacyConversations(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],options:LegacyConversationImportOptions={}):Promise<Set<string>>{
 ctx.db.assertOutsideTransaction();const consumed=new Set<string>();
 const check=(e:LegacySourceEntry)=>{if(!ctx.sourceFiles.includes(e.path))throw new Error(`Unsnapshotted conversation source: ${e.path}`);};
 const read=(e:LegacySourceEntry)=>{check(e);return readLegacyJson(ctx.sourceRoot,e);};
 const conversations=new ConversationsRepository(ctx.db);
 for(const e of entries.filter(e=>e.kind==="room-metadata")){
  const room=requireObject(read(e), `Invalid legacy conversation object: ${e.path}`) as Room;
  if(room.id!==e.scopeId)throw new Error(`Room source ownership mismatch: ${e.path}`);
  conversations.upsertRoom(room);consumed.add(e.path);
 }
 let completed=0;const provenSources:ImportEventSource[]=[];
 for(const e of entries){
  if(consumed.has(e.path))continue;
  // Topic feature retired (fish #19358): legacy topic sources (metadata, messages,
  // sequences, events, archives) are not imported. They are consumed here so the
  // source-retire flow retains no unhandled domain; no topic archive copy is written.
  if(e.kind==="topic-metadata"||retiredTopicScope(e.scopeId)){consumed.add(e.path);continue;}
  if(e.kind==="user-cursors"){
   const cursors=requireObject(read(e), `Invalid legacy conversation object: ${e.path}`);const repo=new UserCursorRepository(ctx.db);
   for(const [key,cursor]of Object.entries(cursors)){
    if(retiredTopicScope(key))continue; // topic scope retired (fish #19358)
    ensureImportedScope(ctx.db,key);repo.importCursor(key,cursor);
   }
   consumed.add(e.path);continue;
  }
  if(!["tasks","messages","message-sequence","member-cursors","dm-member-cursor","agent-events","message-archive","message-archive-summary","derived-event-stats"].includes(e.kind))continue;
  check(e);if(!e.scopeId&&e.kind!=="tasks")throw new Error(`Conversation source has no scope: ${e.path}`);
  // Task feature retired (fish #19259): legacy rooms/<room>/tasks.json files are no
  // longer imported into SQL. Their bytes are preserved in the retirement archive so
  // nothing is silently discarded; the file is then consumed (source retired).
  if(e.kind==="tasks"){
   const bytes=readFileSync(join(ctx.sourceRoot,e.path));
   archiveRawRetiredSource(ctx.root,e.path,bytes);
   consumed.add(e.path);continue;
  }
  if(!e.scopeId)throw new Error(`Conversation source has no scope: ${e.path}`);
  if(e.kind==="agent-events"){
   const source=eventSource(e,options);let bytes=0;let count=0;
   const flush=()=>{ctx.db.transaction(tx=>importEventRows(tx,source));completed+=source.rows.length;source.rows=[];bytes=0;ctx.progress(completed);};
   for await(const row of readLegacyEventJsonl(ctx.sourceRoot,e,invalid=>{
    // Import diagnostics are not business events or execution intent. Keep all
    // bytes, including CR/LF, and original coordinates without inventing an actor.
    const key=`legacy-invalid-event-v1:${sourceHash(e.path)}:${invalid.ordinal}`;
    const value=JSON.stringify({path:e.path,ordinal:invalid.ordinal,lineNumber:invalid.lineNumber,reason:"invalid-json",rawBase64:invalid.raw.toString("base64"),sha256:createHash("sha256").update(invalid.raw).digest("hex")});
    const prior=ctx.db.get<{value:string}>("SELECT value FROM storage_meta WHERE key=?",key);
    if(prior&&prior.value!==value)throw new Error(`Conflicting invalid event source: ${e.path}:${invalid.ordinal}`);
    if(!prior)ctx.db.run("INSERT INTO storage_meta(key,value) VALUES(?,?)",key,value);
   })){
    const proof=options.eventProvenance?.(e,row.ordinal);
    if(proof!==undefined&&(typeof proof!=="string"||!proof.trim()))throw new Error(`Invalid legacy event provenance: ${e.path}:${row.ordinal}`);
    source.rows.push({...row,proof});count++;bytes+=Buffer.byteLength(JSON.stringify(row.value));
    if(!options.eventProvenance&&(source.rows.length>=128||bytes>=1024*1024))flush();
   }
   if(options.eventProvenance)provenSources.push(source);else if(source.rows.length||count===0)flush();
   consumed.add(e.path);continue;
  }
  const scope=ensureImportedScope(ctx.db,e.scopeId,e.path.startsWith("rooms/")?e.path.split("/")[1]:undefined);
  if(e.kind==="message-archive-summary"){
   new MessageArchivesRepository(ctx.db).saveSummary(scope,Number(e.archiveTimestamp),requireObject(read(e), `Invalid legacy conversation object: ${e.path}`) as ArchiveSummary);
  }else if(e.kind==="message-sequence")importMessageNextSequence(ctx.db,scope,read(e) as number);
  else if(e.kind==="member-cursors"){
   const cursors=requireObject(read(e), `Invalid legacy conversation object: ${e.path}`);for(const [actor,value]of Object.entries(cursors)){
    if(value!==null&&typeof value!=="string")throw new Error(`Invalid legacy member cursor: ${e.path}`);
    writeMemberCursor(scope,actor,value,ctx.db,Math.trunc(e.mtimeMs));
   }
  }else if(e.kind==="dm-member-cursor"){
   if(!e.memberId)throw new Error("DM cursor has no member ID");writeDmMemberCursor(ctx.db,e.memberId,read(e) as any,Math.trunc(e.mtimeMs));
  }else if(e.kind!=="derived-event-stats"){
   const archiveTs=e.kind==="message-archive"?Number(e.archiveTimestamp):null;
   if(e.kind==="message-archive")new MessageArchivesRepository(ctx.db).recordMessages(scope,archiveTs!);
   let batch:Array<{ordinal:number;value:unknown}>=[];let bytes=0;
   const flush=()=>{
    ctx.db.transaction(tx=>{for(const row of batch){
     if(e.kind==="messages")importMessage(tx,scope,row.value as RoomMessage);
     else if(e.kind==="message-archive")importArchivedMessage(tx,scope,archiveTs!,row.ordinal-1,row.value as RoomMessage);
    }});
    completed+=batch.length;batch=[];bytes=0;ctx.progress(completed);
   };
   for await(const row of readLegacyJsonl(ctx.sourceRoot,e)){
    batch.push(row);bytes+=Buffer.byteLength(JSON.stringify(row.value));if(batch.length>=128||bytes>=1024*1024)flush();
   }
   if(batch.length)flush();
  }
  consumed.add(e.path);
 }
 if(provenSources.length){
  ctx.db.transaction(tx=>{
   const streams=new Map<string,{scope:string;owner:string}>();
   for(const source of provenSources){
    importEventRows(tx,source);
    const scope=executionScopeId(source.entry.scopeId!);
    streams.set(JSON.stringify([scope,source.owner]),{scope,owner:source.owner});
   }
   let reordered=false;
   for(const {scope,owner}of streams.values())reordered=orderProvenEvents(tx,scope,owner)||reordered;
   if(reordered)rebuildEventAggregates(tx);
  });
  completed+=provenSources.reduce((n,s)=>n+s.rows.length,0);ctx.progress(completed);
 }
 return consumed;
}
