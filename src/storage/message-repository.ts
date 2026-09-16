import { randomUUID } from "node:crypto";
import { getDatabase, type Database } from "./database.js";
import type { RoomMessage } from "../kernel/types.js";
import { limitRuntimeFailureRoomMessage } from "../kernel/runtime-error-limit.js";
import type { SearchOptions, SearchResult } from "../workspace/message-store.js";

const lists = {
  mentions: ["mention", "label"], mentionMemberIds: ["mention", "id"],
  needResponse: ["response", "label"], needResponseMemberIds: ["response", "id"],
} as const;
type Row = { position: number; scope_id: string; id: string; seq: number | null; ts: number; sender: string; sender_member_id: string | null; content: string; type: RoomMessage["type"] | null; extra_json: string };
export type MessageInput = Omit<RoomMessage, "id" | "ts" | "seq">;
export type MessagePageOptions = { limit?: number; before?: string; around?: string; fromSeq?: number };

function hydrate(db: Database, row: Row): RoomMessage {
  const {fields:extra,presentLists:present} = JSON.parse(row.extra_json) as {fields:Record<string,unknown>;presentLists:string[]};
  const result: RoomMessage = { ...extra, id: row.id, ts: row.ts, sender: row.sender, content: row.content, mentions: [] };
  // Retired fields (`!name` urgent gesture, 2026-09-11) are never surfaced, even
  // for rows written before the retirement.
  delete (result as unknown as Record<string, unknown>).urgentMentions;
  delete (result as unknown as Record<string, unknown>).urgentMentionMemberIds;
  if (row.seq !== null) result.seq = row.seq;
  if (row.sender_member_id !== null) result.senderMemberId = row.sender_member_id;
  if (row.type !== null) result.type = row.type;
  const values = db.all<{ kind: string; value_kind: string; value: string }>("SELECT kind,value_kind,value FROM message_mentions WHERE scope_id=? AND message_id=? ORDER BY ordinal", row.scope_id,row.id);
  for (const key of present as (keyof typeof lists)[]) {
    if (!(key in lists)) continue; // retired list field — ignored on read
    const [kind, valueKind] = lists[key];
    result[key] = values.filter(v => v.kind === kind && v.value_kind === valueKind).map(v => v.value);
  }
  const reply = db.get<{ target_id: string; target_seq: number }>("SELECT target_id,target_seq FROM message_replies WHERE scope_id=? AND message_id=?",row.scope_id,row.id);
  if (reply) result.replyTo = { messageId: reply.target_id, seq: reply.target_seq };
  return result;
}
function validate(message: RoomMessage): void {
  if (typeof message.id !== "string" || !message.id || !Number.isFinite(message.ts) || typeof message.sender !== "string" || typeof message.content !== "string" || !Array.isArray(message.mentions)) throw new Error("Invalid historical message");
  if (message.senderMemberId !== undefined && typeof message.senderMemberId !== "string") throw new Error("Invalid sender member ID");
  if (message.replyTo && (typeof message.replyTo.messageId !== "string" || !Number.isSafeInteger(message.replyTo.seq))) throw new Error("Invalid reply identity");
  if (message.seq !== undefined && (!Number.isSafeInteger(message.seq) || message.seq < 1)) throw new Error("Invalid message sequence");
  for (const key of Object.keys(lists) as (keyof typeof lists)[]) if (message[key] !== undefined && (!Array.isArray(message[key]) || message[key]!.some(v => typeof v !== "string"))) throw new Error(`Invalid ${key}`);
}
function insert(db: Database, scopeId: string, message: RoomMessage): void {
  validate(message);
  const { id,seq,ts,sender,senderMemberId,content,type,replyTo,...extra } = message;
  const listFields = Object.keys(lists).filter(key => key in extra);
  for (const key of listFields) delete (extra as Record<string, unknown>)[key];
  // Retired fields are dropped on write (including historical imports).
  delete (extra as Record<string, unknown>).urgentMentions;
  delete (extra as Record<string, unknown>).urgentMentionMemberIds;
  db.run(`INSERT INTO messages(scope_id,id,seq,ts,sender,sender_member_id,origin,content,content_lower,type,extra_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,scopeId,id,seq ?? null,ts,sender,senderMemberId ?? null,senderMemberId ? "member" : sender === "user" ? "user" : sender === "system" ? "system" : "unresolved",content,content.toLowerCase(),type ?? null,JSON.stringify({fields:extra,presentLists:listFields}));
  for (const key of listFields as (keyof typeof lists)[]) {
    const [kind,valueKind] = lists[key];
    message[key]!.forEach((value, ordinal) => db.run("INSERT INTO message_mentions VALUES(?,?,?,?,?,?)",scopeId,id,kind,valueKind,ordinal,value));
  }
  if (replyTo) db.run("INSERT INTO message_replies VALUES(?,?,?,?)",scopeId,id,replyTo.messageId,replyTo.seq);
  if (seq !== undefined) db.run(`INSERT INTO scope_sequences VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET next_seq=MAX(next_seq,excluded.next_seq)`,scopeId,seq+1);
}

/** Pure synchronous DB operation: no filesystem, broadcast, scheduling, or identity lookup.
 * The caller may compose this in its task/business transaction. Always records dispatch intent.
 */
export function appendMessageInTransaction(db: Database, scopeId: string, input: MessageInput): RoomMessage {
  return db.transaction(tx => {
    const seq = tx.get<{ next_seq: number }>("SELECT next_seq FROM scope_sequences WHERE scope_id=?",scopeId)?.next_seq ?? 1;
    const message = { ...limitRuntimeFailureRoomMessage(input), id: `msg-${randomUUID().slice(0,8)}`, seq, ts: Date.now() };
    insert(tx,scopeId,message);
    tx.run("INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES('message',?,?,?,?)",scopeId,`message:${scopeId}:${message.id}`,JSON.stringify({messageId:message.id,message}),message.ts);
    return message;
  });
}
export function appendMessage(scopeId: string, input: MessageInput): RoomMessage { return appendMessageInTransaction(getDatabase(),scopeId,input); }

/** One-time retirement of obsolete boolean flags. They are not recipient lists:
 * never infer recipients or replay history. The upgrade backup retains source
 * bytes; no compatibility field is introduced into current message data.
 */
function normalizeHistoricalMessage(message: RoomMessage): RoomMessage {
  if (typeof (message as unknown as Record<string, unknown>).needResponse !== "boolean") return message;
  const { needResponse, ...rest } = message;
  return rest;
}

/** Strict import, no runtime limiting or name resolution, and no historical activation. */
export function importMessage(db: Database, scopeId: string, message: RoomMessage): void { db.transaction(tx => insert(tx,scopeId,normalizeHistoricalMessage(message))); }
export function importMessageNextSequence(db: Database, scopeId: string, nextSeq: number): void {
  if (!Number.isSafeInteger(nextSeq) || nextSeq < 1) throw new Error("Invalid next message sequence");
  db.run("INSERT INTO scope_sequences VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET next_seq=MAX(next_seq,excluded.next_seq)",scopeId,nextSeq);
}
export function readMessage(scopeId: string, id: string, db = getDatabase()): RoomMessage | null {
  const row = db.get<Row>("SELECT * FROM messages WHERE scope_id=? AND id=?",scopeId,id);
  return row ? hydrate(db,row) : null;
}
export function readMessages(scopeId: string, db = getDatabase()): RoomMessage[] {
  return db.all<Row>("SELECT * FROM messages WHERE scope_id=? ORDER BY position",scopeId).map(row => hydrate(db,row));
}
export function latestMessage(scopeId: string): RoomMessage | null {
  const db = getDatabase(); const row = db.get<Row>("SELECT * FROM messages WHERE scope_id=? ORDER BY position DESC LIMIT 1",scopeId);
  return row ? hydrate(db,row) : null;
}
export function messagesSince(scopeId: string, cursor: string | null): RoomMessage[] {
  const db = getDatabase(); const position = cursor ? db.get<Row>("SELECT position FROM messages WHERE scope_id=? AND id=?",scopeId,cursor)?.position : undefined;
  return db.all<Row>("SELECT * FROM messages WHERE scope_id=? AND position>? ORDER BY position",scopeId,position ?? 0).map(row => hydrate(db,row));
}
function around(db: Database, scopeId: string, position: number, limit: number): RoomMessage[] {
  const preceding = db.all<Row>("SELECT * FROM messages WHERE scope_id=? AND position<? ORDER BY position DESC LIMIT ?",scopeId,position,Math.floor((limit-1)/2)).reverse();
  const start = preceding[0]?.position ?? position;
  return db.all<Row>("SELECT * FROM messages WHERE scope_id=? AND position>=? ORDER BY position LIMIT ?",scopeId,start,limit).map(row => hydrate(db,row));
}
export function pageMessages(scopeId: string, opts: MessagePageOptions = {}): RoomMessage[] {
  const db = getDatabase();
  if (opts.around) {
    const target = db.get<Row>("SELECT position FROM messages WHERE scope_id=? AND id=?",scopeId,opts.around);
    return target ? around(db,scopeId,target.position,opts.limit || 30) : [];
  }
  const params: unknown[] = [scopeId]; let where = "scope_id=?";
  if (opts.before) {
    const target = db.get<Row>("SELECT position FROM messages WHERE scope_id=? AND id=?",scopeId,opts.before);
    // Preserve the legacy first/unknown-before behavior (the filter was only applied at index > 0).
    if (target && db.get("SELECT 1 FROM messages WHERE scope_id=? AND position<? LIMIT 1",scopeId,target.position)) { where += " AND position<?"; params.push(target.position); }
  }
  if (opts.fromSeq !== undefined) {
    const first = db.get<Row>(`SELECT position FROM messages WHERE ${where} AND seq>? ORDER BY position LIMIT 1`,...params,opts.fromSeq);
    if (!first) return [];
    where += " AND position>=?"; params.push(first.position);
  }
  return db.all<Row>(`SELECT * FROM messages WHERE ${where} ORDER BY position DESC LIMIT ?`,...params,opts.limit || 100).reverse().map(row => hydrate(db,row));
}
export function searchMessageFacts(scopeId: string, opts: SearchOptions = {}): SearchResult {
  const db = getDatabase();
  if (opts.aroundSeq !== undefined) {
    const row = db.get<Row>("SELECT position FROM messages WHERE scope_id=? AND seq=?",scopeId,opts.aroundSeq);
    return row ? { total:1, messages:around(db,scopeId,row.position,Math.max(1,Math.min(opts.limit ?? 30,500))) } : {total:0,messages:[]};
  }
  const params: unknown[] = [scopeId]; let where = "scope_id=?";
  if (opts.query) { where += " AND instr(content_lower,?)>0"; params.push(opts.query.toLowerCase()); }
  for (const [column,op,value] of [["sender","=",opts.from],["sender_member_id","=",opts.fromMemberId],["ts",">=",opts.after],["ts","<",opts.before],["type","=",opts.type]] as const) {
    if (value !== undefined && value !== "") { where += ` AND ${column}${op}?`; params.push(value); }
  }
  const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM messages WHERE ${where}`,...params)!.n;
  const rows = db.all<Row>(`SELECT * FROM messages WHERE ${where} ORDER BY ts DESC,position ASC LIMIT ? OFFSET ?`,...params,Math.max(1,Math.min(opts.limit ?? 50,500)),Math.max(0,opts.offset ?? 0));
  return {total,messages:rows.map(row => hydrate(db,row))};
}
export function replaceMessages(scopeId: string, messages: RoomMessage[]): void {
  getDatabase().transaction(db => { db.run("DELETE FROM messages WHERE scope_id=?",scopeId); for (const message of messages) insert(db,scopeId,message); });
}
export function patchMessage(scopeId: string,id: string,patch: Partial<RoomMessage>): RoomMessage | null {
  return getDatabase().transaction(db => {
    const old = readMessage(scopeId,id,db); if (!old) return null;
    const next = {...old,...patch,id:old.id,seq:old.seq,ts:old.ts};
    const pos = db.get<Row>("SELECT position FROM messages WHERE scope_id=? AND id=?",scopeId,id)!.position;
    db.run("DELETE FROM messages WHERE scope_id=? AND id=?",scopeId,id); insert(db,scopeId,next);
    db.run("UPDATE messages SET position=? WHERE scope_id=? AND id=?",pos,scopeId,id);
    return next;
  });
}
export function readMemberCursor(scopeId: string, actorId: string): string | null {
  return getDatabase().get<{ value: string | null }>("SELECT value FROM read_cursors WHERE scope_id=? AND kind='member' AND actor_key=?",scopeId,actorId)?.value ?? null;
}
export function writeMemberCursor(scopeId: string,actorId: string,value: string | null,db = getDatabase(),ts = Date.now()): void {
  db.run("INSERT INTO read_cursors VALUES(?,'member',?,?,?) ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",scopeId,actorId,value,ts);
}

