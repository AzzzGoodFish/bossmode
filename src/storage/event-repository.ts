import { randomUUID } from "node:crypto";
import { getDatabase, type Database } from "./database.js";
import type { UsageDelta } from "../workspace/db/token-rollup.js";
import type { MemberStats } from "../workspace/member-stats-store.js";

export const ACTIVITY_TYPES = new Set(["agent_start","agent_end","message_end","tool_start","tool_end","compaction_start","compaction_end","user_prompt","user_steer","system"]);
export interface EventPayload { type: string; ts?: number; usage?: UsageDelta; model?: string }
export interface EventFact {
  id: string; scopeId: string; ownerKey: string; memberId: string | null;
  seq: number; ts: number; event: EventPayload;
}
interface EventRow { id: string; scope_id: string; owner_key: string; member_id: string | null; seq: number; ts: number; type: string; payload_json: string }
export interface EventOwner { ownerKey: string; memberId: string | null; label?: string }
const zeroStats = (): MemberStats => ({turns:0,toolCalls:0,activeMs:0,tokens:{input:0,output:0,cacheRead:0,cacheWrite:0},cost:0});

function updateStats(db: Database, fact: EventFact): void {
  const {scopeId,ownerKey,ts,event} = fact;
  db.run("INSERT INTO member_statistics(scope_id,owner_key) VALUES(?,?) ON CONFLICT DO NOTHING",scopeId,ownerKey);
  const u = event.type === "message_end" ? event.usage : undefined;
  const eventTs = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : null;
  db.run(`UPDATE member_statistics SET
    turns=turns+?,tool_calls=tool_calls+?,
    active_ms=active_ms+CASE WHEN ?='agent_end' AND open_start_ts IS NOT NULL AND ?>open_start_ts THEN ?-open_start_ts ELSE 0 END,
    open_start_ts=CASE WHEN ?='agent_start' THEN ? WHEN ?='agent_end' THEN NULL ELSE open_start_ts END,
    input_tokens=input_tokens+?,output_tokens=output_tokens+?,cache_read=cache_read+?,cache_write=cache_write+?,cost=cost+?,updated_at=?
    WHERE scope_id=? AND owner_key=?`,event.type === "agent_end" ? 1:0,event.type === "tool_start" ? 1:0,event.type,eventTs,eventTs,event.type,eventTs,event.type,u?.inputTokens || 0,u?.outputTokens || 0,u?.cacheRead || 0,u?.cacheWrite || 0,u?.cost || 0,ts,scopeId,ownerKey);
  if (event.type === "message_end" && event.usage) applyEventUsage(db,fact.id);
}
/** Only a stored event can contribute, and its receipt and delta are atomic. */
export function applyEventUsage(db: Database, eventId: string): void {
  db.transaction(tx => {
    if (tx.get("SELECT 1 FROM event_usage_receipts WHERE event_id=?",eventId)) return;
    const row = tx.get<EventRow>("SELECT * FROM agent_events WHERE id=?",eventId);
    if (!row) throw new Error(`Unknown usage event: ${eventId}`);
    const event = JSON.parse(row.payload_json) as EventPayload;
    if (event.type !== "message_end" || !event.usage) return;
    const u = event.usage;
    const total = [u.inputTokens,u.outputTokens,u.cacheRead,u.cacheWrite].reduce<number>((sum,n) => sum + (typeof n === "number" && Number.isFinite(n) && n>0 ? n : 0),0);
    tx.run("INSERT INTO event_usage_receipts VALUES(?,?)",eventId,total);
    tx.run(`INSERT INTO token_usage_daily(room_id,member_id,date,model,input_tokens,output_tokens,cache_read,cache_write,cost,turns) VALUES(?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(room_id,member_id,date,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
      cache_read=cache_read+excluded.cache_read,cache_write=cache_write+excluded.cache_write,cost=cost+excluded.cost,turns=turns+1`,row.scope_id,row.owner_key,new Date(row.ts).toISOString().slice(0,10),event.model?.trim() ? event.model : "unknown",u.inputTokens || 0,u.outputTokens || 0,u.cacheRead || 0,u.cacheWrite || 0,u.cost || 0);
  });
}
function insertEvent(db: Database, fact: EventFact, notify: boolean, label?: string): boolean {
  if (typeof fact.id !== "string" || !fact.id || typeof fact.ownerKey !== "string" || !fact.ownerKey || (fact.memberId !== null && typeof fact.memberId !== "string") || !Number.isSafeInteger(fact.seq) || fact.seq < 1 || !Number.isFinite(fact.ts) || !fact.event.type) throw new Error("Invalid event fact");
  const payload = JSON.stringify(fact.event);
  const previous = db.get<EventRow>("SELECT * FROM agent_events WHERE id=?",fact.id);
  if (previous) {
    if (previous.scope_id !== fact.scopeId || previous.owner_key !== fact.ownerKey || previous.member_id !== fact.memberId || previous.seq !== fact.seq || previous.ts !== fact.ts || previous.payload_json !== payload) throw new Error(`Conflicting event identity: ${fact.id}`);
    return false;
  }
  db.run("INSERT INTO agent_events VALUES(?,?,?,?,?,?,?,?)",fact.id,fact.scopeId,fact.ownerKey,fact.memberId,fact.seq,fact.ts,fact.event.type,payload);
  updateStats(db,fact);
  if (notify) db.run("INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES('agent-event',?,?,?,?)",fact.scopeId,`agent-event:${fact.id}`,JSON.stringify({eventId:fact.id,agentName:label ?? fact.ownerKey,memberId:fact.memberId}),fact.ts);
  return true;
}
/** Explicit import preserves payload bytes as JSON values, including unknown fields and absent timestamps.
 * Supply stable source-derived event IDs and original nonblank-line sequence; never resolve historical labels here.
 * Replay of an identical event ID is idempotent; conflicting identities fail closed.
 */
