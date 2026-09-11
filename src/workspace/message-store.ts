// Application messages are authoritative DB facts; scopes are created by ConversationService.
import { limitRuntimeFailureRoomMessage } from "../shared/runtime-error-limit.js";
import type { RoomMessage } from "../shared/types.js";
import { appendMessage, readMessages, pageMessages, messagesSince, latestMessage, patchMessage, replaceMessages, searchMessageFacts } from "../storage/message-repository.js";

export const addMessage = appendMessage;
export function getMessages(...args: Parameters<typeof pageMessages>): RoomMessage[] { return pageMessages(...args).map(limitRuntimeFailureRoomMessage); }
export function getMessagesSince(...args: Parameters<typeof messagesSince>): RoomMessage[] { return messagesSince(...args).map(limitRuntimeFailureRoomMessage); }
export function getLatestMessageId(scopeId: string): string | null { return latestMessage(scopeId)?.id ?? null; }
export const updateMessage = patchMessage;
export const overwriteMessages = replaceMessages;
export function readAllMessages(...args: Parameters<typeof readMessages>): RoomMessage[] { return readMessages(...args).map(limitRuntimeFailureRoomMessage); }

export interface SearchOptions {
  query?: string;    // case-insensitive substring on content
  from?: string;     // recorded sender label (exact match)
  fromMemberId?: string; // stable sender identity, independent of name snapshots
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

export function searchMessages(...args: Parameters<typeof searchMessageFacts>): SearchResult { const result=searchMessageFacts(...args); return {...result,messages:result.messages.map(limitRuntimeFailureRoomMessage)}; }
