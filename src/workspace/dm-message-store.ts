/**
 * DM message storage — member-owned jsonl, same message shape as room messages.
 * Path: members/<mem_id>/dm-messages.jsonl + dm-cursor.json + .dm-seq
 * Contract §2.1 / §6.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { memberDir } from "./member-registry.js";
import { parseJsonlLines } from "../shared/jsonl.js";
import type { RoomMessage } from "../shared/types.js";
import { limitRuntimeFailureRoomMessage } from "../shared/runtime-error-limit.js";

function ensureDir(memberId: string): string {
  const dir = memberDir(memberId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function messagesPath(memberId: string): string {
  return join(ensureDir(memberId), "dm-messages.jsonl");
}

function seqPath(memberId: string): string {
  return join(ensureDir(memberId), ".dm-seq");
}

function cursorPath(memberId: string): string {
  return join(ensureDir(memberId), "dm-cursor.json");
}

function readNextSeq(memberId: string): number {
  const path = seqPath(memberId);
  if (existsSync(path)) {
    try {
      const n = parseInt(readFileSync(path, "utf-8").trim(), 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through */ }
  }
  let max = 0;
  for (const m of readAllDmMessages(memberId)) {
    if (typeof m.seq === "number" && m.seq > max) max = m.seq;
  }
  return max + 1;
}

export function readAllDmMessages(memberId: string): RoomMessage[] {
  const path = messagesPath(memberId);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  return parseJsonlLines<RoomMessage>(content, {
    category: "dm-message-store",
    context: { memberId },
    map: (value) => limitRuntimeFailureRoomMessage(value as RoomMessage),
  });
}

export function addDmMessage(
  memberId: string,
  msg: Omit<RoomMessage, "id" | "ts" | "seq">,
): RoomMessage {
  const bounded = limitRuntimeFailureRoomMessage(msg as RoomMessage);
  const seq = readNextSeq(memberId);
  const message: RoomMessage = {
    ...bounded,
    id: `msg-${randomUUID().slice(0, 8)}`,
    seq,
    ts: Date.now(),
  };
  appendFileSync(messagesPath(memberId), JSON.stringify(message) + "\n", "utf-8");
  writeFileSync(seqPath(memberId), String(seq + 1), "utf-8");
  return message;
}

/** Messages after a given seq (exclusive). */
export function getDmMessagesSince(memberId: string, afterSeq: number | null): RoomMessage[] {
  const all = readAllDmMessages(memberId);
  if (afterSeq == null) return all;
  return all.filter((m) => typeof m.seq === "number" && m.seq > afterSeq);
}

export function getLatestDmMessageId(memberId: string): string | null {
  const all = readAllDmMessages(memberId);
  if (all.length === 0) return null;
  return all[all.length - 1].id;
}

export function getLatestDmSeq(memberId: string): number | null {
  const all = readAllDmMessages(memberId);
  if (all.length === 0) return null;
  const last = all[all.length - 1];
  return typeof last.seq === "number" ? last.seq : null;
}

/** Single-value cursor for the DM conversation (member's read position). */
export function getDmCursor(memberId: string): { messageId: string | null; seq: number | null } {
  const path = cursorPath(memberId);
  if (!existsSync(path)) return { messageId: null, seq: null };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { messageId?: string | null; seq?: number | null };
    return { messageId: raw.messageId ?? null, seq: raw.seq ?? null };
  } catch {
    return { messageId: null, seq: null };
  }
}

export function setDmCursor(memberId: string, cursor: { messageId: string | null; seq: number | null }): void {
  writeFileSync(cursorPath(memberId), JSON.stringify(cursor) + "\n", "utf-8");
}
