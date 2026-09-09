// Application messages are authoritative DB facts; scopes are created by ConversationService.
import type { RoomMessage } from "../shared/types.js";
import { appendMessage, readMessages, pageMessages, messagesSince, latestMessage, patchMessage, replaceMessages, searchMessageFacts } from "../storage/message-repository.js";

export const addMessage = appendMessage;
export const getMessages = pageMessages;
export const getMessagesSince = messagesSince;
export function getLatestMessageId(scopeId: string): string | null { return latestMessage(scopeId)?.id ?? null; }
export const updateMessage = patchMessage;
export const overwriteMessages = replaceMessages;
export const readAllMessages = readMessages;

export interface SearchOptions {
  query?: string;    // case-insensitive substring on content
  from?: string;     // sender filter (exact match)
  after?: number;    // ts >= after (epoch ms)
  before?: number;   // ts < before (epoch ms)
  limit?: number;    // default 50, max 500
  offset?: number;   // default 0
  type?: string;     // message type filter (e.g. "task_event", "knowledge_event")
  aroundSeq?: number; // return a window centered on the message with this seq
}

export interface SearchResult {
  total: number;
  messages: RoomMessage[];
}

export const searchMessages = searchMessageFacts;
