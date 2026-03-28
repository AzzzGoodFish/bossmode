import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir } from "./room-store.js";
import type { RoomMessage } from "../shared/types.js";

function messagesPath(roomId: string): string {
  return join(roomDir(roomId), "messages.jsonl");
}

export function addMessage(roomId: string, msg: Omit<RoomMessage, "id" | "ts">): RoomMessage {
  const message: RoomMessage = {
    id: `msg-${randomUUID().slice(0, 8)}`,
    sender: msg.sender,
    content: msg.content,
    mentions: msg.mentions,
    ts: Date.now(),
  };

  const path = messagesPath(roomId);
  appendFileSync(path, JSON.stringify(message) + "\n", "utf-8");
  return message;
}

export function getMessages(roomId: string, opts?: { limit?: number; before?: string }): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];

  let messages: RoomMessage[] = content.split("\n").map((line) => JSON.parse(line));

  // Filter: messages before a given ID
  if (opts?.before) {
    const idx = messages.findIndex((m) => m.id === opts.before);
    if (idx > 0) {
      messages = messages.slice(0, idx);
    }
  }

  // Limit: return last N messages
  const limit = opts?.limit || 100;
  if (messages.length > limit) {
    messages = messages.slice(-limit);
  }

  return messages;
}

export function getMessagesSince(roomId: string, cursorId: string | null): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];

  const messages: RoomMessage[] = content.split("\n").map((line) => JSON.parse(line));

  if (!cursorId) return messages;

  const idx = messages.findIndex((m) => m.id === cursorId);
  if (idx === -1) return messages;
  return messages.slice(idx + 1);
}

export function getLatestMessageId(roomId: string): string | null {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return null;

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return null;

  const lines = content.split("\n");
  const lastLine = lines[lines.length - 1];
  try {
    const msg = JSON.parse(lastLine) as RoomMessage;
    return msg.id;
  } catch {
    return null;
  }
}

// Used by archive-store: overwrite messages file with kept messages
export function overwriteMessages(roomId: string, messages: RoomMessage[]): void {
  const path = messagesPath(roomId);
  writeFileSync(path, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");
}

// Used by archive-store: read all messages as array
export function readAllMessages(roomId: string): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}
