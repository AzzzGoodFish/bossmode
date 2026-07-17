import type { RoomMessage } from "../shared/types.js";
import { USER_DISPLAY_NAME } from "../shared/user-identity.js";

export type SenderRole = "user" | "member";

function escapeLabel(text: string): string {
  return String(text).replace(/"/g, "\\\"");
}

export function resolveSenderRole(sender: string): SenderRole {
  return sender === "user" ? "user" : "member";
}

/** Map internal sender id to the human-visible display name for envelopes. */
function senderDisplayName(sender: string): string {
  return sender === "user" ? USER_DISPLAY_NAME : sender;
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

/** Wrap a single room message for agent consumption (single-message envelope). */
export function wrapRoomContextMessage(msg: RoomMessage, roomName: string, senderRole: SenderRole): string {
  const header = `[Message from room "${escapeLabel(roomName)}". ${subHeader(senderRole, msg.sender, msg).slice(1, -1)}]`;
  return `${header}\n\n${msg.content}`;
}

/** Wrap a batch of room messages as a shared transcript (multi-message envelope). */
export function wrapRoomMessagesTranscript(messages: Array<{ msg: RoomMessage; role: SenderRole }>, roomName: string): string {
  const header = `[Messages from room "${escapeLabel(roomName)}"]`;
  const parts = messages.map(({ msg, role }) => `${subHeader(role, msg.sender, msg)}\n\n${msg.content}`);
  return `${header}\n\n${parts.join("\n\n\n")}`;
}
