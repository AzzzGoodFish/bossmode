import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "../kernel/json.js";
import { stripCodeSegments } from "../kernel/markdown.js";
import { getDatabase, type Database } from "../data/database.js";
import {
  conversationMember,
  getRoomMembers,
  parseConversation,
  storageScopeId,
} from "./conversations.js";
import { captureChatContext, renderChatInput, type PreparedAgentInput } from "./context.js";
import { confirmMemberCursor, type MemberCursorConfirmation } from "./cursors.js";
import { appendMessageInTransaction, type Message, type MessageInput } from "./messages.js";

export type DeliveryKind = "ordinary" | "dm";
export interface DeliveryActor { actorKey: string; memberId: string | null }
export interface CapturedDeliverySnapshot {
  message: { [key: string]: JsonValue };
  origin: "user" | "member" | "system" | "unresolved";
  messageType: "chat" | "task_event" | "knowledge_event" | "notification";
  senderActorKey: string | null;
  senderMemberId: string | null;
  targets: Record<DeliveryKind, DeliveryActor[]>;
  needResponse: DeliveryActor[] | null;
}
export interface CapturedMessage { scopeId: string; messageId: string; snapshot: CapturedDeliverySnapshot }
export interface DeliveryKey { scopeId: string; messageId: string; targetActorKey: string; deliveryKind: DeliveryKind }
export interface ChatAdmissionToken extends DeliveryKey {
  sourceRef: string;
  idempotencyKey: string;
  cursor: MemberCursorConfirmation | null;
}
export interface PreparedChatAdmission {
  memberId: string;
  sourceRef: string;
  idempotencyKey: string;
  input: PreparedAgentInput;
  replyExpected: boolean;
  chatToken: ChatAdmissionToken;
}
export interface MessageAdmissionResult { message: Message; admissions: PreparedChatAdmission[] }
export type ReplyDisposition = "failed" | "cancelled" | "silent" | "broadcast-skipped" | "continuation-exhausted";
export interface ReplyObligation {
  scopeId: string; messageId: string; actorKey: string; memberId: string | null;
  reason: "user" | "explicit"; openedAt: number; settledAt: number | null; settledByMessageId: string | null;
}
export type ReplySelection = { mode: "all-pending" } | { mode: "reply-target"; messageId: string };

interface AdmissionRow {
  scope_id: string; message_id: string; target_actor_key: string; delivery_kind: DeliveryKind;
  idempotency_key: string; input_json: string; reply_expected: number;
  cursor_message_id: string | null; cursor_message_seq: number | null;
  status: "pending" | "confirmed"; input_id: number | null; opened_at: number; confirmed_at: number | null;
}

const ACTIVE_REPLY = `NOT EXISTS(SELECT 1 FROM reply_obligation_dispositions d
  WHERE d.scope_id=reply_obligations.scope_id AND d.message_id=reply_obligations.message_id
    AND d.actor_key=reply_obligations.actor_key)`;

