import type { Database } from "../data/database.js";
import { getAttachmentPath, type AttachmentLocation } from "../files/attachments.js";
import {
  conversationMember,
  getRoom,
  parseConversation,
  type ConversationIdentity,
} from "./conversations.js";
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
  targetMember: { id: string; name: string };
  chatName: string;
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

function attachmentLocation(ref: ConversationIdentity): AttachmentLocation {
  if (ref.kind === "room") return { kind: "room", roomId: ref.roomId };
  if (ref.kind === "dm") return { kind: "dm", memberId: ref.memberId };
  return { kind: "mm", memberIds: ref.memberIds };
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
  } else if (ref.kind === "dm") {
    if (ref.memberId !== input.memberId) throw new Error("DM target does not own the conversation");
    chatName = "user";
  } else {
    if (!ref.memberIds.includes(input.memberId)) throw new Error("Member chat target is not a participant");
    const other = ref.memberIds.find((id) => id !== input.memberId)!;
    chatName = conversationMember(other, true)?.name ?? other;
  }
  return {
    sourceRef: ref.scopeId,
    kind: ref.kind,
    targetMember: { id: input.memberId, name: identity.name },
    chatName,
    trigger: structuredClone(trigger),
    replyTarget: replyTarget ? structuredClone(replyTarget) : null,
    unread,
    attachmentLocation: attachmentLocation(ref),
    cursor,
    replyExpected: input.replyExpected,
  };
}

function escapeLabel(value: string): string { return String(value).replace(/"/g, "\\\""); }
function timestamp(value: number): string {
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function excerpt(value: string, max = 200): string {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function replyQuote(snapshot: ChatContextSnapshot): string {
  const reference = snapshot.trigger.replyTo;
  if (!reference) return "";
  const target = snapshot.replyTarget;
  if (!target) return `[In reply to msg:#${reference.seq} — original not visible in this context]`;
  return `[In reply to msg:#${target.seq ?? reference.seq} from ${escapeLabel(target.sender)}]: "${excerpt(target.content)}"`;
}

function attachmentLines(snapshot: ChatContextSnapshot): string[] {
  return (snapshot.trigger.attachments ?? []).map((attachment) => {
    try {
      return `Attachment: [original filename: ${attachment.originalFilename}](${getAttachmentPath(snapshot.attachmentLocation, attachment.storedFilename)})`;
    } catch {
      return `Attachment: [original filename: ${attachment.originalFilename}](unavailable)`;
    }
  });
}

export function renderUnreadHint(summary: UnreadSummary | null): string | null {
  if (!summary) return null;
  const senderText = summary.senders.map(({ name, count }) => `${name}×${count}`).join(", ");
  const events: string[] = [];
  if (summary.taskEvents) events.push(`${summary.taskEvents} task events`);
  if (summary.knowledgeEvents) events.push(`${summary.knowledgeEvents} knowledge updates`);
  const eventClause = events.length ? ` — incl. ${events.join(", ")}` : "";
  const range = summary.total > summary.shown
    ? `you have ${summary.total} unread (latest ${summary.shown}, No.${summary.firstSeq}–No.${summary.lastSeq})`
    : `you have ${summary.total} unread messages (No.${summary.firstSeq}–No.${summary.lastSeq})`;
  return `[Earlier in this room ${range}: ${senderText}${eventClause}. Read them with chat_read (from_seq ${summary.fromSeq}); reading marks them seen.]`;
}

/** Pure render: message bytes, identity, reply target, attachment paths and
 * cursor summary were already frozen in the snapshot. */
export function renderChatInput(snapshot: ChatContextSnapshot): PreparedAgentInput {
  const message = snapshot.trigger;
  const senderId = message.senderMemberId ? ` (${message.senderMemberId})` : "";
  const seq = message.seq === undefined ? "" : `, No.${message.seq}`;
  const quote = replyQuote(snapshot);
  const attachments = attachmentLines(snapshot);
  const body = [quote, message.content, ...attachments].filter(Boolean).join("\n\n");
  let envelope: string;
  if (snapshot.kind === "room") {
    const role = message.sender === "user" ? "User" : "Member";
    envelope = `[Message from room "${escapeLabel(snapshot.chatName)}" (${snapshot.sourceRef}). ${role} \`${escapeLabel(message.sender)}\`${senderId}${seq}, ${timestamp(message.ts)}]\n\n${body}`;
  } else if (snapshot.kind === "dm") {
    const role = message.sender === "user" ? "User" : "Member";
    envelope = `You are in a private chat with the user (${snapshot.sourceRef}). New message:\n\n[${role}${message.sender === "user" ? "" : ` \`${escapeLabel(message.sender)}\`${senderId}`}] ${body}`;
  } else {
    envelope = `You are in a private chat with member \`${escapeLabel(snapshot.chatName)}\` (${snapshot.sourceRef}). New message:\n\n[Member \`${escapeLabel(message.sender)}\`${senderId}] ${body}`;
  }
  const replyBanner = snapshot.replyExpected
    ? message.senderMemberId
      ? `[REPLY EXPECTED] ${message.sender} expects your reply — respond with the chat tool.`
      : "[REPLY EXPECTED] Respond using the chat tool."
    : null;
  const unread = snapshot.kind === "room" ? renderUnreadHint(snapshot.unread) : null;
  return {
    prompt: [replyBanner, unread, envelope].filter(Boolean).join("\n\n"),
    trigger: "chat-message",
    replySources: [message.id],
  };
}
