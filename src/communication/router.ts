// Message Router — listens for messages, parses @mentions, notifies engine
// Does NOT directly call activateAgent — uses injected callbacks for decoupling.

import { onMessage } from "./message-bus.js";
import { logger } from "../foundation/logger.js";
import type { RoomMemberRecord } from "../shared/types.js";

/** Parse @mentions from message content */
export function parseMentions(content: string, roomMembers: string[]): string[] {
  const mentions: string[] = [];

  if (/@all\b/.test(content)) {
    return ["all"];
  }

  const atPattern = /@([\w.-]+)/g;
  let match;
  while ((match = atPattern.exec(content)) !== null) {
    const name = match[1];
    if (roomMembers.includes(name)) {
      mentions.push(name);
    }
  }

  return [...new Set(mentions)];
}

export function parseMentionMemberIds(content: string, roomMembers: RoomMemberRecord[]): string[] {
  if (/@all\b/.test(content)) return roomMembers.map((member) => member.id);
  const names = parseMentions(content, roomMembers.map((member) => member.name));
  return names
    .map((name) => roomMembers.find((member) => member.name === name)?.id)
    .filter((id): id is string => Boolean(id));
}

/** Initialize router: subscribe to message-bus, invoke callbacks on @mention */
export function initRouter(
  onMention: (roomId: string, memberRef: string) => void,
  onMentionAll: (roomId: string) => void,
): () => void {
  return onMessage((roomId, message) => {
    if (message.mentions.length === 0 && (!message.mentionMemberIds || message.mentionMemberIds.length === 0)) return;

    logger.info("router", "routeMessage", { roomId, mentions: message.mentions, mentionMemberIds: message.mentionMemberIds });

    if (message.mentions.includes("all")) {
      onMentionAll(roomId);
    } else if (message.mentionMemberIds?.length) {
      for (const memberId of message.mentionMemberIds) {
        if (memberId === message.senderMemberId) continue;
        onMention(roomId, memberId);
      }
    } else {
      for (const name of message.mentions) {
        if (name === message.sender) continue;
        onMention(roomId, name);
      }
    }
  });
}
