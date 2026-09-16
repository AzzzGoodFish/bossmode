import type {Database} from "../database.js";
import {readMessages,importArchivedMessage} from "./message-repository.js";
import {executionScopeId} from "./execution-identity.js";
import type {RoomMessage} from "../../kernel/types.js";
export interface ArchiveSummary{summary:string;archivedCount:number;range:[string,string];ts:number}
export class MessageArchivesRepository{
 constructor(private readonly db:Database){}
 recordMessages(scope:string,timestamp:number):void{
  if(!Number.isSafeInteger(timestamp)||timestamp<0)throw new Error("Invalid archive timestamp");
  this.db.run("INSERT INTO message_archives(scope_id,archive_ts,has_messages) VALUES(?,?,1) ON CONFLICT(scope_id,archive_ts) DO UPDATE SET has_messages=1",executionScopeId(scope),timestamp);
 }
 saveSummary(scope:string,timestamp:number,value:ArchiveSummary):void{
  if(!Number.isSafeInteger(timestamp)||timestamp<0||typeof value?.summary!=="string"||!Number.isSafeInteger(value.archivedCount)||value.archivedCount<0||!Array.isArray(value.range)||value.range.length!==2||value.range.some(v=>typeof v!=="string")||!Number.isFinite(value.ts))throw new Error("Invalid archive summary");
  this.db.run("INSERT INTO message_archives(scope_id,archive_ts,summary_json) VALUES(?,?,?) ON CONFLICT(scope_id,archive_ts) DO UPDATE SET summary_json=excluded.summary_json",executionScopeId(scope),timestamp,JSON.stringify(value));
 }
 summary(scope:string,timestamp:number):ArchiveSummary|null{
  const row=this.db.get<{summary_json:string|null}>("SELECT summary_json FROM message_archives WHERE scope_id=? AND archive_ts=?",executionScopeId(scope),timestamp);
  return row?.summary_json?JSON.parse(row.summary_json):null;
 }
 list(scope:string):Array<{timestamp:number;hasMessages:boolean;hasSummary:boolean}>{
  return this.db.all<{archive_ts:number;has_messages:number;summary_json:string|null}>("SELECT * FROM message_archives WHERE scope_id=? ORDER BY archive_ts DESC",executionScopeId(scope)).map(r=>({timestamp:r.archive_ts,hasMessages:!!r.has_messages,hasSummary:r.summary_json!==null}));
 }
 archive(scopeValue:string,keepCount=50):{archived:RoomMessage[];kept:RoomMessage[];timestamp:number}|null{
  if(!Number.isSafeInteger(keepCount)||keepCount<0)throw new Error("Invalid archive keep count");
  const scope=executionScopeId(scopeValue);
  return this.db.transaction(tx=>{
   const messages=readMessages(scope,tx);if(messages.length<=keepCount)return null;
   const split=messages.length-keepCount;const archived=messages.slice(0,split);const kept=messages.slice(split);
   const maximum=tx.get<{ts:number|null}>("SELECT MAX(archive_ts) ts FROM message_archives WHERE scope_id=?",scope)?.ts??-1;
   const timestamp=Math.max(Date.now(),maximum+1);new MessageArchivesRepository(tx).recordMessages(scope,timestamp);
   archived.forEach((message,i)=>{importArchivedMessage(tx,scope,timestamp,i,message);tx.run("DELETE FROM messages WHERE scope_id=? AND id=?",scope,message.id);});
   return {archived,kept,timestamp};
  });
 }
}
