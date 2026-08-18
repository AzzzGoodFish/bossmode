/**
 * Topic storage — room-owned sub-conversations (plan-topic-threads-v1 batch 1).
 * Path: rooms/<roomId>/topics/<topicId>/topic.json + messages.jsonl + .topic-seq
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir, getRoomsDir } from "./room-store.js";
import { parseJsonlLines } from "../shared/jsonl.js";
import type { RoomMessage } from "../shared/types.js";
import { limitRuntimeFailureRoomMessage } from "../shared/runtime-error-limit.js";
import { logger } from "../foundation/logger.js";

export type TopicStatus = "active" | "closed";
export type TopicSeedMode = "fork" | "fresh";

export interface TopicRecord {
  id: string;
  roomId: string;
  title: string;
  anchorMessageId: string;
  anchorSeq?: number;
  createdBy: "user";
  status: TopicStatus;
  createdAt: number;
  closedAt?: number;
  seedMode: TopicSeedMode;
  summary?: string;
  /** Members activated inside this topic. */
  participants: string[];
  /** Pre-generated guide blurb (English) shared by all members entering the topic. */
  guideText?: string;
  /** Normalized first 80 chars of the anchor message — used to locate the fork leaf. */
  anchorExcerpt?: string;
}

/** Normalize + clip an anchor message for fork leaf matching (plan §2.2). */
export function normalizeAnchorExcerpt(content: string, max = 80): string {
  return String(content || "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function topicsRoot(roomId: string): string {
  return join(roomDir(roomId), "topics");
}

function topicDir(roomId: string, topicId: string): string {
  return join(topicsRoot(roomId), topicId);
}

function ensureTopicDir(roomId: string, topicId: string): string {
  const dir = topicDir(roomId, topicId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function topicJsonPath(roomId: string, topicId: string): string {
  return join(topicDir(roomId, topicId), "topic.json");
}

function messagesPath(roomId: string, topicId: string): string {
  return join(ensureTopicDir(roomId, topicId), "messages.jsonl");
}

function seqPath(roomId: string, topicId: string): string {
  return join(ensureTopicDir(roomId, topicId), ".topic-seq");
}

/** In-memory reverse index topicId → roomId (rebuilt lazily from disk). */
const topicRoomIndex = new Map<string, string>();

function indexTopic(topic: TopicRecord): void {
  topicRoomIndex.set(topic.id, topic.roomId);
}

export function resolveTopicRoomId(topicId: string): string | null {
  if (topicRoomIndex.has(topicId)) return topicRoomIndex.get(topicId)!;
  // Slow path: scan rooms/*/topics/
  try {
    const roomsRoot = getRoomsDir();
    if (!existsSync(roomsRoot)) return null;
    for (const roomId of readdirSync(roomsRoot)) {
      const tPath = join(roomsRoot, roomId, "topics", topicId, "topic.json");
      if (existsSync(tPath)) {
        topicRoomIndex.set(topicId, roomId);
        return roomId;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function getTopic(roomId: string, topicId: string): TopicRecord | null {
  const path = topicJsonPath(roomId, topicId);
  if (!existsSync(path)) return null;
  try {
    const t = JSON.parse(readFileSync(path, "utf-8")) as TopicRecord;
    indexTopic(t);
    return t;
  } catch (err) {
    logger.error("topic", "failed to read topic.json", { roomId, topicId, error: String(err) });
    return null;
  }
}

export function getTopicById(topicId: string): TopicRecord | null {
  const roomId = resolveTopicRoomId(topicId);
  if (!roomId) return null;
  return getTopic(roomId, topicId);
}

export function saveTopic(topic: TopicRecord): void {
  ensureTopicDir(topic.roomId, topic.id);
  writeFileSync(topicJsonPath(topic.roomId, topic.id), JSON.stringify(topic, null, 2) + "\n", "utf-8");
  indexTopic(topic);
}

export function listTopics(roomId: string, opts?: { status?: TopicStatus }): TopicRecord[] {
  const root = topicsRoot(roomId);
  if (!existsSync(root)) return [];
  const out: TopicRecord[] = [];
  for (const name of readdirSync(root)) {
    const t = getTopic(roomId, name);
    if (!t) continue;
    if (opts?.status && t.status !== opts.status) continue;
    out.push(t);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export interface CreateTopicInput {
  roomId: string;
  title: string;
  anchorMessageId: string;
  anchorSeq?: number;
  seedMode?: TopicSeedMode;
  guideText?: string;
  anchorExcerpt?: string;
}

export function createTopic(input: CreateTopicInput): TopicRecord {
  const id = `topic_${randomUUID().slice(0, 8)}`;
  const topic: TopicRecord = {
    id,
    roomId: input.roomId,
    title: String(input.title || "").trim() || "Untitled topic",
    anchorMessageId: input.anchorMessageId,
    anchorSeq: input.anchorSeq,
    createdBy: "user",
    status: "active",
    createdAt: Date.now(),
    seedMode: input.seedMode === "fork" ? "fork" : "fresh",
    participants: [],
    ...(input.guideText ? { guideText: input.guideText } : {}),
    ...(input.anchorExcerpt ? { anchorExcerpt: normalizeAnchorExcerpt(input.anchorExcerpt) } : {}),
  };
  saveTopic(topic);
  logger.info("topic", "created", { roomId: topic.roomId, topicId: topic.id, seedMode: topic.seedMode });
  return topic;
}

export function addTopicParticipant(roomId: string, topicId: string, memberId: string): void {
  const t = getTopic(roomId, topicId);
  if (!t) return;
  if (t.participants.includes(memberId)) return;
  t.participants = [...t.participants, memberId];
  saveTopic(t);
}

function readNextSeq(roomId: string, topicId: string): number {
  const path = seqPath(roomId, topicId);
  if (existsSync(path)) {
    try {
      const n = parseInt(readFileSync(path, "utf-8").trim(), 10);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* fall through */ }
  }
  let max = 0;
  for (const m of readAllTopicMessages(roomId, topicId)) {
    if (typeof m.seq === "number" && m.seq > max) max = m.seq;
  }
  return max + 1;
}

export function readAllTopicMessages(roomId: string, topicId: string): RoomMessage[] {
  const path = join(topicDir(roomId, topicId), "messages.jsonl");
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  return parseJsonlLines<RoomMessage>(content, {
    category: "topic-message-store",
    context: { roomId, topicId },
    map: (value) => limitRuntimeFailureRoomMessage(value as RoomMessage),
  });
}

export function addTopicMessage(
  roomId: string,
  topicId: string,
  msg: Omit<RoomMessage, "id" | "ts" | "seq">,
): RoomMessage {
  const bounded = limitRuntimeFailureRoomMessage(msg as RoomMessage);
  const seq = readNextSeq(roomId, topicId);
  const message: RoomMessage = {
    ...bounded,
    id: `msg-${randomUUID().slice(0, 8)}`,
    seq,
    ts: Date.now(),
  };
  appendFileSync(messagesPath(roomId, topicId), JSON.stringify(message) + "\n", "utf-8");
  writeFileSync(seqPath(roomId, topicId), String(seq + 1), "utf-8");
  return message;
}

export function getLatestTopicMessageId(roomId: string, topicId: string): string | null {
  const all = readAllTopicMessages(roomId, topicId);
  if (all.length === 0) return null;
  return all[all.length - 1].id;
}

/** Build English guide text for topic entry (batch 1: truncate anchor; summarizer in batch 2). */
export function buildTopicGuideText(args: {
  title: string;
  roomName: string;
  roomId: string;
  anchorExcerpt: string;
  seedMode: TopicSeedMode;
  prefixSummary?: string;
}): string {
  const excerpt = String(args.anchorExcerpt || "").replace(/\s+/g, " ").trim().slice(0, 280);
  const progress =
    args.prefixSummary && args.prefixSummary.trim()
      ? args.prefixSummary.trim()
      : args.seedMode === "fresh"
        ? "(fresh session — background is this guide only; room history is available via query tools)"
        : "(forked room prefix — see session history; room stream via query tools)";
  return [
    `[Topic guide] Title: ${args.title} | Anchor: ${excerpt || "(empty)"}`,
    `Room progress before this topic: ${progress}`,
    `Scope of work: discuss and deliver within this topic thread.`,
    `This topic belongs to room "${args.roomName}" (scope: room:${args.roomId}) — query the main stream via query_room_messages(scope="room:${args.roomId}").`,
  ].join("\n");
}