export function readMemberCursors(scopeId: string): Record<string,string | null> {
  return Object.fromEntries(getDatabase().all<{actor_key:string;value:string | null}>("SELECT actor_key,value FROM read_cursors WHERE scope_id=? AND kind='member'",scopeId).map(row => [row.actor_key,row.value]));
}

/** Historical archive entries are immutable snapshots, not live-message copies.
 * Parent owns archive summaries/metadata and replaces archive-store's filesystem orchestration.
 */
export function importArchivedMessage(db: Database,scopeId: string,archiveTs: number,ordinal: number,message: RoomMessage): void {
  message = normalizeHistoricalMessage(message);
  validate(message);
  if (!Number.isFinite(archiveTs) || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("Invalid archive identity");
  db.run("INSERT INTO message_archive_entries VALUES(?,?,?,?,?,?,?,?,?,?)",scopeId,archiveTs,ordinal,message.id,message.seq ?? null,message.ts,message.sender,message.senderMemberId ?? null,message.content,JSON.stringify(message));
}
export function readArchivedMessages(scopeId: string,archiveTs: number,db = getDatabase()): RoomMessage[] {
  return db.all<{payload_json:string}>("SELECT payload_json FROM message_archive_entries WHERE scope_id=? AND archive_ts=? ORDER BY ordinal",scopeId,archiveTs).map(row => JSON.parse(row.payload_json));
}
export function listMessageArchiveTimestamps(scopeId: string): number[] {
  return getDatabase().all<{archive_ts:number}>("SELECT DISTINCT archive_ts FROM message_archive_entries WHERE scope_id=? ORDER BY archive_ts DESC",scopeId).map(row => row.archive_ts);
}
export function archiveMessagesInTransaction(db: Database,scopeId: string,keepCount = 50,timestamp = Date.now()): {archived:RoomMessage[];kept:RoomMessage[];timestamp:number} | null {
  if (!Number.isSafeInteger(keepCount) || keepCount < 0) throw new Error("Invalid archive keep count");
  return db.transaction(tx => {
    const all = readMessages(scopeId,tx);
    if (all.length <= keepCount) return null;
    const archived = all.slice(0,all.length-keepCount); const kept = all.slice(all.length-keepCount);
    archived.forEach((message,ordinal) => {
      importArchivedMessage(tx,scopeId,timestamp,ordinal,message);
      tx.run("DELETE FROM messages WHERE scope_id=? AND id=?",scopeId,message.id);
    });
    return {archived,kept,timestamp};
  });
}

export interface DmMemberCursor { messageId:string | null; seq:number | null }
/** DM's old public cursor has an independent numeric position (including dangling
 * historical IDs). Keep that ancillary field, not a guessed lookup of a message.
 * The message-ID cursor itself remains in the shared member read_cursors table.
 */
export function writeDmMemberCursor(db: Database,memberId: string,cursor: DmMemberCursor,updatedAt = Date.now()): void {
  if ((cursor.messageId !== null && typeof cursor.messageId !== "string") || (cursor.seq !== null && !Number.isSafeInteger(cursor.seq))) throw new Error("Invalid DM cursor");
  db.transaction(tx => {
    const scopeId = `dm:${memberId}`;
    writeMemberCursor(scopeId,memberId,cursor.messageId,tx,updatedAt);
    tx.run("INSERT INTO dm_member_cursor_sequences VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET seq=excluded.seq",scopeId,cursor.seq);
  });
}
export function readDmMemberCursor(memberId: string): DmMemberCursor {
  const scopeId = `dm:${memberId}`;
  return {messageId:readMemberCursor(scopeId,memberId),seq:getDatabase().get<{seq:number | null}>("SELECT seq FROM dm_member_cursor_sequences WHERE scope_id=?",scopeId)?.seq ?? null};
}
