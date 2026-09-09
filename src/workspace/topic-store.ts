/**
 * Topic metadata is normalized SQLite authority.
 * Message and member-cursor delegates share the initialized core database.
 */
import { limitRuntimeFailureRoomMessage } from "../shared/runtime-error-limit.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir, getRoom } from "./room-store.js";
import type { Room } from "../shared/types.js";
import type { RoomMessage } from "../shared/types.js";
import { ConversationsRepository } from "../storage/repositories/conversations.js";
import { appendMessage, readMessages, messagesSince, latestMessage, readMemberCursors, writeMemberCursor } from "../storage/message-repository.js";
import { getDatabase } from "../storage/database.js";
import { logger } from "../foundation/logger.js";

export type TopicStatus = "active" | "closed";
export type TopicSeedMode = "fork" | "fresh";

export interface TopicRecord {
  id: string;
  roomId: string;
  title: string;
  anchorMessageId: string;
  anchorSeq?: number;
  createdBy: string;
  status: TopicStatus;
  createdAt: number;
  closedAt?: number;
  seedMode: TopicSeedMode;
  summary?: string;
  /** Optional leader brief injected into the topic guide (user-message layer). */
  brief?: string;
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

function ownedTopicScope(roomId: string, topicId: string): string {
  if (!getTopic(roomId, topicId)) throw new Error("Topic does not belong to the supplied room");
  return `topic:${topicId}`;
}

export function getTopicCursors(roomId: string, topicId: string): Record<string, string | null> {
  return readMemberCursors(ownedTopicScope(roomId, topicId));
}
export function setTopicCursor(roomId: string, topicId: string, memberRef: string, cursor: string | null): void {
  getDatabase().transaction(() => writeMemberCursor(ownedTopicScope(roomId, topicId), memberRef, cursor));
}
export function getTopicMessagesSince(roomId: string, topicId: string, cursorId: string | null): RoomMessage[] {
  return messagesSince(ownedTopicScope(roomId, topicId), cursorId).map(limitRuntimeFailureRoomMessage);
}

export function resolveTopicRoomId(topicId: string): string | null {
  return new ConversationsRepository().resolveTopicRoomId(topicId);
}

export function getTopic(roomId: string, topicId: string): TopicRecord | null {
  return new ConversationsRepository().getTopic(roomId, topicId);
}

export function getTopicById(topicId: string): TopicRecord | null {
  const roomId = resolveTopicRoomId(topicId);
  if (!roomId) return null;
  return getTopic(roomId, topicId);
}

export function saveTopic(topic: TopicRecord): void {
  new ConversationsRepository().upsertTopic(topic);
}

export function listTopics(roomId: string, opts?: { status?: TopicStatus }): TopicRecord[] {
  return new ConversationsRepository().listTopics(roomId, opts?.status);
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
  createdBy?: string;
  brief?: string;
}

export function createTopic(input: CreateTopicInput): TopicRecord {
  const id = `topic_${randomUUID().slice(0, 8)}`;
  const topic: TopicRecord = {
    id,
    roomId: input.roomId,
    title: String(input.title || "").trim() || "Untitled topic",
    anchorMessageId: input.anchorMessageId,
    anchorSeq: input.anchorSeq,
    createdBy: (input.createdBy || "user").trim() || "user",
    status: "active",
    createdAt: Date.now(),
    seedMode: input.seedMode === "fresh" ? "fresh" : "fork",
    participants: [],
    ...(input.guideText ? { guideText: input.guideText } : {}),
    ...(input.anchorExcerpt ? { anchorExcerpt: normalizeAnchorExcerpt(input.anchorExcerpt) } : {}),
    ...(input.brief?.trim() ? { brief: input.brief.trim() } : {}),
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
  return getDatabase().transaction(() => {
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
  });
}

export function addTopicParticipant(roomId: string, topicId: string, memberId: string): void {
  getDatabase().transaction(() => {
    const t = getTopic(roomId, topicId);
    if (!t) return;
    if (t.participants.includes(memberId)) return;
    t.participants = [...t.participants, memberId];
    saveTopic(t);
  });
}

export function readAllTopicMessages(roomId: string, topicId: string): RoomMessage[] {
  return readMessages(ownedTopicScope(roomId, topicId)).map(limitRuntimeFailureRoomMessage);
}
export function addTopicMessage(roomId: string, topicId: string, msg: Omit<RoomMessage, "id" | "ts" | "seq">): RoomMessage {
  return getDatabase().transaction(() => appendMessage(ownedTopicScope(roomId, topicId), msg));
}
export function getLatestTopicMessageId(roomId: string, topicId: string): string | null {
  return latestMessage(ownedTopicScope(roomId, topicId))?.id ?? null;
}

/** Build English guide text for topic entry (batch 1: truncate anchor; summarizer in batch 2). */
export function buildTopicGuideText(args: {
  title: string;
  roomName: string;
  roomId: string;
  anchorExcerpt: string;
  seedMode: TopicSeedMode;
  prefixSummary?: string;
  brief?: string;
  briefBy?: string;
}): string {
  const excerpt = String(args.anchorExcerpt || "").replace(/\s+/g, " ").trim().slice(0, 280);
  const progress =
    args.prefixSummary && args.prefixSummary.trim()
      ? args.prefixSummary.trim()
      : args.seedMode === "fresh"
        ? "(fresh session — background is this guide only; room history is available via query tools)"
        : "(forked room prefix — see session history; room stream via query tools)";
  const brief = (args.brief || "").trim();
  return [
    `[Topic guide] Title: ${args.title} | Anchor: ${excerpt || "(empty)"}`,
    `Room progress before this topic: ${progress}`,
    `Scope of work: discuss and deliver within this topic thread.`,
    `This topic belongs to room "${args.roomName}" (scope: room:${args.roomId}) — query the main stream via query_room_messages(scope="room:${args.roomId}").`,
    ...(brief ? [`Topic brief (set by ${args.briefBy || "leader"}): ${brief}`] : []),
    `Concurrency: this topic runs in parallel with the main room and other topics. Other instances of you may be working elsewhere right now. Shared state is contested — the main checkout, the main branch, release packaging, global installs. Before mainline mutations (merging main, cutting packages, global changes), check whether another instance of you is mid-action; if so, coordinate in the room or defer. Topic-local work (your own branch, your own worktree, this topic's stream) needs no such care.`,
  ].join("\n");
}
