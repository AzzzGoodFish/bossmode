import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir } from "./room-store.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage } from "../shared/types.js";

function messagesPath(roomId: string): string {
  return join(roomDir(roomId), "messages.jsonl");
}

// 2a: spread to propagate all fields (type, summary_meta, etc.)
export function addMessage(roomId: string, msg: Omit<RoomMessage, "id" | "ts">): RoomMessage {
  const message: RoomMessage = {
    ...msg,
    id: `msg-${randomUUID().slice(0, 8)}`,
    ts: Date.now(),
  };

  const path = messagesPath(roomId);
  appendFileSync(path, JSON.stringify(message) + "\n", "utf-8");
  return message;
}

// 2b: Core merge — summaries replace the messages they cover
export function mergeWithSummaries(messages: RoomMessage[]): RoomMessage[] {
  // Collect all summary messages and the ranges they cover
  const summaries = messages.filter((m) => m.type === "summary" && m.summary_meta);
  if (summaries.length === 0) return messages;

  // Build a set of message IDs covered by summaries
  const coveredIds = new Set<string>();
  const summaryInsertions: { fromId: string; summary: RoomMessage }[] = [];

  for (const summary of summaries) {
    const meta = summary.summary_meta!;
    const fromIdx = messages.findIndex((m) => m.id === meta.covered_range.from_id);
    const toIdx = messages.findIndex((m) => m.id === meta.covered_range.to_id);
    if (fromIdx === -1 || toIdx === -1) continue;

    // Mark all messages in range as covered (including from and to)
    for (let i = fromIdx; i <= toIdx; i++) {
      if (messages[i].type !== "summary") {
        coveredIds.add(messages[i].id);
      }
    }
    summaryInsertions.push({ fromId: meta.covered_range.from_id, summary });
  }

  // Build merged result: replace covered ranges with summaries
  const result: RoomMessage[] = [];
  const insertedSummaryIds = new Set<string>();

  for (const msg of messages) {
    // Skip the summary messages from their original position (they'll be inserted at from_id)
    if (msg.type === "summary") continue;

    // Check if this message is the start of a covered range
    for (const ins of summaryInsertions) {
      if (ins.fromId === msg.id && !insertedSummaryIds.has(ins.summary.id)) {
        result.push(ins.summary);
        insertedSummaryIds.add(ins.summary.id);
      }
    }

    // Skip covered messages
    if (coveredIds.has(msg.id)) continue;

    result.push(msg);
  }

  return result;
}

// 2c: getMessages with merge
export function getMessages(roomId: string, opts?: { limit?: number; before?: string }): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];

  let messages: RoomMessage[] = content.split("\n").map((line) => JSON.parse(line));

  // Merge summaries before pagination
  messages = mergeWithSummaries(messages);

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

// 2c: getMessagesSince with merge
export function getMessagesSince(roomId: string, cursorId: string | null): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];

  const raw: RoomMessage[] = content.split("\n").map((line) => JSON.parse(line));
  const messages = mergeWithSummaries(raw);

  if (!cursorId) return messages;

  const idx = messages.findIndex((m) => m.id === cursorId);
  // Cursor not in merged → return all merged (agent-manager contextLimit truncates)
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
  } catch (err) {
    logger.error("message-store", "failed to parse last message", { roomId, error: String(err) });
    return null;
  }
}

// Used by archive-store: overwrite messages file with kept messages
export function overwriteMessages(roomId: string, messages: RoomMessage[]): void {
  const path = messagesPath(roomId);
  writeFileSync(path, messages.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");
}

// Read all raw messages (no merge)
export function readAllMessages(roomId: string): RoomMessage[] {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

// 2d: Get raw messages in a range (for expanding summaries — no merge)
export function getMessagesByRange(roomId: string, fromId: string, toId: string): RoomMessage[] {
  const all = readAllMessages(roomId);
  const fromIdx = all.findIndex((m) => m.id === fromId);
  const toIdx = all.findIndex((m) => m.id === toId);
  if (fromIdx === -1 || toIdx === -1) return [];
  return all.slice(fromIdx, toIdx + 1).filter((m) => m.type !== "summary");
}

// 2e: Get unsummarized messages (for summarizer), excluding latest keepCount
export function getUnsummarizedMessages(roomId: string, keepCount: number): RoomMessage[] {
  const all = readAllMessages(roomId);

  // Find the last summary's to_id to know where summarized content ends
  let lastSummarizedIdx = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].type === "summary" && all[i].summary_meta) {
      const toIdx = all.findIndex((m) => m.id === all[i].summary_meta!.covered_range.to_id);
      if (toIdx > lastSummarizedIdx) {
        lastSummarizedIdx = toIdx;
      }
    }
  }

  // Get only non-summary messages after the last summarized point
  const unsummarized = all
    .slice(lastSummarizedIdx + 1)
    .filter((m) => m.type !== "summary" && m.sender !== "system");

  // Exclude the latest keepCount messages
  if (unsummarized.length <= keepCount) return [];
  return unsummarized.slice(0, unsummarized.length - keepCount);
}