function required(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid delivery ${field}`);
}
function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid delivery timestamp");
}
function keyParams(key: DeliveryKey): [string, string, string, DeliveryKind] {
  required(key.scopeId, "scope ID");
  required(key.messageId, "message ID");
  required(key.targetActorKey, "target actor key");
  if (key.deliveryKind !== "ordinary" && key.deliveryKind !== "dm") throw new Error("Invalid delivery kind");
  return [key.scopeId, key.messageId, key.targetActorKey, key.deliveryKind];
}
function stableAdmissionKey(key: DeliveryKey): string {
  return `chat:${createHash("sha256").update(canonicalJson(keyParams(key), "Invalid delivery identity")).digest("hex")}`;
}
function validateActors(actors: Map<string, string | null>, values: DeliveryActor[]): void {
  if (!Array.isArray(values)) throw new Error("Captured target arrays are required");
  const local = new Set<string>();
  for (const actor of values) {
    required(actor.actorKey, "target actor key");
    if (actor.memberId !== null) required(actor.memberId, "target member ID");
    if (local.has(actor.actorKey)) throw new Error("Duplicate captured target actor");
    local.add(actor.actorKey);
    if (actors.has(actor.actorKey) && actors.get(actor.actorKey) !== actor.memberId) throw new Error("Conflicting captured actor identity");
    actors.set(actor.actorKey, actor.memberId);
  }
}
function captureJson(capture: CapturedMessage): string {
  required(capture.scopeId, "scope ID");
  required(capture.messageId, "message ID");
  const value = capture.snapshot;
  if (!value || !value.message || Array.isArray(value.message) || typeof value.message !== "object" || value.message.id !== capture.messageId) {
    throw new Error("Captured message ID mismatch");
  }
  if (!["user", "member", "system", "unresolved"].includes(value.origin) ||
    !["chat", "task_event", "knowledge_event", "notification"].includes(value.messageType)) throw new Error("Invalid delivery classification");
  const actors = new Map<string, string | null>();
  if (value.senderActorKey !== null) {
    required(value.senderActorKey, "sender actor key");
    actors.set(value.senderActorKey, value.senderMemberId);
  }
  if (value.senderMemberId !== null) {
    required(value.senderMemberId, "sender member ID");
    if (value.senderActorKey === null) throw new Error("Proven sender member requires actor key");
  }
  if (value.origin === "member" && value.senderActorKey === null) throw new Error("Member sender requires actor key");
  if (!value.targets) throw new Error("Captured targets are required");
  validateActors(actors, value.targets.ordinary);
  validateActors(actors, value.targets.dm);
  if (value.needResponse !== null) validateActors(actors, value.needResponse);
  return canonicalJson(value, "Invalid delivery JSON");
}

function captureMessage(db: Database, capture: CapturedMessage, at: number): void {
  timestamp(at);
  const snapshotJson = captureJson(capture);
  const scope = db.get<{ kind: string }>("SELECT kind FROM scopes WHERE id=?", capture.scopeId);
  if (!scope) throw new Error("Captured delivery scope does not exist");
  if (scope.kind === "dm" ? capture.snapshot.targets.ordinary.length > 0 : capture.snapshot.targets.dm.length > 0) {
    throw new Error("Delivery kind does not match scope");
  }
  const old = db.get<{ snapshot_json: string }>(
    "SELECT snapshot_json FROM delivery_captures WHERE scope_id=? AND message_id=?", capture.scopeId, capture.messageId,
  );
  if (old && old.snapshot_json !== snapshotJson) throw new Error("Conflicting captured message identity");
  if (!old) db.run(
    "INSERT INTO delivery_captures(scope_id,message_id,snapshot_json,captured_at) VALUES(?,?,?,?)",
    capture.scopeId, capture.messageId, snapshotJson, at,
  );
}

export function readCapture(scope: string, messageId: string, db: Database = getDatabase()): CapturedMessage | null {
  const scopeId = storageScopeId(scope);
  const row = db.get<{ snapshot_json: string }>(
    "SELECT snapshot_json FROM delivery_captures WHERE scope_id=? AND message_id=?", scopeId, messageId,
  );
  return row ? { scopeId, messageId, snapshot: JSON.parse(row.snapshot_json) as CapturedDeliverySnapshot } : null;
}

function acceptDelivery(db: Database, key: DeliveryKey, snapshot: CapturedDeliverySnapshot, at: number): boolean {
  const target = snapshot.targets[key.deliveryKind].find(actor => actor.actorKey === key.targetActorKey);
  if (!target) throw new Error("Delivery actor is not a captured target");
  const scope = db.get<{ kind: string }>("SELECT kind FROM scopes WHERE id=?", key.scopeId);
  if ((scope?.kind === "dm") !== (key.deliveryKind === "dm")) throw new Error("Delivery kind does not match scope");
  if (db.get("SELECT 1 FROM captured_deliveries WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=?", ...keyParams(key))) return false;
  db.run(`INSERT INTO captured_deliveries(scope_id,message_id,target_actor_key,delivery_kind,target_member_id,accepted_at)
    VALUES(?,?,?,?,?,?)`, ...keyParams(key), target.memberId, at);
  return true;
}

function openReplies(db: Database, capture: CapturedMessage, at: number): void {
  const value = capture.snapshot;
  if (value.messageType !== "chat" || value.needResponse?.length === 0) return;
  const targets = new Map([...value.targets.ordinary, ...value.targets.dm].map((actor) => [actor.actorKey, actor]));
  const requiredActors = value.origin === "user"
    ? new Set(targets.keys())
    : new Set((value.needResponse ?? []).map((actor) => actor.actorKey));
  for (const actorKey of requiredActors) {
    const actor = targets.get(actorKey);
    if (!actor || actorKey === value.senderActorKey) continue;
    db.run(`INSERT INTO reply_obligations(scope_id,message_id,actor_key,member_id,reason,opened_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(scope_id,message_id,actor_key) DO NOTHING`,
    capture.scopeId, capture.messageId, actorKey, actor.memberId, value.origin === "user" ? "user" : "explicit", at);
  }
}

export function listPendingReplies(scope: string, actorKey: string, db: Database = getDatabase()): ReplyObligation[] {
  return db.all<ReplyObligation>(`SELECT scope_id AS scopeId,message_id AS messageId,actor_key AS actorKey,member_id AS memberId,
    reason,opened_at AS openedAt,settled_at AS settledAt,settled_by_message_id AS settledByMessageId
    FROM reply_obligations WHERE scope_id=? AND actor_key=? AND settled_at IS NULL AND ${ACTIVE_REPLY}
    ORDER BY opened_at,message_id`, storageScopeId(scope), actorKey);
}

export function dismissPendingReplies(
  scope: string,
  actorKey: string,
  disposition: ReplyDisposition,
  diagnosis: string,
  at: number,
  messageIds?: string[],
  db: Database = getDatabase(),
): number {
  const scopeId = storageScopeId(scope);
  required(actorKey, "reply actor key");
  required(diagnosis, "reply diagnosis");
  timestamp(at);
  if (!["failed", "cancelled", "silent", "broadcast-skipped", "continuation-exhausted"].includes(disposition)) throw new Error("Invalid reply disposition");
  if (messageIds?.length === 0) return 0;
  messageIds?.forEach((id) => required(id, "message ID"));
  return db.all(`INSERT INTO reply_obligation_dispositions(scope_id,message_id,actor_key,disposition,diagnosis,recorded_at)
    SELECT scope_id,message_id,actor_key,?,?,? FROM reply_obligations
    WHERE scope_id=? AND actor_key=? AND settled_at IS NULL AND ${ACTIVE_REPLY}
    ${messageIds ? `AND message_id IN (${messageIds.map(() => "?").join(",")})` : ""}
    ON CONFLICT(scope_id,message_id,actor_key) DO NOTHING RETURNING message_id`,
  disposition, diagnosis, at, scopeId, actorKey, ...(messageIds ?? [])).length;
}

export function settleOwnReply(
  input: { scopeId: string; replyMessageId: string; actorKey: string; selection: ReplySelection },
  at: number,
  db: Database = getDatabase(),
): { applied: boolean; settled: number } {
  timestamp(at);
  required(input.actorKey, "reply actor key");
  if (input.selection.mode === "reply-target") required(input.selection.messageId, "reply target ID");
  const scopeId = storageScopeId(input.scopeId);
  const selection = canonicalJson(input.selection, "Invalid reply selection");
  return db.transaction((tx) => {
    const capture = readCapture(scopeId, input.replyMessageId, tx);
    if (!capture || capture.snapshot.origin !== "member" || capture.snapshot.messageType !== "chat" ||
      capture.snapshot.senderActorKey !== input.actorKey) throw new Error("Reply settlement requires the captured own chat sender");
    const old = tx.get<{ selection_json: string; settled_count: number }>(
      "SELECT selection_json,settled_count FROM reply_settlements WHERE scope_id=? AND reply_message_id=? AND actor_key=?",
      scopeId, input.replyMessageId, input.actorKey,
    );
    if (old) {
      if (old.selection_json !== selection) throw new Error("Conflicting reply settlement identity");
      return { applied: false, settled: old.settled_count };
    }
    const targetMessageId = input.selection.mode === "reply-target" ? input.selection.messageId : null;
    const rows = tx.all(`UPDATE reply_obligations SET settled_at=?,settled_by_message_id=?
      WHERE scope_id=? AND actor_key=? AND settled_at IS NULL AND ${ACTIVE_REPLY}${targetMessageId ? " AND message_id=?" : ""}
      RETURNING message_id`, at, input.replyMessageId, scopeId, input.actorKey, ...(targetMessageId ? [targetMessageId] : []));
    tx.run("INSERT INTO reply_settlements VALUES(?,?,?,?,?,?)", scopeId, input.replyMessageId, input.actorKey, selection, rows.length, at);
    return { applied: true, settled: rows.length };
  });
}

function admissionFromRow(row: AdmissionRow, memberId: string, sourceRef: string): PreparedChatAdmission {
  const input = JSON.parse(row.input_json) as PreparedAgentInput;
  const cursor = row.cursor_message_id === null ? null : {
    scopeId: sourceRef,
    memberId,
    messageId: row.cursor_message_id,
    messageSeq: row.cursor_message_seq,
  };
  return {
    memberId,
    sourceRef,
    idempotencyKey: row.idempotency_key,
    input,
    replyExpected: Boolean(row.reply_expected),
    chatToken: {
      scopeId: row.scope_id,
      messageId: row.message_id,
      targetActorKey: row.target_actor_key,
      deliveryKind: row.delivery_kind,
      sourceRef,
      idempotencyKey: row.idempotency_key,
      cursor,
    },
  };
}

function prepareAdmission(
  db: Database,
  sourceRef: string,
  capture: CapturedMessage,
  target: DeliveryActor,
  deliveryKind: DeliveryKind,
  at: number,
): PreparedChatAdmission | null {
  if (!target.memberId) return null;
  const key: DeliveryKey = { scopeId: capture.scopeId, messageId: capture.messageId, targetActorKey: target.actorKey, deliveryKind };
  const accepted = acceptDelivery(db, key, capture.snapshot, at);
  let row = db.get<AdmissionRow>(`SELECT * FROM chat_admissions
    WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=?`, ...keyParams(key));
  if (!row) {
    if (!accepted) throw new Error("Historical captured delivery is not repairable without a pending admission");
    const replyExpected = Boolean(db.get(`SELECT 1 FROM reply_obligations
      WHERE scope_id=? AND message_id=? AND actor_key=? AND settled_at IS NULL AND ${ACTIVE_REPLY}`,
    capture.scopeId, capture.messageId, target.actorKey));
    const context = captureChatContext(db, {
      scopeId: sourceRef,
      memberId: target.memberId,
      messageId: capture.messageId,
      replyExpected,
    });
    const prepared = renderChatInput(context);
    const idempotencyKey = stableAdmissionKey(key);
    db.run(`INSERT INTO chat_admissions(scope_id,message_id,target_actor_key,delivery_kind,idempotency_key,input_json,
      reply_expected,cursor_message_id,cursor_message_seq,status,input_id,opened_at,confirmed_at)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL,?,NULL)`,
    ...keyParams(key), idempotencyKey, canonicalJson(prepared, "Invalid prepared chat input"), Number(replyExpected),
    context.cursor?.messageId ?? null, context.cursor?.messageSeq ?? null, at);
    row = db.get<AdmissionRow>("SELECT * FROM chat_admissions WHERE idempotency_key=?", idempotencyKey)!;
  }
  return admissionFromRow(row, target.memberId, sourceRef);
}

function actor(id: string): DeliveryActor {
  return { actorKey: id, memberId: conversationMember(id, true) ? id : null };
}

/** Literal current-name mentions only; code spans/blocks never activate. */
export function parseMentions(content: string, members: Array<{ id: string; name: string }>): { labels: string[]; memberIds: string[] } {
  const plain = stripCodeSegments(content);
  const candidates = [...new Set([...members.map((member) => member.name), "all"])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const labels: string[] = [];
  for (let index = 0; index < plain.length; index++) {
    if (plain[index] !== "@") continue;
    const name = candidates.find((candidate) => {
      if (!plain.startsWith(candidate, index + 1)) return false;
      const next = plain[index + 1 + candidate.length];
      return !next || !/[\p{L}\p{N}\p{M}_.-]/u.test(next);
    });
    if (name) { labels.push(name); index += name.length; }
  }
  const unique = [...new Set(labels)];
  if (unique.includes("all")) return { labels: ["all"], memberIds: members.map((member) => member.id) };
  return {
    labels: unique,
    memberIds: unique.flatMap((name) => members.filter((member) => member.name === name).map((member) => member.id)),
  };
}

/** Append one message, freeze routing/reply/context facts, and return agent admissions.
 * The caller invokes agent acceptance for each admission in this same outer SQL
 * transaction, then calls confirmChatAdmission with the returned input id. */
export function appendMessageWithAdmissions(
  db: Database,
  source: string,
  input: MessageInput,
): MessageAdmissionResult {
  const ref = parseConversation(source);
  if (!ref) throw new Error(`Invalid chat source: ${source}`);
  const sourceRef = ref.scopeId;
  const scopeId = storageScopeId(sourceRef);
  return db.transaction((tx) => {
    let roster: Array<{ id: string; name: string }> | undefined;
    const ids = (provided: string[] | undefined, names: string[] | undefined): string[] => {
      if (provided !== undefined) return [...new Set(provided)];
      if (!names?.length) return [];
      if (!roster) {
        const owner = ref.kind === "dm" ? conversationMember(ref.memberId, true) : null;
        roster = ref.kind === "room" ? getRoomMembers(ref.roomId) : owner ? [owner] : [];
      }
      if (names.includes("all")) return roster.map((member) => member.id);
      return [...new Set(names.flatMap((name) => roster!.filter((member) => member.name === name).map((member) => member.id)))];
    };
    const prepared = JSON.parse(JSON.stringify(input)) as MessageInput;
    if (!prepared.type && ref.kind === "room" && prepared.mentionMemberIds === undefined) {
      if (prepared.mentions.length === 0) {
        const detected = parseMentions(prepared.content, getRoomMembers(ref.roomId));
        prepared.mentions = detected.labels;
        prepared.mentionMemberIds = detected.memberIds;
      } else prepared.mentionMemberIds = ids(undefined, prepared.mentions);
    }
    if (prepared.needResponseMemberIds === undefined && prepared.needResponse !== undefined) {
      prepared.needResponseMemberIds = ids(undefined, prepared.needResponse);
    }
    const message = appendMessageInTransaction(tx, sourceRef, prepared);
    const sender = message.senderMemberId ? actor(message.senderMemberId) : null;
    const origin: CapturedDeliverySnapshot["origin"] = sender ? "member" :
      message.sender === "user" ? "user" : message.sender === "system" ? "system" : "unresolved";
    const messageType: CapturedDeliverySnapshot["messageType"] = message.type === "task_event" ? "task_event" :
      message.type === "knowledge_event" ? "knowledge_event" : message.type ? "notification" : "chat";
    const targets: CapturedDeliverySnapshot["targets"] = { ordinary: [], dm: [] };
    if (messageType === "chat") {
      if (ref.kind === "dm" && origin === "user") targets.dm = [actor(ref.memberId)];
      else if (ref.kind === "mm" && sender) {
        const other = ref.memberIds.find(id => id !== sender.memberId);
        if (other) targets.ordinary = [actor(other)];
      } else if (ref.kind === "room") {
        targets.ordinary = ids(message.mentionMemberIds, message.mentions)
          .filter((id) => id !== sender?.actorKey).map(actor);
      }
    }
    const needResponse = message.needResponseMemberIds !== undefined || message.needResponse !== undefined
      ? ids(message.needResponseMemberIds, message.needResponse).map(actor) : null;
    const capture: CapturedMessage = {
      scopeId,
      messageId: message.id,
      snapshot: {
        message: JSON.parse(JSON.stringify(message)) as { [key: string]: JsonValue },
        origin,
        messageType,
        senderActorKey: sender?.actorKey ?? null,
        senderMemberId: sender?.memberId ?? null,
        targets,
        needResponse,
      },
    };
    captureMessage(tx, capture, message.ts);
    openReplies(tx, capture, message.ts);
    if (origin === "member" && messageType === "chat" && sender) {
      settleOwnReply({ scopeId, replyMessageId: message.id, actorKey: sender.actorKey, selection: { mode: "all-pending" } }, message.ts, tx);
    }
    const admissions: PreparedChatAdmission[] = [];
    for (const kind of ["ordinary", "dm"] as const) {
      for (const target of targets[kind]) {
        const admission = prepareAdmission(tx, sourceRef, capture, target, kind, message.ts);
        if (admission) admissions.push(admission);
      }
    }
    return { message, admissions };
  });
}

/** Narrow repair entry: only an explicit durable pending admission can be
 * retried. Historical captures without this marker and confirmed/terminal work
 * are never reconstructed from chat history. */
export function listPendingChatAdmissions(db: Database): PreparedChatAdmission[] {
  const rows = db.all<AdmissionRow & { target_member_id: string; scope_kind: "room" | "dm" | "mm" }>(`SELECT a.*,
    d.target_member_id, s.kind AS scope_kind FROM chat_admissions a
    JOIN captured_deliveries d ON d.scope_id=a.scope_id AND d.message_id=a.message_id
      AND d.target_actor_key=a.target_actor_key AND d.delivery_kind=a.delivery_kind
    JOIN scopes s ON s.id=a.scope_id
    WHERE a.status='pending' AND d.target_member_id IS NOT NULL
    ORDER BY a.opened_at, a.idempotency_key`);
  return rows.map((row) => admissionFromRow(row, row.target_member_id,
    row.scope_kind === "room" ? `room:${row.scope_id}` : row.scope_id));
}

export function repairPendingChatAdmission(
  db: Database,
  sourceRef: string,
  messageId: string,
  memberId: string,
): PreparedChatAdmission | null {
  const ref = parseConversation(sourceRef);
  if (!ref) throw new Error(`Invalid chat source: ${sourceRef}`);
  const row = db.get<AdmissionRow>(`SELECT a.* FROM chat_admissions a
    JOIN captured_deliveries d ON d.scope_id=a.scope_id AND d.message_id=a.message_id
      AND d.target_actor_key=a.target_actor_key AND d.delivery_kind=a.delivery_kind
    WHERE a.scope_id=? AND a.message_id=? AND d.target_member_id=? AND a.status='pending'`,
  storageScopeId(sourceRef), messageId, memberId);
  return row ? admissionFromRow(row, memberId, ref.scopeId) : null;
}

/** Confirm the queue receipt and cursor in the caller's outer transaction. A
 * confirmed replay is accepted only with the exact original input id and never
 * moves a cursor again. */
export function confirmChatAdmission(
  db: Database,
  token: ChatAdmissionToken,
  inputId: number,
  confirmedAt = Date.now(),
): { confirmed: boolean; cursorConfirmed: boolean } {
  if (!Number.isSafeInteger(inputId) || inputId < 1) throw new Error("Invalid agent input id");
  timestamp(confirmedAt);
  return db.transaction((tx) => {
    const row = tx.get<AdmissionRow>(`SELECT * FROM chat_admissions
      WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=?`, ...keyParams(token));
    if (!row || row.idempotency_key !== token.idempotencyKey) throw new Error("Unknown or conflicting chat admission");
    if (row.status === "confirmed") {
      if (row.input_id !== inputId) throw new Error("Conflicting agent input receipt");
      return { confirmed: false, cursorConfirmed: false };
    }
    tx.run(`UPDATE chat_admissions SET status='confirmed',input_id=?,confirmed_at=?
      WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=? AND status='pending'`,
    inputId, confirmedAt, ...keyParams(token));
    const cursorConfirmed = token.cursor ? confirmMemberCursor(token.cursor, tx) : false;
    return { confirmed: true, cursorConfirmed };
  });
}
