import type { Database } from "../data/database.js";
import { getAttachmentPath, type AttachmentLocation } from "../files/attachments.js";
import { attachmentLocation, chatShortId, conversationMember, getRoom, parseConversation, type ConversationIdentity } from "./conversations.js";
import { getMemberCursor, type MemberCursorConfirmation } from "./cursors.js";
import { isSystemNoticeHiddenFromMembers, messagesSince, readMessage, type Message } from "./messages.js";

export interface UnreadSummary {
  total: number;
  shown: number;
  firstSeq: number | null;
  lastSeq: number | null;
  fromSeq: number;
  senders: Array<{ name: string; count: number }>;
  taskEvents: number;
  knowledgeEvents: number;
}

export interface ChatContextSnapshot {
  sourceRef: string;
  kind: ConversationIdentity["kind"];
  chatName: string;
  chatShortId: string | null;
  lastRead: number | null;
  trigger: Message;
  replyTarget: Message | null;
  unread: UnreadSummary | null;
  attachmentLocation: AttachmentLocation;
  cursor: MemberCursorConfirmation | null;
  replyExpected: boolean;
}

export interface PreparedAgentInput {
  prompt: string;
  trigger: "chat-message";
  replySources: string[];
}

function ownMessage(message: Message, memberId: string, memberName: string): boolean {
  return message.senderMemberId !== undefined
    ? message.senderMemberId === memberId
    : !memberId.startsWith("mem_") && message.sender === memberName;
}

