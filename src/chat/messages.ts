import { randomUUID } from "node:crypto";
import { getDatabase, type Database } from "../data/database.js";
import { claimOutbox, completeOutbox, enqueueOutbox } from "../data/outbox.js";
import { logger } from "../kernel/logger.js";
import type { JsonValue } from "../kernel/json.js";
import type { RoomMessageAttachment } from "../files/attachments.js";
import { parseConversation, storageScopeId } from "./conversations.js";

export interface Message {
  id: string;
  seq?: number;
  sender: string;
  senderMemberId?: string;
  content: string;
  mentions: string[];
  mentionMemberIds?: string[];
  ts: number;
  type?: "task_event" | "knowledge_event" | "topic_event";
  task_event_meta?: Record<string, unknown>;
  knowledge_event_meta?: Record<string, unknown>;
  topic_event_meta?: Record<string, unknown>;
  artifacts?: string[];
  attachments?: RoomMessageAttachment[];
  needResponse?: string[];
  needResponseMemberIds?: string[];
  replyTo?: { seq: number; messageId: string };
  member_chat_meta?: { scopeId: string; fromMemberId: string; toMemberId: string };
}

export type MessageInput = Omit<Message, "id" | "ts" | "seq">;
export interface MessagePageOptions { limit?: number; before?: string; around?: string; fromSeq?: number }
export interface MessageSearchOptions {
  query?: string;
  from?: string;
  fromMemberId?: string;
  after?: number;
  before?: number;
  offset?: number;
  limit?: number;
}
export interface MessageSearchResult { total: number; messages: Message[] }

type MessageListField = "mentions" | "mentionMemberIds" | "needResponse" | "needResponseMemberIds";
const LISTS: Record<MessageListField, readonly ["mention" | "response", "label" | "id"]> = {
  mentions: ["mention", "label"],
  mentionMemberIds: ["mention", "id"],
  needResponse: ["response", "label"],
  needResponseMemberIds: ["response", "id"],
};

interface MessageRow {
  position: number;
  scope_id: string;
  id: string;
  seq: number | null;
  ts: number;
  sender: string;
  sender_member_id: string | null;
  content: string;
  type: Message["type"] | null;
  extra_json: string;
}

const RUNTIME_FAILURE_LIMIT = 300;
const RUNTIME_FAILURE_PATTERNS = [
  /^Member "[^"]+" request failed\./,
  /^Member "[^"]+" error:/,
  /^Member "[^"]+" runtime ended unexpectedly/,
  /^Member "[^"]+" model credential is no longer available\./,
  /^Failed to create member "[^"]+":/,
  /^Failed to activate member "[^"]+":/,
  /^Failed to switch model for "[^"]+":/,
  /^Failed to switch thinking level for "[^"]+":/,
  /^Failed to refresh model credential for "[^"]+":/,
];
function visibleMessage<T extends { sender: string; content: string }>(message: T): T {
  if (message.sender !== "system" || !RUNTIME_FAILURE_PATTERNS.some((pattern) => pattern.test(message.content))) return message;
  const characters = Array.from(message.content);
  return characters.length <= RUNTIME_FAILURE_LIMIT ? message : {
    ...message,
    content: `${characters.slice(0, RUNTIME_FAILURE_LIMIT - 1).join("")}…`,
  };
}
export function isSystemNoticeHiddenFromMembers(message: Pick<Message, "sender" | "type">): boolean {
  return message.sender === "system" && message.type !== "task_event" && message.type !== "knowledge_event";
}

function hydrate(db: Database, row: MessageRow): Message {
  const stored = JSON.parse(row.extra_json) as { fields: Record<string, unknown>; presentLists: string[] };
  const result: Message = { ...stored.fields, id: row.id, ts: row.ts, sender: row.sender, content: row.content, mentions: [] };
  delete (result as unknown as Record<string, unknown>).urgentMentions;
  delete (result as unknown as Record<string, unknown>).urgentMentionMemberIds;
  if (row.seq !== null) result.seq = row.seq;
  if (row.sender_member_id !== null) result.senderMemberId = row.sender_member_id;
  if (row.type !== null) result.type = row.type;
  const values = db.all<{ kind: string; value_kind: string; value: string }>(
    "SELECT kind,value_kind,value FROM message_mentions WHERE scope_id=? AND message_id=? ORDER BY ordinal",
    row.scope_id, row.id,
  );
  for (const key of stored.presentLists as MessageListField[]) {
    if (!(key in LISTS)) continue;
    const [kind, valueKind] = LISTS[key];
    result[key] = values.filter((value) => value.kind === kind && value.value_kind === valueKind).map((value) => value.value);
  }
  const reply = db.get<{ target_id: string; target_seq: number }>(
    "SELECT target_id,target_seq FROM message_replies WHERE scope_id=? AND message_id=?",
    row.scope_id, row.id,
  );
  if (reply) result.replyTo = { messageId: reply.target_id, seq: reply.target_seq };
  return visibleMessage(result);
}

