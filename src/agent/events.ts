// Member-owned runtime event facts, usage aggregation and source-aware delivery.
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../kernel/json.js";
import { getDatabase, type Database } from "../data/database.js";
import { claimOutbox, completeOutbox, enqueueOutbox } from "../data/outbox.js";
import { logger } from "../kernel/logger.js";
import type { AgentStreamEvent } from "./types.js";
import type { AgentStatus } from "../kernel/types.js";
import type { MemberStats } from "../data/types.js";
import { limitRuntimeErrorEvent } from "../kernel/runtime-error-limit.js";

export type AgentHistoryEvent = AgentStreamEvent
  | { type:"user_prompt";text:string;trigger:string;ts?:number }
  | { type:"user_steer";text:string;ts?:number }
  | { type:"agent_reply";text:string;ts?:number }
  | { type:"system";text:string;ts?:number };
export interface EventFact {
  id:string;memberId:string|null;sourceRef:string|null;memberSeq:number|null;
  historicalSourceKey:string|null;historicalOwnerKey:string|null;historicalSeq:number|null;
  ts:number;event:AgentHistoryEvent;
}
interface EventRow {
  id:string;member_id:string|null;source_ref:string|null;member_seq:number|null;
  historical_source_key:string|null;historical_owner_key:string|null;historical_seq:number|null;
  ts:number;type:string;payload_json:string;
}
const EVENT_SELECT=`SELECT id,member_id,source_ref,member_seq,historical_source_key,historical_owner_key,historical_seq,ts,type,payload_json FROM agent_events`;

export interface AgentEventBroadcast {type:"agent:event";roomId:string;memberId:string;event:unknown}
export type AgentEventSink=(sourceRef:string,memberId:string,payload:AgentEventBroadcast)=>void;
export interface ToolActivity {sourceRef:string;memberId:string;toolName:string;args:unknown;isError:boolean}
export type AgentToolActivityHook=(activity:ToolActivity)=>void;
export type AgentContextUsageRefresh=(sourceRef:string|null,memberId:string,options?:{acceptCompactedSnapshot:boolean;retries:number;retryDelayMs:number})=>void;
let eventSink:AgentEventSink|undefined,toolActivityHook:AgentToolActivityHook|undefined,usageRefreshHook:AgentContextUsageRefresh|undefined;
export function setAgentEventSink(sink:AgentEventSink|undefined):void{eventSink=sink;if(sink)scheduleAgentEventDispatch();}
export function setToolActivityHook(hook:AgentToolActivityHook|undefined):void{toolActivityHook=hook;}
export function setContextUsageRefreshHook(hook:AgentContextUsageRefresh|undefined):void{usageRefreshHook=hook;}

