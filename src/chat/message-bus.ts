import {pendingScopeNotifications} from "../data/repositories/notification-repository.js";
// Unified message write + broadcast + listener notification
// All messages (user, agent, system) go through here.

import * as messageStore from "./message-store.js";
import { appendCapturedMessage } from "./message-service.js";
import { pendingMessageDispatches, recordDispatchAttempt, markDispatchDelivered, isDispatchDelivered } from "../data/repositories/message-dispatch-repository.js";
import { broadcastToRoom } from "../app/ws.js";
import { logger } from "../kernel/logger.js";
import type { RoomMessage } from "../kernel/types.js";

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
 * Optional `extra` fields are spread into the stored message (e.g. type, knowledge_event_meta).
 */
export function postMessage(
  roomId: string,
  sender: string,
  content: string,
  mentions: string[] = [],
  extra?: Partial<Pick<RoomMessage, "type" | "knowledge_event_meta" | "topic_event_meta" | "artifacts" | "attachments" | "senderMemberId" | "mentionMemberIds" | "needResponse" | "needResponseMemberIds" | "replyTo" | "member_chat_meta">>,
): RoomMessage {
  const message = appendCapturedMessage(roomId, { sender, content, mentions, ...extra });
  // A microtask runs after any enclosing synchronous business transaction has
  // committed/rolled back. Never notify from inside a nested savepoint.
  scheduleMessageDispatch();

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

let dispatchScheduled = false;
/** Parent calls after listener registration at startup and after composed task commits.
 * Scheduling (rather than immediate delivery) is safe even inside a transaction.
 */
export function scheduleMessageDispatch(): void {
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  queueMicrotask(() => {
    dispatchScheduled = false;
    try { dispatchPendingMessages(); }
    catch (error) { logger.error("message-bus", "durable dispatch pending", {error:String(error)}); }
  });
}

// Private: only called on a fresh microtask, never on a transaction caller's stack.
function dispatchPendingMessages(): void {
  const pending = pendingMessageDispatches();
  for (const {id,scopeId,message} of pending) {
    recordDispatchAttempt(id);
    broadcastToRoom(scopeId,{type:"room:message",roomId:scopeId,message});
    let failed = false;
    for (const fn of listeners) {
      try { fn(scopeId,message); }
      catch (error) { failed = true; logger.error("message-bus","listener error",{error:String(error)}); }
    }
    if (!failed) markDispatchDelivered(id);
  }
  const notifications=pendingScopeNotifications();
  for(const notification of notifications){
    recordDispatchAttempt(notification.id);
    broadcastToRoom(notification.scopeId,notification.event);
    markDispatchDelivered(notification.id);
  }
  if(notifications.length===500 && notifications.every(row=>isDispatchDelivered(row.id)))scheduleMessageDispatch();
  // Do not hot-loop on poison deliveries; parent retries on its recovery timer.
  if (pending.length === 500 && pending.every(row => isDispatchDelivered(row.id))) scheduleMessageDispatch();
}
