// Unified message write + broadcast + listener notification
// All messages (user, agent, system) go through here.

import * as messageStore from "../workspace/message-store.js";
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
  extra?: Partial<Pick<RoomMessage, "type" | "summary_meta" | "task_event_meta">>,
): RoomMessage {
  const message = messageStore.addMessage(roomId, { sender, content, mentions, ...extra });

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
