// Message Router — listens for messages, parses @mentions, notifies engine
// Does NOT directly call activateAgent — uses injected callbacks for decoupling.

import { onMessage } from "./message-bus.js";
import { logger } from "../foundation/logger.js";
import type { RoomMemberRecord } from "../shared/types.js";
import { stripCodeSegments } from "../shared/mention-text.js";

/** Match literal current roster names, longest first (Unicode and spaces included). */
function rosterMentions(content: string, names: string[], marker: "@" | "!"): string[] {
  const plain = stripCodeSegments(content);
  const candidates = [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length);
  const result: string[] = [];
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] !== marker) continue;
    if (marker === "!" && i > 0 && /[\p{L}\p{N}_!]/u.test(plain[i - 1])) continue;
    const name = candidates.find(name => {
      // The marker must be outside code. A legal literal name may itself contain backticks.
      if (!content.startsWith(name, i + 1)) return false;
      const next = content[i + 1 + name.length];
      return !next || !/[\p{L}\p{N}\p{M}_.-]/u.test(next);
    });
    if (name) { result.push(name); i += name.length; }
  }
  return [...new Set(result)];
}

/** Parse current exact @names; code segments are never commands. */
export function parseMentions(content: string, roomMembers: string[]): string[] {
  const found = rosterMentions(content, [...roomMembers, "all"], "@");
  return found.includes("all") ? ["all"] : found;
}

export function parseMentionMemberIds(content: string, roomMembers: RoomMemberRecord[]): string[] {
  const names = parseMentions(content, roomMembers.map((member) => member.name));
  if (names.includes("all")) return roomMembers.map((member) => member.id);
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
  return rosterMentions(content, roomMembers.filter(name => name !== "all"), "!");
}

export function parseUrgentMentionMemberIds(content: string, roomMembers: RoomMemberRecord[]): string[] {
  const names = parseUrgentMentions(content, roomMembers.map((member) => member.name));
  return names
    .map((name) => roomMembers.find((member) => member.name === name)?.id)
    .filter((id): id is string => Boolean(id));
}

/** Activation context passed to mention callbacks (from the routed message). */
export interface MentionActivationCtx {
  /**
   * Member names who owe a reply (chat need_response string[]).
   * Undefined/empty = FYI. User sender still always debts (activateAgent).
   */
  needResponse?: string[];
  needResponseMemberIds?: string[];
  /** Message sender name ("user" for user posts). */
  senderName: string;
}

/** Initialize router: subscribe to message-bus, invoke callbacks on @mention / !urgent */
export function initRouter(
  onMention: (roomId: string, memberRef: string, ctx: MentionActivationCtx) => void,
  onMentionAll: (roomId: string, ctx: MentionActivationCtx) => void,
  onUrgentMention?: (roomId: string, memberRef: string, urgentByName: string) => void,
): () => void {
  return onMessage((roomId, message) => {
    if (message.mentions.length === 0 && (!message.mentionMemberIds || message.mentionMemberIds.length === 0)) return;

    logger.info("router", "routeMessage", { roomId, mentions: message.mentions, mentionMemberIds: message.mentionMemberIds, urgentMentionMemberIds: message.urgentMentionMemberIds, needResponse: message.needResponse });

    const needList = Array.isArray(message.needResponse) ? message.needResponse.filter((n) => typeof n === "string" && n.trim()) : undefined;
    const explicitFyi = Array.isArray(message.needResponse) && message.needResponse.length === 0;
    const ctx: MentionActivationCtx = {
      ...(needList && needList.length ? { needResponse: needList } : {}),
      ...(explicitFyi ? { needResponse: [] as string[] } : {}),
      ...(Array.isArray(message.needResponseMemberIds) ? { needResponseMemberIds: message.needResponseMemberIds } : {}),
      senderName: message.sender,
    };

    if (message.mentions.includes("all")) {
      onMentionAll(roomId, ctx);
    } else if (message.mentionMemberIds?.length) {
      for (const memberId of message.mentionMemberIds) {
        if (memberId === message.senderMemberId) continue;
        if (message.urgentMentionMemberIds?.includes(memberId) && onUrgentMention) {
          onUrgentMention(roomId, memberId, message.sender);
        } else {
          onMention(roomId, memberId, ctx);
        }
      }
    } else {
      for (const name of message.mentions) {
        if (name === message.sender) continue;
        onMention(roomId, name, ctx);
      }
    }
  });
}