export function importAgentEvent(db: Database, fact: EventFact): boolean { return db.transaction(tx => insertEvent(tx,fact,false)); }
export function appendAgentEvent(scopeId: string,owner: EventOwner,event: EventPayload,eventId: string = randomUUID()): EventFact {
  return getDatabase().transaction(db => {
    const old = db.get<EventRow>("SELECT * FROM agent_events WHERE id=?",eventId);
    const seq = old?.seq ?? (db.get<{seq:number}>("SELECT MAX(seq) seq FROM agent_events WHERE scope_id=? AND owner_key=?",scopeId,owner.ownerKey)?.seq ?? 0)+1;
    const ts = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : old?.ts ?? Date.now();
    const fact = {id:eventId,scopeId,...owner,seq,ts,event:{...event,ts}};
    insertEvent(db,fact,true,owner.label);
    return fact;
  });
}
export function readAgentEvent(id: string,db = getDatabase()): EventFact | null {
  const row = db.get<EventRow>("SELECT * FROM agent_events WHERE id=?",id);
  return row ? {id:row.id,scopeId:row.scope_id,ownerKey:row.owner_key,memberId:row.member_id,seq:row.seq,ts:row.ts,event:JSON.parse(row.payload_json)} : null;
}
export function readAgentEvents<T = EventPayload>(scopeId: string,ownerKey: string): T[] {
  return getDatabase().all<EventRow>("SELECT payload_json FROM agent_events WHERE scope_id=? AND owner_key=? ORDER BY seq",scopeId,ownerKey).map(row => JSON.parse(row.payload_json));
}
export function pageAgentEvents<T = EventPayload>(scopeId: string,ownerKey: string,limit: number,before?: number): {events:T[];total:number;hasMore:boolean} {
  const db = getDatabase(); const total = db.get<{n:number}>("SELECT COUNT(*) n FROM agent_events WHERE scope_id=? AND owner_key=?",scopeId,ownerKey)!.n;
  const end = before !== undefined ? Math.max(0,Math.min(before,total)) : total; const start = Math.max(0,end-limit);
  const rows = db.all<EventRow>("SELECT payload_json FROM agent_events WHERE scope_id=? AND owner_key=? ORDER BY seq LIMIT ? OFFSET ?",scopeId,ownerKey,end-start,start);
  return {events:rows.map(row => JSON.parse(row.payload_json)),total,hasMore:start>0};
}
export function pageActivity(scopeId: string,ownerKey: string,opts: {beforeSeq?:number;limit?:number;types?:string[]} = {}): {events:unknown[];hasMore:boolean;nextBeforeSeq:number | null;indexed:boolean} {
  const db = getDatabase(); const limit = Math.max(1,Math.min(opts.limit ?? 50,500));
  const requested = (opts.types ?? []).filter(t => ACTIVITY_TYPES.has(t)); const types = requested.length ? requested : [...ACTIVITY_TYPES];
  const rows = db.all<EventRow>(`SELECT seq,payload_json FROM agent_events WHERE scope_id=? AND owner_key=? AND seq<? AND type IN (${types.map(() => "?").join(",")}) ORDER BY seq DESC LIMIT ?`,scopeId,ownerKey,opts.beforeSeq ?? Number.MAX_SAFE_INTEGER,...types,limit+1);
  const hasMore = rows.length > limit; const page = rows.slice(0,limit);
  return {events:page.map(row => JSON.parse(row.payload_json)).reverse(),hasMore,nextBeforeSeq:hasMore ? page.at(-1)!.seq : null,indexed:true};
}
export function readStats(scopeId: string,ownerKey: string): MemberStats {
  const row = getDatabase().get<{turns:number;tool_calls:number;active_ms:number;input_tokens:number;output_tokens:number;cache_read:number;cache_write:number;cost:number;updated_at:number | null}>("SELECT * FROM member_statistics WHERE scope_id=? AND owner_key=?",scopeId,ownerKey);
  return row ? {turns:row.turns,toolCalls:row.tool_calls,activeMs:row.active_ms,tokens:{input:row.input_tokens,output:row.output_tokens,cacheRead:row.cache_read,cacheWrite:row.cache_write},cost:row.cost,...(row.updated_at !== null ? {updatedAt:row.updated_at} : {})} : zeroStats();
}
export function hasStats(scopeId: string,ownerKey: string): boolean { return !!getDatabase().get("SELECT 1 FROM member_statistics WHERE scope_id=? AND owner_key=?",scopeId,ownerKey); }
/** Rebuild only disposable C aggregates from DB facts, never retired JSONL or unrelated tables. */
export function rebuildEventAggregates(db = getDatabase()): void {
  db.transaction(tx => {
    tx.exec("DELETE FROM member_statistics; DELETE FROM token_usage_daily; DELETE FROM event_usage_receipts");
    let last: EventRow | undefined;
    while (true) {
      const rows: EventRow[] = last
        ? tx.all<EventRow>("SELECT * FROM agent_events WHERE (scope_id,owner_key,seq)>(?,?,?) ORDER BY scope_id,owner_key,seq LIMIT 100",last.scope_id,last.owner_key,last.seq)
        : tx.all<EventRow>("SELECT * FROM agent_events ORDER BY scope_id,owner_key,seq LIMIT 100");
      if (!rows.length) break;
      for (const row of rows) updateStats(tx,{id:row.id,scopeId:row.scope_id,ownerKey:row.owner_key,memberId:row.member_id,seq:row.seq,ts:row.ts,event:JSON.parse(row.payload_json)});
      last = rows.at(-1);
    }
  });
}
/** Match the historical positive-finite token summary, but use proven member IDs only. */
export function memberTokenTotal(memberId: string,scopeId?: string): number {
  const params: unknown[] = [memberId]; let where = "e.member_id=?";
  if (scopeId !== undefined) { where += " AND e.scope_id=?"; params.push(scopeId); }
  return getDatabase().get<{total:number}>(`SELECT COALESCE(SUM(u.total_tokens),0) total FROM event_usage_receipts u JOIN agent_events e ON e.id=u.event_id WHERE ${where}`,...params)!.total;
}