const eventIdentities=new WeakMap<object,string>();
function identityFor(event:object):string{let id=eventIdentities.get(event);if(!id){id=randomUUID();eventIdentities.set(event,id);}return id;}
function decode(row:EventRow):EventFact{return {id:row.id,memberId:row.member_id,sourceRef:row.source_ref,memberSeq:row.member_seq,historicalSourceKey:row.historical_source_key,historicalOwnerKey:row.historical_owner_key,historicalSeq:row.historical_seq,ts:row.ts,event:JSON.parse(row.payload_json)};}
function fingerprint(value:unknown):string{return createHash("sha256").update(canonicalJson(value as any,"Invalid event JSON")).digest("hex");}
function usageOf(event:AgentHistoryEvent):any{return event.type==="message_end"?(event as any).usage:undefined;}
function applyLiveAggregate(db:Database,fact:EventFact):void{
  if(!fact.memberId)return;
  const event=fact.event,eventTs=typeof (event as any).ts==="number"&&(Number.isFinite((event as any).ts))?(event as any).ts:null,u=usageOf(event);
  db.run("INSERT INTO member_statistics(member_id) VALUES(?) ON CONFLICT DO NOTHING",fact.memberId);
  db.run(`UPDATE member_statistics SET turns=turns+?,tool_calls=tool_calls+?,
    active_ms=active_ms+CASE WHEN ?='agent_end' AND open_start_ts IS NOT NULL AND ?>open_start_ts THEN ?-open_start_ts ELSE 0 END,
    open_start_ts=CASE WHEN ?='agent_start' THEN ? WHEN ?='agent_end' THEN NULL ELSE open_start_ts END,
    input_tokens=input_tokens+?,output_tokens=output_tokens+?,cache_read=cache_read+?,cache_write=cache_write+?,cost=cost+?,updated_at=? WHERE member_id=?`,
  event.type==="agent_end"?1:0,event.type==="tool_start"?1:0,event.type,eventTs,eventTs,event.type,eventTs,event.type,
  u?.inputTokens||0,u?.outputTokens||0,u?.cacheRead||0,u?.cacheWrite||0,u?.cost||0,fact.ts,fact.memberId);
  if(event.type==="message_end"&&u)applyEventUsage(db,fact);
}
function applyEventUsage(db:Database,fact:EventFact):void{
  if(db.get("SELECT 1 FROM event_usage_receipts WHERE event_id=?",fact.id))return;
  const u=usageOf(fact.event);if(!u)return;
  const total=[u.inputTokens,u.outputTokens,u.cacheRead,u.cacheWrite].reduce<number>((sum,n)=>sum+(typeof n==="number"&&Number.isFinite(n)&&n>0?n:0),0);
  db.run("INSERT INTO event_usage_receipts(event_id,total_tokens) VALUES(?,?)",fact.id,total);
  if(!fact.memberId)return;
  db.run(`INSERT INTO token_usage_daily(member_id,date,model,input_tokens,output_tokens,cache_read,cache_write,cost,turns) VALUES(?,?,?,?,?,?,?,?,1)
    ON CONFLICT(member_id,date,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
    output_tokens=output_tokens+excluded.output_tokens,cache_read=cache_read+excluded.cache_read,
    cache_write=cache_write+excluded.cache_write,cost=cost+excluded.cost,turns=turns+1`,fact.memberId,new Date(fact.ts).toISOString().slice(0,10),(fact.event as any).model?.trim()||(fact.event as any).model||"unknown",u.inputTokens||0,u.outputTokens||0,u.cacheRead||0,u.cacheWrite||0,u.cost||0);
}
function insertOutbox(db:Database,fact:EventFact):void{
  if(!fact.sourceRef||!fact.memberId)return;
  enqueueOutbox(db,{kind:"agent-event",scopeId:fact.sourceRef,dedupeKey:`agent-event:${fact.id}`,
    payload:{eventId:fact.id,memberId:fact.memberId},createdAt:fact.ts});
}

export function appendMemberEvent(input:{id?:string;memberId:string;sourceRef:string|null;event:AgentHistoryEvent}):{fact:EventFact;inserted:boolean}{
  if(!input.memberId)throw new Error("Live agent event requires memberId");
  const id=input.id??identityFor(input.event as object),sourceHash=fingerprint(input.event),db=getDatabase();
  return db.transaction(tx=>{
    const old=tx.get<EventRow>(`${EVENT_SELECT} WHERE id=?`,id);
    if(old){const fact=decode(old),receipt=tx.get<{input_fingerprint:string}>("SELECT input_fingerprint FROM event_source_receipts WHERE event_id=?",id);
      if(fact.memberId!==input.memberId||fact.sourceRef!==input.sourceRef||receipt?.input_fingerprint!==sourceHash)throw new Error(`Conflicting event identity: ${id}`);
      return {fact,inserted:false};}
    const ts=typeof (input.event as any).ts==="number"&&Number.isFinite((input.event as any).ts)?(input.event as any).ts:Date.now();
    const event={...input.event,ts} as AgentHistoryEvent;
    const memberSeq=(tx.get<{seq:number}>("SELECT COALESCE(MAX(member_seq),0) seq FROM agent_events WHERE member_id=?",input.memberId)?.seq??0)+1;
    tx.run(`INSERT INTO agent_events(id,member_id,source_ref,member_seq,historical_source_key,historical_owner_key,historical_seq,ts,type,payload_json)
      VALUES(?,?,?,?,NULL,NULL,NULL,?,?,?)`,id,input.memberId,input.sourceRef,memberSeq,ts,event.type,canonicalJson(event as any,"Invalid event JSON"));
    tx.run("INSERT INTO event_source_receipts(event_id,input_fingerprint) VALUES(?,?)",id,sourceHash);
    const fact=decode(tx.get<EventRow>(`${EVENT_SELECT} WHERE id=?`,id)!);applyLiveAggregate(tx,fact);insertOutbox(tx,fact);
    tx.afterCommit(scheduleAgentEventDispatch);return {fact,inserted:true};
  });
}

