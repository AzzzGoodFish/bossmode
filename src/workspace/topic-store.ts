/**
 * Topic storage — room-owned sub-conversations (plan-topic-threads-v1 batch 1).
 * Path: rooms/<roomId>/topics/<topicId>/topic.json + messages.jsonl + .topic-seq
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir, getRoomsDir, getRoom } from "./room-store.js";
import type { Room } from "../shared/types.js";
import { getBossmodeDir } from "../shared/config.js";
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

export function topicDir(roomId: string, topicId: string): string {
  return join(topicsRoot(roomId), topicId);
}

/** Parent room uuid for a topic: scope or bare topic id. Other scopes pass through. */
export function resolveOwningRoomId(roomIdOrScope: string): string {
  if (typeof roomIdOrScope === "string" && roomIdOrScope.startsWith("topic:")) {
    const parent = resolveTopicRoomId(roomIdOrScope.slice("topic:".length));
    if (parent) return parent;
  }
  if (typeof roomIdOrScope === "string" && roomIdOrScope.startsWith("room:")) {
    return roomIdOrScope.slice("room:".length);
  }
  return roomIdOrScope;
}

/** Parent room uuid for room-owned assets (roster, attachments, tasks, principles). DM → null. */
export function resolveChatScopeRoomId(scopeOrRoomId: string): string | null {
  if (typeof scopeOrRoomId === "string" && scopeOrRoomId.startsWith("dm:")) return null;
  const id = resolveOwningRoomId(scopeOrRoomId);
  if (!id || id.startsWith("topic:") || id.startsWith("dm:")) return null;
  return id;
}

export function resolveChatScopeRoom(scopeOrRoomId: string): Room | null {
  const id = resolveChatScopeRoomId(scopeOrRoomId);
  return id ? getRoom(id) : null;
}

function topicCursorsPath(roomId: string, topicId: string): string {
  return join(ensureTopicDir(roomId, topicId), "cursors.json");
}

export function getTopicCursors(roomId: string, topicId: string): Record<string, string | null> {
  const path = topicCursorsPath(roomId, topicId);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string | null>;
  } catch {
    return {};
  }
}

export function setTopicCursor(roomId: string, topicId: string, memberRef: string, cursor: string | null): void {
  const cursors = getTopicCursors(roomId, topicId);
  cursors[memberRef] = cursor;
  writeFileSync(topicCursorsPath(roomId, topicId), JSON.stringify(cursors, null, 2), "utf-8");
}

export function getTopicMessagesSince(roomId: string, topicId: string, cursorId: string | null): RoomMessage[] {
  const all = readAllTopicMessages(roomId, topicId);
  if (!cursorId) return all;
  const idx = all.findIndex((m) => m.id === cursorId);
  if (idx === -1) return all;
  return all.slice(idx + 1);
}

/** Event history dir: topic events live under the parent room, never rooms/topic:<id>/. */
export function agentEventsDirForScope(roomIdOrScope: string): string {
  if (typeof roomIdOrScope === "string" && roomIdOrScope.startsWith("topic:")) {
    const topicId = roomIdOrScope.slice("topic:".length);
    const parent = resolveTopicRoomId(topicId);
    if (parent) return join(topicDir(parent, topicId), "agent-events");
  }
  return join(getBossmodeDir(), "rooms", roomIdOrScope, "agent-events");
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

/** First meaningful line, @mentions stripped — used when create API omits title. */
export function titleFromMessage(content: string, max = 80): string {
  const stripped = String(content || "").replace(/^(?:[@!]\S+\s*)+/, "");
  const line = stripped.split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() || "";
  return line.slice(0, max);
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
    seedMode: input.seedMode === "fresh" ? "fresh" : "fork",
    participants: [],
    ...(input.guideText ? { guideText: input.guideText } : {}),
    ...(input.anchorExcerpt ? { anchorExcerpt: normalizeAnchorExcerpt(input.anchorExcerpt) } : {}),
  };
  saveTopic(topic);
  logger.info("topic", "created", { roomId: topic.roomId, topicId: topic.id, seedMode: topic.seedMode });
  return topic;
}

/** Extractive close summary from the topic stream (no LLM — close must not block). */
export function summarizeTopicMessages(messages: RoomMessage[], maxChars = 400): string {
  const usable = messages.filter((m) => m.sender !== "system" && String(m.content || "").trim());
  if (usable.length === 0) return "No discussion was recorded in this topic.";
  const parts: string[] = [];
  const take = usable.length <= 4 ? usable : [usable[0], usable[1], usable[usable.length - 2], usable[usable.length - 1]];
  const seen = new Set<string>();
  for (const m of take) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const who = m.sender === "user" ? "you" : m.sender;
    const line = String(m.content).replace(/\s+/g, " ").trim().slice(0, 140);
    if (line) parts.push(`${who}: ${line}`);
  }
  const n = usable.length;
  const head = n === 1 ? "1 message" : `${n} messages`;
  const body = parts.join(" · ");
  const out = `${head}. ${body}`;
  return out.length > maxChars ? out.slice(0, maxChars - 1) + "…" : out;
}

export function closeTopic(roomId: string, topicId: string, summary?: string): TopicRecord | null {
  const t = getTopic(roomId, topicId);
  if (!t) return null;
  if (t.status === "closed") return t;
  const messages = readAllTopicMessages(roomId, topicId);
  t.status = "closed";
  t.closedAt = Date.now();
  t.summary = (summary && summary.trim()) || summarizeTopicMessages(messages);
  saveTopic(t);
  logger.info("topic", "closed", { roomId, topicId, summaryChars: t.summary.length });
  return t;
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
    `Concurrency: this topic runs in parallel with the main room and other topics. Other instances of you may be working elsewhere right now. Shared state is contested — the main checkout, the main branch, release packaging, global installs. Before mainline mutations (merging main, cutting packages, global changes), check whether another instance of you is mid-action; if so, coordinate in the room or defer. Topic-local work (your own branch, your own worktree, this topic's stream) needs no such care.`,
  ].join("\n");
}
