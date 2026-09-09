import {createHash} from "node:crypto";
import type {Database} from "./database.js";
import type {UpgradeImportContext} from "./upgrade-runner.js";
import {readLegacyJson,readLegacyJsonl,type LegacySourceEntry} from "./legacy-inventory.js";
import {ConversationsRepository} from "./repositories/conversations.js";
import {MessageArchivesRepository,type ArchiveSummary} from "./repositories/message-archives.js";
import {TasksRepository} from "./repositories/tasks.js";
import {UserCursorRepository} from "./repositories/user-cursor-repository.js";
import {executionScopeId} from "./repositories/execution-identity.js";
import {importMessage,importMessageNextSequence,importArchivedMessage,writeMemberCursor,writeDmMemberCursor} from "./message-repository.js";
import {importAgentEvent,type EventPayload} from "./event-repository.js";
import type {Room,RoomMessage,Task} from "../shared/types.js";
import type {TopicRecord} from "../workspace/topic-store.js";

function object(value:unknown,path:string):Record<string,any>{
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Invalid legacy conversation object: ${path}`);
 return value as Record<string,any>;
}
/** Missing historical metadata does not justify inventing a current room or member. */
export function ensureImportedScope(db:Database,input:string,roomHint?:string):string{
 const id=executionScopeId(input);if(db.get("SELECT id FROM scopes WHERE id=?",id))return id;
 const kind=id.startsWith("dm:")?"dm":id.startsWith("topic:")?"topic":"room";
 db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES(?,?,?,?)",id,kind,kind==="room"?id:kind==="topic"?roomHint??null:null,kind==="dm"?id.slice(3):null);
 return id;
}
/** Full source order is retained, including non-activity events. Imports never emit outbox work. */
export async function importLegacyConversations(ctx:UpgradeImportContext,entries:readonly LegacySourceEntry[],options:{
 /** Caller supplies verified source-generation/identity evidence, not a current-name lookup. */
 eventOwner?:(entry:LegacySourceEntry)=>{ownerKey:string;memberId:string|null};
}={}):Promise<Set<string>>{
 ctx.db.assertOutsideTransaction();const consumed=new Set<string>();
 const check=(e:LegacySourceEntry)=>{if(!ctx.sourceFiles.includes(e.path))throw new Error(`Unsnapshotted conversation source: ${e.path}`);};
 const read=(e:LegacySourceEntry)=>{check(e);return readLegacyJson(ctx.sourceRoot,e);};
 const conversations=new ConversationsRepository(ctx.db);
 for(const e of entries.filter(e=>e.kind==="room-metadata")){
  const room=object(read(e),e.path) as Room;
  if(room.id!==e.scopeId)throw new Error(`Room source ownership mismatch: ${e.path}`);
  conversations.upsertRoom(room);consumed.add(e.path);
 }
 for(const e of entries.filter(e=>e.kind==="topic-metadata")){
  const topic=object(read(e),e.path) as TopicRecord;const room=e.path.split("/")[1];
  if(`topic:${topic.id}`!==e.scopeId||topic.roomId!==room)throw new Error(`Topic source ownership mismatch: ${e.path}`);
  conversations.upsertTopic(topic);consumed.add(e.path);
 }
 let completed=0;
 for(const e of entries){
  if(consumed.has(e.path))continue;
  if(e.kind==="user-cursors"){
   const cursors=object(read(e),e.path);const repo=new UserCursorRepository(ctx.db);
   for(const [key,cursor]of Object.entries(cursors)){ensureImportedScope(ctx.db,key);repo.importCursor(key,cursor);}
   consumed.add(e.path);continue;
  }
  if(!["tasks","messages","message-sequence","member-cursors","dm-member-cursor","agent-events","message-archive","message-archive-summary","derived-event-stats"].includes(e.kind))continue;
  check(e);if(!e.scopeId)throw new Error(`Conversation source has no scope: ${e.path}`);
  const scope=ensureImportedScope(ctx.db,e.scopeId,e.path.startsWith("rooms/")?e.path.split("/")[1]:undefined);
  if(e.kind==="message-archive-summary"){
   new MessageArchivesRepository(ctx.db).saveSummary(scope,Number(e.archiveTimestamp),object(read(e),e.path) as ArchiveSummary);
  }else if(e.kind==="tasks"){
   const tasks=read(e);if(!Array.isArray(tasks))throw new Error(`Invalid legacy task list: ${e.path}`);
   const ids=new Set<string>();for(const task of tasks){const row=object(task,e.path);if(typeof row.id!=="string"||ids.has(row.id))throw new Error(`Duplicate or missing task identity: ${e.path}`);ids.add(row.id);}
   // The legacy readTasks adapter took room ownership from its containing file,
   // overriding an absent/stale embedded roomId before presenting records.
   new TasksRepository(ctx.db).importTasks(scope,tasks.map(task=>({...task,roomId:scope})) as Task[]);
  }else if(e.kind==="message-sequence")importMessageNextSequence(ctx.db,scope,read(e) as number);
  else if(e.kind==="member-cursors"){
   const cursors=object(read(e),e.path);for(const [actor,value]of Object.entries(cursors)){
    if(value!==null&&typeof value!=="string")throw new Error(`Invalid legacy member cursor: ${e.path}`);
    writeMemberCursor(scope,actor,value,ctx.db,Math.trunc(e.mtimeMs));
   }
  }else if(e.kind==="dm-member-cursor"){
   if(!e.memberId)throw new Error("DM cursor has no member ID");writeDmMemberCursor(ctx.db,e.memberId,read(e) as any,Math.trunc(e.mtimeMs));
  }else if(e.kind!=="derived-event-stats"){
   const prefix=`legacy:${createHash("sha256").update(e.path).digest("hex")}`;
   // A filename, even one equal to a current member ID, is not identity evidence.
   // Unresolved labels must not collide with a current actor's event/statistics key.
   const identity=e.kind==="agent-events"?options.eventOwner?.(e):undefined;
   const owner=identity?.ownerKey??(e.ownerKey?`legacy-unresolved:${e.ownerKey}`:undefined);
   const memberId=identity?.memberId??null;
   if(memberId!==null&&!ctx.db.get("SELECT id FROM members WHERE id=?",memberId))throw new Error("Unknown imported event member ID");
   const archiveTs=e.kind==="message-archive"?Number(e.archiveTimestamp):null;
   if(e.kind==="message-archive")new MessageArchivesRepository(ctx.db).recordMessages(scope,archiveTs!);
   let batch:Array<{ordinal:number;value:unknown}>=[];let bytes=0;
   const flush=()=>{
    ctx.db.transaction(tx=>{for(const row of batch){
     if(e.kind==="messages")importMessage(tx,scope,row.value as RoomMessage);
     else if(e.kind==="message-archive")importArchivedMessage(tx,scope,archiveTs!,row.ordinal-1,row.value as RoomMessage);
     else{
      const event=object(row.value,e.path);if(!owner||typeof event.type!=="string"||!event.type)throw new Error(`Invalid legacy event: ${e.path}`);
      importAgentEvent(tx,{id:`${prefix}:${row.ordinal}`,scopeId:scope,ownerKey:owner,memberId,seq:row.ordinal,
       ts:typeof event.ts==="number"&&Number.isFinite(event.ts)?event.ts:Math.trunc(e.mtimeMs),event:event as EventPayload});
     }
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
 return consumed;
}
