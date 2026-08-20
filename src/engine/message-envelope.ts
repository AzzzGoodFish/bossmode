import type { RoomMessage } from "../shared/types.js";
import { getUserDisplayName } from "../shared/user-identity.js";

export type SenderRole = "user" | "member";

function escapeLabel(text: string): string {
  return String(text).replace(/"/g, "\\\"");
}

export function resolveSenderRole(sender: string): SenderRole {
  return sender === "user" ? "user" : "member";
}

/** Map internal sender id to the human-visible display name for envelopes. */
function senderDisplayName(sender: string): string {
  return sender === "user" ? getUserDisplayName() : sender;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function roleLabel(role: SenderRole): string {
  return role === "user" ? "User" : "Member";
}

function subHeader(role: SenderRole, sender: string, msg: RoomMessage): string {
  const safeSender = escapeLabel(senderDisplayName(sender));
  const seq = msg.seq !== undefined ? `, No.${msg.seq}` : "";
  return `[${roleLabel(role)} \`${safeSender}\`${seq}, ${formatTimestamp(msg.ts)}]`;
}

const REPLY_EXCERPT_MAX = 200;

function excerpt(content: string, max = REPLY_EXCERPT_MAX): string {
  const oneLine = String(content || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/**
 * Build the reply-quote block for activation envelopes (plan-reply-to-v1 §3).
 * `lookup` resolves the target message in the current scope; when missing/invisible,
 * attach a non-blocking note.
 */
export function formatReplyQuoteBlock(
  msg: RoomMessage,
  lookup?: (ref: { seq: number; messageId: string }) => RoomMessage | undefined | null,
): string {
  if (!msg.replyTo) return "";
  const target = lookup?.(msg.replyTo);
  if (!target) {
    return `[In reply to msg:#${msg.replyTo.seq} — original not visible in this context]`;
  }
  const who = escapeLabel(senderDisplayName(target.sender));
  const seq = target.seq !== undefined ? target.seq : msg.replyTo.seq;
  return `[In reply to msg:#${seq} from ${who}]: "${excerpt(target.content)}"`;
}

function bodyWithReply(
  msg: RoomMessage,
  lookup?: (ref: { seq: number; messageId: string }) => RoomMessage | undefined | null,
): string {
  const quote = formatReplyQuoteBlock(msg, lookup);
  if (!quote) return msg.content;
  return `${quote}\n\n${msg.content}`;
}

/** Wrap a single room message for agent consumption (single-message envelope). */
export function wrapRoomContextMessage(
  msg: RoomMessage,
  roomName: string,
  senderRole: SenderRole,
  lookup?: (ref: { seq: number; messageId: string }) => RoomMessage | undefined | null,
): string {
  const header = `[Message from room "${escapeLabel(roomName)}". ${subHeader(senderRole, msg.sender, msg).slice(1, -1)}]`;
  return `${header}\n\n${bodyWithReply(msg, lookup)}`;
}

/** Wrap a batch of room messages as a shared transcript (multi-message envelope). */
export function wrapRoomMessagesTranscript(
  messages: Array<{ msg: RoomMessage; role: SenderRole }>,
  roomName: string,
  lookup?: (ref: { seq: number; messageId: string }) => RoomMessage | undefined | null,
): string {
  const header = `[Messages from room "${escapeLabel(roomName)}"]`;
  const parts = messages.map(({ msg, role }) => `${subHeader(role, msg.sender, msg)}\n\n${bodyWithReply(msg, lookup)}`);
  return `${header}\n\n${parts.join("\n\n\n")}`;
}
