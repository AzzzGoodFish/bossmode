import type { RoomMessage } from "../shared/types.js";
import { USER_DISPLAY_NAME } from "../shared/user-identity.js";

export type SenderRole = "user" | "member";

export const ROOM_REPLY_FOOTER = "[Reply hint: Suggested call the chat tool with target=\"room\" so the room receives your response.]";
export const PRIVATE_REPLY_FOOTER = "[Reply hint: Suggested call the chat tool with target=\"user\" so the user receives your response.]";

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

function headerFromRoom(roomName: string, role: SenderRole, sender: string, isMention: boolean): string {
  const safeRoom = escapeLabel(roomName);
  const safeSender = escapeLabel(senderDisplayName(sender));
  if (isMention) {
    return `[Message from room "${safeRoom}", mentioned by ${role} @${safeSender}]`;
  }
  return `[Message from room "${safeRoom}", from ${role} @${safeSender}]`;
}

export function wrapRoomContextMessage(msg: RoomMessage, roomName: string, senderRole: SenderRole): string {
  const header = headerFromRoom(roomName, senderRole, msg.sender, false);
  return `${header}\n\n${msg.content}`;
}

export function wrapRoomMentionMessage(
  msg: RoomMessage,
  roomName: string,
  senderRole: SenderRole,
  _receiverName: string,
): string {
  const header = headerFromRoom(roomName, senderRole, msg.sender, true);
  return `${header}\n\n${msg.content}`;
}

export function wrapPrivateMessage(content: string, senderName: string): string {
  const safeSender = escapeLabel(senderName);
  return `[Private message from user @${safeSender}]\n\n${content}`;
}
