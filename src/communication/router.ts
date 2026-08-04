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

// -- Urgent `!name` gesture (fish 2026-08-04: interrupt + immediate response) --

/**
 * Parse urgent `!name` gestures. Same membership rule as @ (exact room-member
 * name) plus an explicit left boundary — the `!` must not be glued to a word
 * char or another `!` — so "Hello!pm" and "wow!!" never fire. Full-width
 * Chinese `！` is a different codepoint and never matches. `!all` is NOT
 * supported (interrupting the whole room is not a thing).
 */
export function parseUrgentMentions(content: string, roomMembers: string[]): string[] {
  const pattern = /(?<![\w!])!([\w.-]+)/g;
  const out: string[] = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1];
    if (roomMembers.includes(name)) out.push(name);
  }
  return [...new Set(out)];
}

export function parseUrgentMentionMemberIds(content: string, roomMembers: RoomMemberRecord[]): string[] {
  const names = parseUrgentMentions(content, roomMembers.map((member) => member.name));
  return names
    .map((name) => roomMembers.find((member) => member.name === name)?.id)
    .filter((id): id is string => Boolean(id));
}

/** Initialize router: subscribe to message-bus, invoke callbacks on @mention / !urgent */
export function initRouter(
  onMention: (roomId: string, memberRef: string) => void,
  onMentionAll: (roomId: string) => void,
  onUrgentMention?: (roomId: string, memberRef: string, urgentByName: string) => void,
): () => void {
  return onMessage((roomId, message) => {
    if (message.mentions.length === 0 && (!message.mentionMemberIds || message.mentionMemberIds.length === 0)) return;

    logger.info("router", "routeMessage", { roomId, mentions: message.mentions, mentionMemberIds: message.mentionMemberIds, urgentMentionMemberIds: message.urgentMentionMemberIds });

    if (message.mentions.includes("all")) {
      onMentionAll(roomId);
    } else if (message.mentionMemberIds?.length) {
      for (const memberId of message.mentionMemberIds) {
        if (memberId === message.senderMemberId) continue;
        if (message.urgentMentionMemberIds?.includes(memberId) && onUrgentMention) {
          onUrgentMention(roomId, memberId, message.sender);
        } else {
          onMention(roomId, memberId);
        }
      }
    } else {
      for (const name of message.mentions) {
        if (name === message.sender) continue;
        onMention(roomId, name);
      }
    }
  });
}
