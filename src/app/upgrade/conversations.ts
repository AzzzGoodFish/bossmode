import { type Database } from "../../data/database.js";
import { type LegacySourceEntry, type UpgradeImportContext, readLegacyJson, readLegacyJsonl, readLegacyEventJsonl } from "./inventory.js";
import { createHash } from "node:crypto";
import { canonicalJson, requireObject } from "../../kernel/json.js";
import { isDeepStrictEqual } from "node:util";
import { importHistoricalEvent, readAgentEvent, type AgentHistoryEvent, rebuildEventAggregates } from "../../agent/events.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { archiveRawRetiredSource } from "./retirements.js";
import { parseConversation, storageScopeId, storeRoom, type Room } from "../../chat/conversations.js";
import { importArchivedMessage, recordMessageArchive, saveArchiveSummary, type ArchiveSummary } from "../../chat/archives.js";
import { setDmMemberCursor, setMemberCursor, setUserReadCursor, type UserReadCursor } from "../../chat/cursors.js";
import { importMessage, importMessageNextSequence, type Message } from "../../chat/messages.js";
export function retiredTopicScope(scope:string|undefined):boolean{return !!scope&&scope.startsWith("topic:");}
export function ensureImportedScope(db:Database,input:string,roomHint?:string):string{
 const ref=parseConversation(input)??(roomHint===input?parseConversation(`room:${roomHint}`):null);if(!ref)throw new Error(`Invalid execution scope: ${input}`);
 const id=storageScopeId(ref.scopeId);if(db.get("SELECT id FROM scopes WHERE id=?",id))return id;
 if(ref.kind==="room")db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES(?,'room',?,NULL)",id,ref.roomId);
 else if(ref.kind==="dm")db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES(?,'dm',NULL,?)",id,ref.memberId);
 else db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES(?,'mm',NULL,?)",id,ref.memberIds.join("|"));
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
function importEventRows(db:Database,source:ImportEventSource,sequenceByEventId?:ReadonlyMap<string,number>):void{
 const {entry:e,owner,memberId}=source;
 const scope=ensureImportedScope(db,e.scopeId!,e.path.startsWith("rooms/")?e.path.split("/")[1]:undefined);
 if(memberId!==null&&!db.get("SELECT id FROM members WHERE id=?",memberId))throw new Error("Unknown imported event member ID");
 const hash=sourceHash(e.path);
 for(const row of source.rows){
  const event=requireObject(row.value, `Invalid legacy conversation object: ${e.path}`);
  if(typeof event.type!=="string"||!event.type)throw new Error(`Invalid legacy event: ${e.path}`);
  const sourceId=`legacy:${hash}:${row.ordinal}`;
  const id=row.proof===undefined?sourceId:`legacy-proven:${row.proof}`;
  const inputFingerprint=createHash("sha256").update(canonicalJson(event,"Invalid historical event JSON")).digest("hex");
  const receipt=db.get<{event_id:string;input_fingerprint:string}>(
   "SELECT event_id,input_fingerprint FROM event_source_receipts WHERE source_key=? AND source_seq=?",e.path,row.ordinal);
  if(receipt&&(receipt.event_id!==id||receipt.input_fingerprint!==inputFingerprint))throw new Error(`Conflicting legacy event provenance: ${e.path}:${row.ordinal}`);
  if(id!==sourceId&&readAgentEvent(sourceId,db))throw new Error(`Conflicting legacy event provenance: ${e.path}:${row.ordinal}`);
  const previous=readAgentEvent(id,db);
  if(receipt&&!previous)throw new Error(`Conflicting legacy event provenance: ${e.path}:${row.ordinal}`);
  const sourceRef=memberId===null?undefined:(scope.startsWith("dm:")||scope.startsWith("mm:")||scope.startsWith("room:")?scope:`room:${scope}`);
  const plannedSequence=sequenceByEventId?.get(id);
  if(previous&&(previous.historicalSourceKey!==scope||previous.historicalOwnerKey!==owner||previous.memberId!==memberId||previous.sourceRef!==(sourceRef??null)
   ||(plannedSequence!==undefined&&previous.historicalSeq!==plannedSequence)||!isDeepStrictEqual(previous.event,event)))throw new Error(`Conflicting imported event identity: ${e.path}:${row.ordinal}`);
  const ts=typeof event.ts==="number"&&Number.isFinite(event.ts)?event.ts:Math.trunc(e.mtimeMs);
  if(!previous){
   const sourceSeq=plannedSequence??(db.get<{seq:number}>("SELECT MAX(historical_seq) seq FROM agent_events WHERE historical_source_key=? AND historical_owner_key=?",scope,owner)?.seq??0)+1;
   importHistoricalEvent(db,{id,sourceKey:scope,ownerKey:owner,sourceSeq,memberId:memberId??undefined,sourceRef,event:event as AgentHistoryEvent,ts});
  }
  if(!receipt)db.run("INSERT INTO event_source_receipts(event_id,input_fingerprint,source_key,source_seq) VALUES(?,?,?,?)",id,inputFingerprint,e.path,row.ordinal);
 }
}

/** Build canonical logical sequence numbers before opening the import transaction.
 * Facts remain immutable after insertion; physical path/ordinal only live in occurrence
 * receipts. Repeated proofs alias a fact and contradictory source orders fail as a batch. */
function planProvenEvents(sources: readonly ImportEventSource[]): Map<string,number> {
 const result = new Map<string,number>();
 const streams = new Map<string,ImportEventSource[]>();
 for (const source of sources) {
  const scope = storageScopeId(source.entry.scopeId!);
  const key = JSON.stringify([scope,source.owner]);
  const stream = streams.get(key) ?? [];
  stream.push(source);
  streams.set(key,stream);
 }
 for (const streamSources of streams.values()) {
  const facts = new Map<string,{event:unknown;scope:string;owner:string;memberId:string|null}>();
  const edges = new Map<string,Set<string>>();
  const incoming = new Map<string,number>();
  const eventId = (source:ImportEventSource,row:ImportEventRow):string => {
   const hash = sourceHash(source.entry.path);
   return row.proof===undefined?`legacy:${hash}:${row.ordinal}`:`legacy-proven:${row.proof}`;
  };
  for (const source of streamSources) {
   const scope = storageScopeId(source.entry.scopeId!);
   let previousId:string|undefined;
   for (const row of source.rows) {
    const event = requireObject(row.value,`Invalid legacy conversation object: ${source.entry.path}`);
    if(typeof event.type!=="string"||!event.type)throw new Error(`Invalid legacy event: ${source.entry.path}`);
    const id=eventId(source,row);
    const existing=facts.get(id);
    if(existing&&(!isDeepStrictEqual(existing.event,event)||existing.scope!==scope||existing.owner!==source.owner||existing.memberId!==source.memberId)){
     throw new Error(`Conflicting imported event identity: ${source.entry.path}:${row.ordinal}`);
    }
    if(!existing)facts.set(id,{event,scope,owner:source.owner,memberId:source.memberId});
    if(!edges.has(id))edges.set(id,new Set());
    if(!incoming.has(id))incoming.set(id,0);
    if(previousId&&previousId!==id&&!edges.get(previousId)!.has(id)){
     edges.get(previousId)!.add(id);
     incoming.set(id,incoming.get(id)!+1);
    }
    previousId=id;
   }
  }
  const ready=[...facts.keys()].filter(id=>incoming.get(id)===0).sort();
  const ordered:string[]=[];
  while(ready.length){
   const id=ready.shift()!;
   ordered.push(id);
   for(const next of [...edges.get(id)!].sort()){
    const count=incoming.get(next)!-1;
    incoming.set(next,count);
    if(count===0){ready.push(next);ready.sort();}
   }
  }
  if(ordered.length!==facts.size)throw new Error("Conflicting imported event source order");
  ordered.forEach((id,index)=>result.set(id,index+1));
 }
 return result;
}

function importPlannedEventRows(db:Database,sources:readonly ImportEventSource[],sequenceByEventId:ReadonlyMap<string,number>):void{
 const occurrences=sources.flatMap(source=>source.rows.map(row=>{
  const hash=sourceHash(source.entry.path);
  const id=row.proof===undefined?`legacy:${hash}:${row.ordinal}`:`legacy-proven:${row.proof}`;
  return {source,row,id,scope:storageScopeId(source.entry.scopeId!),sequence:sequenceByEventId.get(id)!};
 }));
 occurrences.sort((a,b)=>a.scope.localeCompare(b.scope)||a.source.owner.localeCompare(b.source.owner)
  ||a.sequence-b.sequence||a.source.entry.path.localeCompare(b.source.entry.path)||a.row.ordinal-b.row.ordinal);
 for(const occurrence of occurrences){
  importEventRows(db,{...occurrence.source,rows:[occurrence.row]},sequenceByEventId);
 }
}

/** Full source order is retained, including non-activity events. Imports never emit outbox work. */
export async function importLegacyConversations(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],options:LegacyConversationImportOptions={}):Promise<Set<string>>{
 ctx.db.assertOutsideTransaction();const consumed=new Set<string>();
 const check=(e:LegacySourceEntry)=>{if(!ctx.sourceFiles.includes(e.path))throw new Error(`Unsnapshotted conversation source: ${e.path}`);};
 const read=(e:LegacySourceEntry)=>{check(e);return readLegacyJson(ctx.sourceRoot,e);};
 const conversations=ctx.db;
 for(const e of entries.filter(e=>e.kind==="room-metadata")){
  const room=requireObject(read(e), `Invalid legacy conversation object: ${e.path}`) as Room;
  if(room.id!==e.scopeId)throw new Error(`Room source ownership mismatch: ${e.path}`);
  storeRoom(room, conversations);consumed.add(e.path);
 }
 let completed=0;const provenSources:ImportEventSource[]=[];
 for(const e of entries){
  if(consumed.has(e.path))continue;
  // Topic feature retired (fish #19358): legacy topic sources (metadata, messages,
  // sequences, events, archives) are not imported. They are consumed here so the
  // source-retire flow retains no unhandled domain; no topic archive copy is written.
  if(e.kind==="topic-metadata"||retiredTopicScope(e.scopeId)){consumed.add(e.path);continue;}
  if(e.kind==="user-cursors"){
   const cursors=requireObject(read(e), `Invalid legacy conversation object: ${e.path}`);
   for(const [key,cursor]of Object.entries(cursors)){
    if(retiredTopicScope(key))continue; // topic scope retired (fish #19358)
    ensureImportedScope(ctx.db,key);
    const value = cursor as UserReadCursor;
    setUserReadCursor(key, { messageId: value.messageId, seq: value.seq }, ctx.db, value.updatedAt);
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
   saveArchiveSummary(scope,Number(e.archiveTimestamp),requireObject(read(e), `Invalid legacy conversation object: ${e.path}`) as unknown as ArchiveSummary,ctx.db);
  }else if(e.kind==="message-sequence")importMessageNextSequence(ctx.db,scope,read(e) as number);
  else if(e.kind==="member-cursors"){
   const cursors=requireObject(read(e), `Invalid legacy conversation object: ${e.path}`);for(const [actor,value]of Object.entries(cursors)){
    if(value!==null&&typeof value!=="string")throw new Error(`Invalid legacy member cursor: ${e.path}`);
    setMemberCursor(scope,actor,value,ctx.db,Math.trunc(e.mtimeMs));
   }
  }else if(e.kind==="dm-member-cursor"){
   if(!e.memberId)throw new Error("DM cursor has no member ID");setDmMemberCursor(e.memberId,read(e) as any,ctx.db,Math.trunc(e.mtimeMs));
  }else if(e.kind!=="derived-event-stats"){
   const archiveTs=e.kind==="message-archive"?Number(e.archiveTimestamp):null;
   if(e.kind==="message-archive")recordMessageArchive(scope,archiveTs!,ctx.db);
   let batch:Array<{ordinal:number;value:unknown}>=[];let bytes=0;
   const flush=()=>{
    ctx.db.transaction(tx=>{for(const row of batch){
     if(e.kind==="messages")importMessage(tx,scope,row.value as Message);
     else if(e.kind==="message-archive")importArchivedMessage(tx,scope,archiveTs!,row.ordinal-1,row.value as Message);
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
  const sequenceByEventId=planProvenEvents(provenSources);
  ctx.db.transaction(tx=>{
   importPlannedEventRows(tx,provenSources,sequenceByEventId);
   rebuildEventAggregates(tx);
  });
  completed+=provenSources.reduce((n,s)=>n+s.rows.length,0);ctx.progress(completed);
 }
 return consumed;
}