function summarizeUnread(messages: Message[], total: number, fromSeq: number): UnreadSummary | null {
  if (!messages.length || total < 1) return null;
  const counts = new Map<string, number>();
  let taskEvents = 0;
  let knowledgeEvents = 0;
  for (const message of messages) {
    const sender = message.sender || "unknown";
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
    if (message.type === "task_event") taskEvents++;
    else if (message.type === "knowledge_event") knowledgeEvents++;
  }
  const senders = [...counts.entries()]
    .sort((a, b) => a[0] === "user" ? -1 : b[0] === "user" ? 1 : b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
  return {
    total,
    shown: messages.length,
    firstSeq: messages[0].seq ?? null,
    lastSeq: messages.at(-1)?.seq ?? null,
    fromSeq,
    senders,
    taskEvents,
    knowledgeEvents,
  };
}

/** Capture all SQL-backed chat context while the message/admission transaction
 * is open. The returned snapshot contains no live lookups. */
export function captureChatContext(
  db: Database,
  input: { scopeId: string; memberId: string; messageId: string; replyExpected: boolean; unreadLimit?: number },
): ChatContextSnapshot {
  const ref = parseConversation(input.scopeId);
  if (!ref) throw new Error(`Invalid chat source: ${input.scopeId}`);
  const identity = conversationMember(input.memberId, true);
  if (!identity) throw new Error(`Unknown chat target member: ${input.memberId}`);
  const trigger = readMessage(ref.scopeId, input.messageId, db);
  if (!trigger) throw new Error(`Chat trigger not found: ${ref.scopeId}/${input.messageId}`);
  const replyTarget = trigger.replyTo ? readMessage(ref.scopeId, trigger.replyTo.messageId, db) : null;
  let chatName: string;
  let unread: UnreadSummary | null = null;
  let cursor: MemberCursorConfirmation | null = null;
  if (ref.kind === "room") {
    const room = getRoom(ref.roomId);
    if (!room) throw new Error(`Room not found: ${ref.roomId}`);
    chatName = room.name;
  } else if (ref.kind === "dm") {
    if (ref.memberId !== input.memberId) throw new Error("DM target does not own the conversation");
    chatName = "user";
  } else {
    if (!ref.memberIds.includes(input.memberId)) throw new Error("Member chat target is not a participant");
    const other = ref.memberIds.find((id) => id !== input.memberId)!;
    chatName = conversationMember(other, true)?.name ?? other;
  }
  // Unread backlog is uniform across kinds: everything the member has not
  // consumed before the trigger, excluding its own messages and hidden
  // system notices (spec unified-user-prompt v1.6, last_read attribute).
  const current = getMemberCursor(ref.scopeId, input.memberId, db);
  const visible = messagesSince(ref.scopeId, current, db).filter((message) => !isSystemNoticeHiddenFromMembers(message));
  const beforeTrigger = visible.filter((message) =>
    message.id !== trigger.id && (message.seq ?? 0) < (trigger.seq ?? Number.MAX_SAFE_INTEGER) &&
    !ownMessage(message, input.memberId, identity.name));
  const limit = Math.max(1, Math.min(input.unreadLimit ?? 50, 500));
  const shown = beforeTrigger.slice(-limit);
  unread = summarizeUnread(shown, beforeTrigger.length, (beforeTrigger[0]?.seq ?? 1) - 1);
  cursor = {
    scopeId: ref.scopeId,
    memberId: input.memberId,
    messageId: trigger.id,
    messageSeq: trigger.seq ?? null,
  };
  return {
    sourceRef: ref.scopeId,
    kind: ref.kind,
    chatName,
    chatShortId: chatShortId(ref.scopeId, db),
    lastRead: unread && unread.firstSeq !== null && unread.firstSeq > 0 ? unread.firstSeq - 1 : null,
    trigger: structuredClone(trigger),
    replyTarget: replyTarget ? structuredClone(replyTarget) : null,
    unread,
    attachmentLocation: attachmentLocation(ref),
    cursor,
    replyExpected: input.replyExpected,
  };
}

function xmlEscape(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function xmlAttr(value: string): string {
  return xmlEscape(value).replace(/"/g, "&quot;");
}
function timestamp(value: number): string {
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function excerpt(value: string, max = 50): string {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function replyQuote(snapshot: ChatContextSnapshot): string {
  const reference = snapshot.trigger.replyTo;
  if (!reference) return "";
  const target = snapshot.replyTarget;
  if (!target) return `<quote msg_id="${reference.seq ?? ""}" unavailable="true"/>`;
  return `<quote msg_id="${target.seq ?? reference.seq}" sender_name="${xmlAttr(target.sender)}">${xmlEscape(excerpt(target.content))}</quote>`;
}

function attachmentLines(snapshot: ChatContextSnapshot): string[] {
  return (snapshot.trigger.attachments ?? []).map((attachment) => {
    try {
      return `<attachment filename="${xmlAttr(attachment.originalFilename)}" path="${xmlAttr(getAttachmentPath(snapshot.attachmentLocation, attachment.storedFilename))}"/>`;
    } catch {
      return `<attachment filename="${xmlAttr(attachment.originalFilename)}" unavailable="true"/>`;
    }
  });
}

/** Pure render: message bytes, identity, reply target, attachment paths,
 * chat short id and last_read pointer were already frozen in the snapshot.
 * One chat_message element per delivered message (spec unified-user-prompt
 * v1.6); queued batches are wrapped by the scheduler as chat_batch. */
export function renderChatInput(snapshot: ChatContextSnapshot): PreparedAgentInput {
  const message = snapshot.trigger;
  const attributes = [
    `chat_name="${xmlAttr(snapshot.chatName)}"`,
    `chat_id="${xmlAttr(snapshot.chatShortId ?? snapshot.sourceRef)}"`,
    `chat_type="${snapshot.kind === "room" ? "channel" : "dm"}"`,
    `sender_id="${xmlAttr(message.senderMemberId ?? "user")}"`,
    `sender_name="${xmlAttr(message.sender)}"`,
    ...(message.seq === undefined ? [] : [`msg_id="${message.seq}"`]),
    `at="${timestamp(message.ts)}"`,
    ...(snapshot.lastRead === null ? [] : [`last_read="${snapshot.lastRead}"`]),
  ].join(" ");
  const quote = replyQuote(snapshot);
  const attachments = attachmentLines(snapshot);
  const body = [quote, xmlEscape(message.content), ...attachments].filter(Boolean).join("\n");
  return {
    prompt: `<chat_message ${attributes}>\n${body}\n</chat_message>`,
    trigger: "chat-message",
    replySources: [message.id],
  };
}