export function validateMessage(message: Message): void {
  if (typeof message.id !== "string" || !message.id || !Number.isFinite(message.ts) ||
    typeof message.sender !== "string" || typeof message.content !== "string" || !Array.isArray(message.mentions)) {
    throw new Error("Invalid historical message");
  }
  if (message.senderMemberId !== undefined && typeof message.senderMemberId !== "string") throw new Error("Invalid sender member ID");
  if (message.replyTo && (typeof message.replyTo.messageId !== "string" || !Number.isSafeInteger(message.replyTo.seq))) throw new Error("Invalid reply identity");
  if (message.seq !== undefined && (!Number.isSafeInteger(message.seq) || message.seq < 1)) throw new Error("Invalid message sequence");
  for (const key of Object.keys(LISTS) as MessageListField[]) {
    const values = message[key];
    if (values !== undefined && (!Array.isArray(values) || values.some((value) => typeof value !== "string"))) throw new Error(`Invalid ${key}`);
  }
}

function insert(db: Database, scopeId: string, message: Message): void {
  validateMessage(message);
  const { id, seq, ts, sender, senderMemberId, content, type, replyTo, ...extra } = message;
  const listFields = (Object.keys(LISTS) as MessageListField[]).filter((key) => key in extra);
  for (const key of listFields) delete (extra as Record<string, unknown>)[key];
  delete (extra as Record<string, unknown>).urgentMentions;
  delete (extra as Record<string, unknown>).urgentMentionMemberIds;
  db.run(
    `INSERT INTO messages(scope_id,id,seq,ts,sender,sender_member_id,origin,content,content_lower,type,extra_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    scopeId, id, seq ?? null, ts, sender, senderMemberId ?? null,
    senderMemberId ? "member" : sender === "user" ? "user" : sender === "system" ? "system" : "unresolved",
    content, content.toLowerCase(), type ?? null, JSON.stringify({ fields: extra, presentLists: listFields }),
  );
  for (const key of listFields) {
    const [kind, valueKind] = LISTS[key];
    message[key]!.forEach((value, ordinal) => db.run(
      "INSERT INTO message_mentions VALUES(?,?,?,?,?,?)",
      scopeId, id, kind, valueKind, ordinal, value,
    ));
  }
  if (replyTo) db.run("INSERT INTO message_replies VALUES(?,?,?,?)", scopeId, id, replyTo.messageId, replyTo.seq);
  if (seq !== undefined) db.run(
    "INSERT INTO scope_sequences VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET next_seq=MAX(next_seq,excluded.next_seq)",
    scopeId, seq + 1,
  );
}

/** SQL-only append for composition with delivery and agent admission. It always
 * records the committed message snapshot in the generic outbox. */
export function appendMessageInTransaction(db: Database, scope: string, input: MessageInput): Message {
  const scopeId = storageScopeId(scope);
  return db.transaction((tx) => {
    const seq = tx.get<{ next_seq: number }>("SELECT next_seq FROM scope_sequences WHERE scope_id=?", scopeId)?.next_seq ?? 1;
    const message: Message = {
      ...visibleMessage(input),
      id: `msg-${randomUUID().slice(0, 8)}`,
      seq,
      ts: Date.now(),
    };
    insert(tx, scopeId, message);
    const payload = JSON.parse(JSON.stringify({ messageId: message.id, message })) as JsonValue;
    enqueueOutbox(tx, {
      kind: "message",
      scopeId: parseConversation(scope)!.scopeId,
      dedupeKey: `message:${scopeId}:${message.id}`,
      payload,
      createdAt: message.ts,
    });
    return message;
  });
}

export type MessageSink = (sourceRef: string, message: Message) => void;
let messageSink: MessageSink | undefined;
let dispatchScheduled = false;

/** Connect the transport after startup. Delivery is post-commit and durable;
 * failures remain pending for the next startup/timer rather than hot-looping. */
export function setMessageSink(sink: MessageSink | undefined): void {
  messageSink = sink;
  if (sink) scheduleMessageDispatch();
}
export function scheduleMessageDispatch(): void {
  if (dispatchScheduled || !messageSink) return;
  dispatchScheduled = true;
  queueMicrotask(() => {
    dispatchScheduled = false;
    try {
      const rows = claimOutbox("message");
      for (const row of rows) {
        if (!row.scopeId) throw new Error(`Message outbox has no source: ${row.id}`);
        const payload = row.payload as unknown as { messageId: string; message: Message };
        messageSink?.(row.scopeId, payload.message);
        completeOutbox(row.id);
      }
      if (rows.length === 500) scheduleMessageDispatch();
    } catch (error) {
      logger.error("chat", "durable message dispatch pending", { error: String(error) });
    }
  });
}

export function normalizeHistoricalMessage(message: Message): Message {
  if (typeof (message as unknown as Record<string, unknown>).needResponse !== "boolean") return message;
  const { needResponse: _retired, ...rest } = message;
  return rest;
}

export function importMessage(db: Database, scope: string, message: Message): void {
  db.transaction((tx) => insert(tx, storageScopeId(scope), normalizeHistoricalMessage(message)));
}

export function importMessageNextSequence(db: Database, scope: string, nextSeq: number): void {
  if (!Number.isSafeInteger(nextSeq) || nextSeq < 1) throw new Error("Invalid next message sequence");
  db.run(
    "INSERT INTO scope_sequences VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET next_seq=MAX(next_seq,excluded.next_seq)",
    storageScopeId(scope), nextSeq,
  );
}

export function readMessage(scope: string, id: string, db: Database = getDatabase()): Message | null {
  const scopeId = storageScopeId(scope);
  const row = db.get<MessageRow>("SELECT * FROM messages WHERE scope_id=? AND id=?", scopeId, id);
  return row ? hydrate(db, row) : null;
}

export function readMessages(scope: string, db: Database = getDatabase()): Message[] {
  const scopeId = storageScopeId(scope);
  return db.all<MessageRow>("SELECT * FROM messages WHERE scope_id=? ORDER BY position", scopeId).map((row) => hydrate(db, row));
}

export function messagesSince(scope: string, cursor: string | null, db: Database = getDatabase()): Message[] {
  const scopeId = storageScopeId(scope);
  const position = cursor ? db.get<{ position: number }>(
    "SELECT position FROM messages WHERE scope_id=? AND id=?", scopeId, cursor,
  )?.position : undefined;
  return db.all<MessageRow>(
    "SELECT * FROM messages WHERE scope_id=? AND position>? ORDER BY position",
    scopeId, position ?? 0,
  ).map((row) => hydrate(db, row));
}

function around(db: Database, scopeId: string, position: number, limit: number): Message[] {
  const preceding = db.all<MessageRow>(
    "SELECT * FROM messages WHERE scope_id=? AND position<? ORDER BY position DESC LIMIT ?",
    scopeId, position, Math.floor((limit - 1) / 2),
  ).reverse();
  const start = preceding[0]?.position ?? position;
  return db.all<MessageRow>(
    "SELECT * FROM messages WHERE scope_id=? AND position>=? ORDER BY position LIMIT ?",
    scopeId, start, limit,
  ).map((row) => hydrate(db, row));
}

export function pageMessages(scope: string, options: MessagePageOptions = {}, db: Database = getDatabase()): Message[] {
  const scopeId = storageScopeId(scope);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  if (options.around) {
    const target = db.get<{ position: number }>("SELECT position FROM messages WHERE scope_id=? AND id=?", scopeId, options.around);
    return target ? around(db, scopeId, target.position, limit) : [];
  }
  const params: unknown[] = [scopeId];
  let where = "scope_id=?";
  if (options.before) {
    const target = db.get<{ position: number }>("SELECT position FROM messages WHERE scope_id=? AND id=?", scopeId, options.before);
    if (target && db.get("SELECT 1 FROM messages WHERE scope_id=? AND position<? LIMIT 1", scopeId, target.position)) {
      where += " AND position<?";
      params.push(target.position);
    }
  }
  if (options.fromSeq !== undefined) {
    const first = db.get<{ position: number }>(
      `SELECT position FROM messages WHERE ${where} AND seq>? ORDER BY position LIMIT 1`, ...params, options.fromSeq);
    if (!first) return [];
    where += " AND position>=?";
    params.push(first.position);
  }
  return db.all<MessageRow>(`SELECT * FROM messages WHERE ${where} ORDER BY position DESC LIMIT ?`, ...params, limit)
    .reverse().map(row => hydrate(db, row));
}

export function searchMessages(scope: string, options: MessageSearchOptions = {}, db: Database = getDatabase()): MessageSearchResult {
  const scopeId = storageScopeId(scope);
  const params: unknown[] = [scopeId];
  let where = "scope_id=?";
  if (options.query) { where += " AND instr(content_lower,?)>0"; params.push(options.query.toLowerCase()); }
  for (const [column, operator, value] of [
    ["sender", "=", options.from], ["sender_member_id", "=", options.fromMemberId],
    ["ts", ">=", options.after], ["ts", "<", options.before],
  ] as const) {
    if (value !== undefined && value !== "") { where += ` AND ${column}${operator}?`; params.push(value); }
  }
  const total = db.get<{ n: number }>(`SELECT COUNT(*) n FROM messages WHERE ${where}`, ...params)!.n;
  const rows = db.all<MessageRow>(
    `SELECT * FROM messages WHERE ${where} ORDER BY ts DESC,position ASC LIMIT ? OFFSET ?`,
    ...params, Math.max(1, Math.min(options.limit ?? 50, 500)), Math.max(0, options.offset ?? 0),
  );
  return { total, messages: rows.map((row) => hydrate(db, row)) };
}