export function importHistoricalEvent(db:Database,input:{id:string;sourceKey:string;ownerKey:string;sourceSeq:number;memberId?:string;sourceRef?:string;event:AgentHistoryEvent;ts:number}):boolean{
  if(!input.id||!input.sourceKey||!input.ownerKey||!Number.isSafeInteger(input.sourceSeq)||input.sourceSeq<1||!Number.isFinite(input.ts))throw new Error("Invalid historical event");
  return db.transaction(tx=>{
    const payload=canonicalJson(input.event as any,"Invalid historical event JSON"),old=tx.get<EventRow>(`${EVENT_SELECT} WHERE id=?`,input.id);
    if(old){const fact=decode(old);if(fact.historicalSourceKey!==input.sourceKey||fact.historicalOwnerKey!==input.ownerKey||fact.historicalSeq!==input.sourceSeq||old.payload_json!==payload)throw new Error(`Conflicting event identity: ${input.id}`);return false;}
    const memberSeq=input.memberId?(tx.get<{seq:number}>("SELECT COALESCE(MAX(member_seq),0) seq FROM agent_events WHERE member_id=?",input.memberId)?.seq??0)+1:null;
    tx.run(`INSERT INTO agent_events(id,member_id,source_ref,member_seq,historical_source_key,historical_owner_key,historical_seq,ts,type,payload_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,input.id,input.memberId??null,input.sourceRef??null,memberSeq,input.sourceKey,input.ownerKey,input.sourceSeq,input.ts,input.event.type,payload);
    return true;
  });
}
export function hasAgentEvent(id:string):boolean{return !!getDatabase().get("SELECT 1 FROM agent_events WHERE id=?",id);}
export function readAgentEvent(id:string,db:Database=getDatabase()):EventFact|null{const row=db.get<EventRow>(`${EVENT_SELECT} WHERE id=?`,id);return row?decode(row):null;}
export function loadEventsFromDisk(sourceRef:string,memberId:string):AgentHistoryEvent[]{return getDatabase().all<EventRow>(`${EVENT_SELECT} WHERE member_id=? AND source_ref=? ORDER BY CASE WHEN historical_seq IS NULL THEN 1 ELSE 0 END,historical_source_key,historical_owner_key,historical_seq,member_seq`,memberId,sourceRef).map(row=>limitRuntimeErrorEvent(JSON.parse(row.payload_json)));}
export function loadEventsPaginated(sourceRef:string,memberId:string,limit:number,before?:number):{events:AgentHistoryEvent[];total:number;hasMore:boolean}{
  const all=loadEventsFromDisk(sourceRef,memberId),end=before===undefined?all.length:Math.max(0,Math.min(before,all.length)),start=Math.max(0,end-limit);return {events:all.slice(start,end),total:all.length,hasMore:start>0};
}
export function resetEventSeqCache():void{}

let dispatchScheduled=false;
export function scheduleAgentEventDispatch():void{if(dispatchScheduled||!eventSink)return;dispatchScheduled=true;queueMicrotask(()=>{dispatchScheduled=false;try{
  const db=getDatabase(),rows=claimOutbox<{eventId:string;memberId:string}>("agent-event",500,db);
  for(const row of rows){if(!row.scopeId)throw new Error(`Agent event outbox has no source: ${row.id}`);const fact=readAgentEvent(row.payload.eventId,db);if(!fact)throw new Error(`Missing agent event: ${row.payload.eventId}`);eventSink?.(row.scopeId,row.payload.memberId,{type:"agent:event",roomId:row.scopeId,memberId:row.payload.memberId,event:fact.event});completeOutbox(row.id,Date.now(),db);}
  if(rows.length===500)scheduleAgentEventDispatch();
}catch(error){logger.error("event","durable event dispatch pending",{error:String(error)});}});}

// Streaming state: transient deltas are source-routed; final facts are member-owned.
const toolArgs=new Map<string,unknown>();
interface StreamBoundary{eventId:string;textEnd:number;thinkingEnd:number}
interface StreamState{text:string;thinking:string;textOffset:number;thinkingOffset:number;pending:StreamBoundary[]}
const streams=new Map<string,StreamState>();
function boundary(id:string,state:StreamState):StreamBoundary{return {eventId:id,textEnd:state.textOffset+state.text.length,thinkingEnd:state.thinkingOffset+state.thinking.length};}
function content(state:StreamState){const pending=state.pending.filter(item=>hasAgentEvent(item.eventId));state.pending=pending;const textStart=Math.max(state.textOffset,...pending.map(item=>item.textEnd)),thinkingStart=Math.max(state.thinkingOffset,...pending.map(item=>item.thinkingEnd));return {text:state.text.slice(textStart-state.textOffset),thinking:state.thinking.slice(thinkingStart-state.thinkingOffset)};}
function consume(key:string,id:string,state?:StreamState):void{if(!state)return;state.pending=state.pending.filter(item=>item.eventId!==id);const current=streams.get(key);if(current!==state)return;const end=boundary(id,state);if(end.textEnd===state.textOffset+state.text.length&&end.thinkingEnd===state.thinkingOffset+state.thinking.length)streams.delete(key);else{state.text=state.text.slice(end.textEnd-state.textOffset);state.thinking=state.thinking.slice(end.thinkingEnd-state.thinkingOffset);state.textOffset=end.textEnd;state.thinkingOffset=end.thinkingEnd;}}

export function handleAgentEvent(sourceRef:string|null,agentName:string,instanceKey:string,event:AgentStreamEvent,eventBuffer:AgentHistoryEvent[],memberId:string,model?:string,eventId=identityFor(event)):AgentStatus|undefined{
  const source=event,eventForLog=limitRuntimeErrorEvent(event);
  if(event.type==="message_update"){
    const state=streams.get(instanceKey)??{text:"",thinking:"",textOffset:0,thinkingOffset:0,pending:[]};if("text" in event&&event.text)state.text+=event.text;if("thinking" in event&&event.thinking)state.thinking+=event.thinking;streams.set(instanceKey,state);
  }
  if(event.type==="message_update"||event.type==="tool_update"||event.type==="cli:stdout"||event.type==="cli:stderr"){
    if(sourceRef)eventSink?.(sourceRef,memberId,{type:"agent:event",roomId:sourceRef,memberId,event:{...eventForLog,ts:(eventForLog as any).ts??Date.now()}});
    return;
  }
  const state=event.type==="message_end"||event.type==="message_start"?streams.get(instanceKey):undefined;
  const enriched:any={...eventForLog};if(event.type==="message_end"){if(state){const streamed=content(state);if(!(event as any).text&&streamed.text)enriched.text=streamed.text;if(streamed.thinking)enriched.thinking=streamed.thinking;}if(model?.trim()&&!enriched.model)enriched.model=model;}
  const {fact,inserted}=appendMemberEvent({id:eventId,memberId,sourceRef,event:enriched});
  if(inserted){if(state)state.pending.push(boundary(eventId,state));getDatabase().afterCommit(()=>{consume(instanceKey,eventId,state);eventBuffer.push(fact.event);});
    getDatabase().afterCommit(()=>{
      if(fact.event.type==="tool_start")toolArgs.set(`${instanceKey}:${(fact.event as any).toolCallId}`,(fact.event as any).args);
      else if(fact.event.type==="tool_end"){const key=`${instanceKey}:${(fact.event as any).toolCallId}`,args=toolArgs.get(key);toolArgs.delete(key);if(sourceRef)toolActivityHook?.({sourceRef,memberId,toolName:(fact.event as any).toolName,args,isError:!!(fact.event as any).isError});}
      if(fact.event.type==="message_end"||(fact.event.type==="agent_end"&&!(fact.event as any).willRetry))usageRefreshHook?.(sourceRef,memberId);else if(fact.event.type==="compaction_end")usageRefreshHook?.(sourceRef,memberId,{acceptCompactedSnapshot:true,retries:3,retryDelayMs:500});
    });
  }
  if(fact.event.type==="runtime_exit")return (fact.event as any).unexpected?"inactive":undefined;
  if(fact.event.type==="agent_start")return "working";
  if(fact.event.type==="agent_end")return (fact.event as any).willRetry?undefined:"idle";
  return;
}

export function rebuildEventAggregates(db:Database=getDatabase()):void{
  db.transaction(tx=>{
    tx.exec("DELETE FROM member_statistics; DELETE FROM token_usage_daily; DELETE FROM event_usage_receipts");
    const stats=new Map<string,{turns:number;tools:number;active:number;starts:Map<string,number>;input:number;output:number;read:number;write:number;cost:number;updated:number}>();
    for(const row of tx.all<EventRow>(`${EVENT_SELECT} ORDER BY member_id,CASE WHEN historical_seq IS NULL THEN 1 ELSE 0 END,historical_source_key,historical_owner_key,historical_seq,member_seq,id`)){
      const fact=decode(row),event=fact.event,u=usageOf(event),stream=fact.historicalSourceKey&&fact.historicalOwnerKey?`${fact.historicalSourceKey}\0${fact.historicalOwnerKey}`:`member:${fact.memberId}`;
      if(u)applyEventUsage(tx,fact);if(!fact.memberId)continue;
      const s=stats.get(fact.memberId)??{turns:0,tools:0,active:0,starts:new Map(),input:0,output:0,read:0,write:0,cost:0,updated:0};
      const eventTs=typeof (event as any).ts==="number"&&Number.isFinite((event as any).ts)?(event as any).ts:undefined;
      if(event.type==="agent_start"&&eventTs!==undefined)s.starts.set(stream,eventTs);
      if(event.type==="agent_end"){s.turns++;const start=s.starts.get(stream);if(start!==undefined&&eventTs!==undefined&&eventTs>start)s.active+=eventTs-start;s.starts.delete(stream);}
      if(event.type==="tool_start")s.tools++;if(u){s.input+=u.inputTokens||0;s.output+=u.outputTokens||0;s.read+=u.cacheRead||0;s.write+=u.cacheWrite||0;s.cost+=u.cost||0;}s.updated=Math.max(s.updated,fact.ts);stats.set(fact.memberId,s);
    }
    for(const [memberId,s] of stats)tx.run(`INSERT INTO member_statistics(member_id,turns,tool_calls,active_ms,input_tokens,output_tokens,cache_read,cache_write,cost,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,memberId,s.turns,s.tools,s.active,s.input,s.output,s.read,s.write,s.cost,s.updated);
    tx.run("DELETE FROM storage_meta WHERE key='event_aggregates_rebuild_required'");
  });
}

export interface UsageRow {
  memberId:string|null;historicalOwnerKey:string|null;sourceRef:string|null;historicalSourceKey:string|null;
  date:string;model:string;inputTokens:number;outputTokens:number;cacheRead:number;cacheWrite:number;cost:number;turns:number;
}
export function readUsageRows(options:{from?:string;to?:string;sourceRef?:string}={}):UsageRow[]{
  const clauses:string[]=[];const parameters:unknown[]=[];
  if(options.from){clauses.push("date(e.ts/1000,'unixepoch')>=?");parameters.push(options.from);}
  if(options.to){clauses.push("date(e.ts/1000,'unixepoch')<=?");parameters.push(options.to);}
  if(options.sourceRef){clauses.push("e.source_ref=?");parameters.push(options.sourceRef);}
  const where=clauses.length?` AND ${clauses.join(" AND ")}`:"";
  return getDatabase().all<any>(`SELECT e.member_id AS memberId,e.historical_owner_key AS historicalOwnerKey,
    e.source_ref AS sourceRef,e.historical_source_key AS historicalSourceKey,date(e.ts/1000,'unixepoch') AS date,
    COALESCE(NULLIF(trim(json_extract(e.payload_json,'$.model')),''),'unknown') AS model,
    CAST(SUM(COALESCE(json_extract(e.payload_json,'$.usage.inputTokens'),0)) AS INTEGER) AS inputTokens,
    CAST(SUM(COALESCE(json_extract(e.payload_json,'$.usage.outputTokens'),0)) AS INTEGER) AS outputTokens,
    CAST(SUM(COALESCE(json_extract(e.payload_json,'$.usage.cacheRead'),0)) AS INTEGER) AS cacheRead,
    CAST(SUM(COALESCE(json_extract(e.payload_json,'$.usage.cacheWrite'),0)) AS INTEGER) AS cacheWrite,
    SUM(COALESCE(json_extract(e.payload_json,'$.usage.cost'),0)) AS cost,COUNT(*) AS turns
    FROM agent_events e JOIN event_usage_receipts r ON r.event_id=e.id WHERE e.type='message_end'${where}
    GROUP BY e.member_id,e.historical_owner_key,e.source_ref,e.historical_source_key,date,model
    ORDER BY date,model,e.member_id,e.historical_source_key`,...parameters);
}
export function readStats(memberId:string):MemberStats{const row=getDatabase().get<any>("SELECT * FROM member_statistics WHERE member_id=?",memberId);return row?{turns:row.turns,toolCalls:row.tool_calls,activeMs:row.active_ms,tokens:{input:row.input_tokens,output:row.output_tokens,cacheRead:row.cache_read,cacheWrite:row.cache_write},cost:row.cost,...(row.updated_at===null?{}:{updatedAt:row.updated_at})}:{turns:0,toolCalls:0,activeMs:0,tokens:{input:0,output:0,cacheRead:0,cacheWrite:0},cost:0};}
export function hasStats(memberId:string):boolean{return !!getDatabase().get("SELECT 1 FROM member_statistics WHERE member_id=?",memberId);}
export function memberTokenTotal(memberId:string,sourceRef?:string):number{const source=sourceRef===undefined?"":" AND e.source_ref=?";return getDatabase().get<{total:number}>(`SELECT COALESCE(SUM(u.total_tokens),0) total FROM event_usage_receipts u JOIN agent_events e ON e.id=u.event_id WHERE e.member_id=?${source}`,memberId,...(sourceRef===undefined?[]:[sourceRef]))!.total;}
export function pageActivity(memberId:string,options:{sourceRef?:string;beforeSeq?:number;limit?:number;types?:string[]}={}):{events:unknown[];hasMore:boolean;nextBeforeSeq:number|null;indexed:boolean}{const limit=Math.max(1,Math.min(options.limit??50,500)),types=options.types?.length?options.types:["agent_start","agent_end","message_end","tool_start","tool_end","compaction_start","compaction_end","user_prompt","user_steer","system"],source=options.sourceRef?" AND source_ref=?":"";const rows=getDatabase().all<{member_seq:number;payload_json:string}>(`SELECT member_seq,payload_json FROM agent_events WHERE member_id=?${source} AND member_seq<? AND type IN (${types.map(()=>"?").join(",")}) ORDER BY member_seq DESC LIMIT ?`,memberId,...(options.sourceRef?[options.sourceRef]:[]),options.beforeSeq??Number.MAX_SAFE_INTEGER,...types,limit+1),hasMore=rows.length>limit,page=rows.slice(0,limit);return {events:page.map(row=>JSON.parse(row.payload_json)).reverse(),hasMore,nextBeforeSeq:hasMore?page.at(-1)!.member_seq:null,indexed:true};}
