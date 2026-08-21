import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir } from "./room-store.js";
import type { RoomMessage } from "../shared/types.js";
import { limitRuntimeFailureRoomMessage } from "../shared/runtime-error-limit.js";
import { parseJsonlLines } from "../shared/jsonl.js";
import { invalidateJsonlCache, readJsonlCached } from "./jsonl-file-cache.js";

function parseRoomMessages(content: string, roomId: string): RoomMessage[] {
  if (!content.trim()) return [];
  return parseJsonlLines<RoomMessage>(content, {
    category: "message-store",
    context: { roomId },
    map: (value) => limitRuntimeFailureRoomMessage(value as RoomMessage),
  });
}

function messagesPath(roomId: string): string {
  return join(roomDir(roomId), "messages.jsonl");
}

function seqPath(roomId: string): string {
  return join(roomDir(roomId), ".seq");
}

function readNextSeq(roomId: string): number {
  const path = seqPath(roomId);
  if (existsSync(path)) {
    try {
      const n = parseInt(readFileSync(path, "utf-8").trim(), 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch {}
  }
  // Cold start / legacy room: derive from the highest seq already present in messages.jsonl.
  let max = 0;
  for (const m of readAllMessages(roomId)) {
    if (typeof m.seq === "number" && m.seq > max) max = m.seq;
  }
  return max + 1;
}

function writeNextSeq(roomId: string, next: number): void {
  writeFileSync(seqPath(roomId), String(next), "utf-8");
}

// 2a: spread to propagate all fields (type, task_event_meta, etc.)
export function addMessage(roomId: string, msg: Omit<RoomMessage, "id" | "ts">): RoomMessage {
  const bounded = limitRuntimeFailureRoomMessage(msg);
  const seq = readNextSeq(roomId);
  const message: RoomMessage = {
    ...bounded,
    id: `msg-${randomUUID().slice(0, 8)}`,
    seq,
    ts: Date.now(),
  };

  const path = messagesPath(roomId);
  appendFileSync(path, JSON.stringify(message) + "\n", "utf-8");
  invalidateJsonlCache(path);
  writeNextSeq(roomId, seq + 1);
  return message;
}

// 2c: getMessages
export function getMessages(roomId: string, opts?: { limit?: number; before?: string; around?: string; fromSeq?: number }): RoomMessage[] {
  let messages: RoomMessage[] = readAllMessages(roomId);
  if (messages.length === 0) return [];

  // Around: return a window centered on the target message
  if (opts?.around) {
    const idx = messages.findIndex((m) => m.id === opts.around);
    if (idx === -1) return [];
    const total = opts?.limit || 30;
    const before = Math.floor((total - 1) / 2);
    const start = Math.max(0, idx - before);
    const end = Math.min(messages.length, start + total);
    return messages.slice(start, end);
  }

  // Filter: messages before a given ID
  if (opts?.before) {
    const idx = messages.findIndex((m) => m.id === opts.before);
    if (idx > 0) {
      messages = messages.slice(0, idx);
    }
  }

  // From-seq: messages strictly after the given seq (ascending backlog reads)
  if (opts?.fromSeq !== undefined) {
    const fsq = opts.fromSeq;
    const idx = messages.findIndex((m) => (m as { seq?: number }).seq !== undefined && (m as { seq?: number }).seq! > fsq!);
    if (idx === -1) return [];
    messages = messages.slice(idx);
  }

  // Limit: return last N messages
  const limit = opts?.limit || 100;
  if (messages.length > limit) {
    messages = messages.slice(-limit);
  }

  return messages;
}

// 2c: getMessagesSince with merge
export function getMessagesSince(roomId: string, cursorId: string | null): RoomMessage[] {
  const messages = readAllMessages(roomId);
  if (messages.length === 0) return [];

  if (!cursorId) return messages;

  const idx = messages.findIndex((m) => m.id === cursorId);
  // Cursor not found → return all (agent-manager contextLimit truncates)
  if (idx === -1) return messages;
  return messages.slice(idx + 1);
}

export function getLatestMessageId(roomId: string): string | null {
  const messages = readAllMessages(roomId);
  if (messages.length === 0) return null;
  // Prefer last with id (parse already dropped corrupt lines).
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.id) return messages[i].id;
  }
  return null;
}

// Used by archive-store: overwrite messages file with kept messages
/** Patch one persisted message in place (used to flip a topic opened card to closed). */
export function updateMessage(
  roomId: string,
  messageId: string,
  patch: Partial<RoomMessage>,
): RoomMessage | null {
  const all = readAllMessages(roomId);
  const idx = all.findIndex((m) => m.id === messageId);
  if (idx < 0) return null;
  const next = { ...all[idx], ...patch, id: all[idx].id, seq: all[idx].seq, ts: all[idx].ts };
  all[idx] = next;
  overwriteMessages(roomId, all);
  return next;
}

export function overwriteMessages(roomId: string, messages: RoomMessage[]): void {
  const path = messagesPath(roomId);
  writeFileSync(path, messages.map((m) => JSON.stringify(limitRuntimeFailureRoomMessage(m))).join("\n") + "\n", "utf-8");
  invalidateJsonlCache(path);
}

// Read all raw messages (no merge) — single cache entry for the room file.
export function readAllMessages(roomId: string): RoomMessage[] {
  const path = messagesPath(roomId);
  return readJsonlCached(path, (content) => parseRoomMessages(content, roomId), []);
}

// -- Message search --

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

export function searchMessages(roomId: string, opts: SearchOptions = {}): SearchResult {
  const all = readAllMessages(roomId);

  // aroundSeq: window centered on the target seq (bypasses the other filters).
  if (opts.aroundSeq !== undefined) {
    const idx = all.findIndex((m) => m.seq === opts.aroundSeq);
    if (idx === -1) return { total: 0, messages: [] };
    const total = Math.max(1, Math.min(opts.limit ?? 30, 500));
    const before = Math.floor((total - 1) / 2);
    const start = Math.max(0, idx - before);
    const end = Math.min(all.length, start + total);
    return { total: 1, messages: all.slice(start, end) };
  }

  const q = opts.query?.toLowerCase();

  const filtered = all.filter((m) => {
    if (q && !m.content.toLowerCase().includes(q)) return false;
    if (opts.from && m.sender !== opts.from) return false;
    if (opts.after !== undefined && m.ts < opts.after) return false;
    if (opts.before !== undefined && m.ts >= opts.before) return false;
    if (opts.type && m.type !== opts.type) return false;
    return true;
  });

  // Newest first for UI/agent priority
  filtered.sort((a, b) => b.ts - a.ts);

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const offset = Math.max(0, opts.offset ?? 0);

  return {
    total: filtered.length,
    messages: filtered.slice(offset, offset + limit),
  };
}
