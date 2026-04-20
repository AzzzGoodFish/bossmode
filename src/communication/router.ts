// Message Router — listens for messages, parses @mentions, notifies engine
// Does NOT directly call activateAgent — uses injected callbacks for decoupling.

import { onMessage } from "./message-bus.js";
import { logger } from "../foundation/logger.js";

/** Parse @mentions from message content */
export function parseMentions(content: string, roomMembers: string[]): string[] {
  const mentions: string[] = [];

  if (/@all\b/.test(content)) {
    return ["all"];
  }

  const atPattern = /@([\w-]+)/g;
  let match;
  while ((match = atPattern.exec(content)) !== null) {
    const name = match[1];
    if (roomMembers.includes(name)) {
      mentions.push(name);
    }
  }

  return [...new Set(mentions)];
}

/** Initialize router: subscribe to message-bus, invoke callbacks on @mention */
export function initRouter(
  onMention: (roomId: string, memberName: string) => void,
  onMentionAll: (roomId: string) => void,
): () => void {
  return onMessage((roomId, message) => {
    if (message.mentions.length === 0) return;

    logger.info("router", "routeMessage", { roomId, mentions: message.mentions });

    if (message.mentions.includes("all")) {
      onMentionAll(roomId);
    } else {
      for (const name of message.mentions) {
        if (name === message.sender) continue;
        onMention(roomId, name);
      }
    }
  });
}
