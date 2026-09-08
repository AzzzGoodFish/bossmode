// Unified message write + broadcast + listener notification
// All messages (user, agent, system) go through here.

import * as messageStore from "../workspace/message-store.js";
import { addDmMessage } from "../workspace/dm-message-store.js";
import { addTopicMessage, resolveTopicRoomId } from "../workspace/topic-store.js";
import { broadcastToRoom } from "./ws.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage } from "../shared/types.js";

type MessageListener = (roomId: string, message: RoomMessage) => void;

const listeners: MessageListener[] = [];

/** Register a message listener. Returns unsubscribe function. */
export function onMessage(fn: MessageListener): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

/**
 * Unified message posting: write to store + WS broadcast + notify listeners.
 * All message sources (API, tool callback, MCP) call this.
 * Optional `extra` fields are spread into the stored message (e.g. type, task_event_meta).
 */
export function postMessage(
  roomId: string,
  sender: string,
  content: string,
  mentions: string[] = [],
  extra?: Partial<Pick<RoomMessage, "type" | "task_event_meta" | "knowledge_event_meta" | "topic_event_meta" | "artifacts" | "attachments" | "senderMemberId" | "mentionMemberIds" | "urgentMentions" | "urgentMentionMemberIds" | "needResponse" | "needResponseMemberIds" | "autoDelivered" | "replyTo">>,
): RoomMessage {
  // Scope-aware egress:
  // - dm:<memberId> → member-owned DM store
  // - topic:<topicId> → rooms/<roomId>/topics/<topicId>/messages.jsonl
  // - plain room id → room messages.jsonl
  // Broadcast channel and listener notification stay keyed by the same address
  // (topic messages never land in the parent room stream).
  let message: RoomMessage;
  if (roomId.startsWith("dm:")) {
    message = addDmMessage(roomId.slice("dm:".length), { sender, content, mentions, ...extra });
  } else if (roomId.startsWith("topic:")) {
    const topicId = roomId.slice("topic:".length);
    const parentRoomId = resolveTopicRoomId(topicId);
    if (!parentRoomId) throw new Error(`Unknown topic scope: ${roomId}`);
    message = addTopicMessage(parentRoomId, topicId, { sender, content, mentions, ...extra });
  } else {
    message = messageStore.addMessage(roomId, { sender, content, mentions, ...extra });
  }

  // WebSocket broadcast
  broadcastToRoom(roomId, { type: "room:message", roomId, message });
  logger.info("ws", "broadcast room:message", { roomId, sender, msgId: message.id, mentions });

  // Notify listeners (synchronous — observer pattern, not event bus)
  for (const fn of listeners) {
    try {
      fn(roomId, message);
    } catch (err) {
      logger.error("message-bus", "listener error", { error: String(err) });
    }
  }

  return message;
}

/** Query messages — delegates to message-store */
export function queryMessages(roomId: string, opts?: { limit?: number; before?: string }): RoomMessage[] {
  return messageStore.getMessages(roomId, opts);
}

/** Get messages since cursor — delegates to message-store */
export function getMessagesSince(roomId: string, cursorId: string | null): RoomMessage[] {
  return messageStore.getMessagesSince(roomId, cursorId);
}

/** Get latest message ID — delegates to message-store */
export function getLatestMessageId(roomId: string): string | null {
  return messageStore.getLatestMessageId(roomId);
}
