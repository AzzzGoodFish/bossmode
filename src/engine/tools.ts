// Agent tool callback handler — business logic for chat/messages/summary tools
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { postMessage } from "../communication/message-bus.js";
import * as messageStore from "../workspace/message-store.js";
import * as roomStore from "../workspace/room-store.js";
import * as taskStore from "../workspace/task-store.js";
import * as principlesStore from "../workspace/principles-store.js";
import * as mainlineStore from "../workspace/mainline-store.js";
import { readMemoryLayerInfo, writeMemoryLayer, editMemoryLayer } from "../workspace/member-memory-store.js";
import { getMember } from "../workspace/member-registry.js";
import { assertMemberScopeAccess, listRoomsForMember } from "../workspace/scope-access.js";
import { readAllDmMessages } from "../workspace/dm-message-store.js";
import { resolveTopicRoomId, resolveOwningRoomId, resolveChatScopeRoomId, resolveChatScopeRoom, readAllTopicMessages, createTopic, saveTopic, buildTopicGuideText, titleFromMessage, normalizeAnchorExcerpt } from "../workspace/topic-store.js";
import { scopeIdOf, type ScopeId } from "../shared/conversation-ref.js";
import { getTopicSeedMode } from "../shared/config.js";
import { emitTaskEvent } from "../api/tasks.js";
import type { Task, TaskStatus, TaskPriority } from "../shared/types.js";
import { parseMentions, parseUrgentMentions, parseMentionMemberIds, parseUrgentMentionMemberIds } from "../communication/router.js";
import { isSystemNoticeHiddenFromMembers } from "../shared/runtime-error-limit.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage } from "../shared/types.js";
import { processAgentAttachments } from "./agent-attachments.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import { renderQueryRowsForMember, type QueryRow } from "./query-render.js";
import { displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../shared/attachments.js";

/** Max chars for tool result text. ~6K tokens, aligned with CLI output constraints. */
const MAX_RESULT_CHARS = 25_000;

/**
 * 0.20: tool `roomId` is the runtime scope key — a plain room id for room
 * scope, `dm:<memberId>` for DM scope. Member memory layers live in the
 * member-global store keyed by ScopeId (contract §6).
 */
function toolScopeId(roomId: string): ScopeId {
  // topic:<id> is already a full ScopeId; dm:<id> same; bare room uuid → room:<uuid>
  if (roomId.startsWith("dm:") || roomId.startsWith("topic:")) return roomId;
  return `room:${roomId}`;

}

function resolveMemoryActor(roomId: string, agentName: string): { id: string; name: string } | null {
  if (roomId.startsWith("dm:")) {
    const member = getMember(roomId.slice("dm:".length));
    return member ? { id: member.id, name: member.name } : null;
  }
  if (roomId.startsWith("topic:")) {
    // Resolve actor against the parent room membership.
    const parent = resolveTopicRoomId(roomId.slice("topic:".length));
    if (!parent) return null;
    return roomStore.resolveRoomMemberRef(parent, agentName);
  }
  return roomStore.resolveRoomMemberRef(roomId, agentName);
}

/**
 * Cross-scope read (0.20.0 flagship): resolve the optional `scope` parameter
 * of read tools to a target runtime scope key (plain room id or dm:<id>).
 * Default (absent/empty) = current scope. Anything else goes through the
 * shared membership check — failures return an explicit error, never a
 * silent fallback to the current scope.
 */
function resolveReadTarget(
  currentRoomId: string,
  actor: { id: string; name: string },
  scopeParam: unknown,
): { ok: true; roomId: string } | { ok: false; error: string } {
  if (scopeParam === undefined || scopeParam === null || String(scopeParam).trim() === "") return { ok: true, roomId: currentRoomId };
  const scopeId = String(scopeParam).trim();
  try {
    const access = assertMemberScopeAccess(actor.id, scopeId);
    if (access.kind === "dm") return { ok: true, roomId: `dm:${access.memberId}` };
    if (access.kind === "topic") return { ok: true, roomId: `topic:${access.topicId}` };
    return { ok: true, roomId: access.roomId };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Mention parse for outgoing member messages: @ and ! targets alike merge into
 * mentions/mentionMemberIds (unread/highlight/stats share one list); ! targets
 * are additionally snapshotted as urgentMentions/urgentMentionMemberIds so the
 * router can route them through the interrupt path. */
function mentionInfoFromText(message: string, roomMembers: Array<{ id: string; name: string }>): {
  mentions: string[];
  mentionMemberIds: string[];
  urgentMentions: string[];
  urgentMentionMemberIds: string[];
} {
  const names = roomMembers.map((member) => member.name);
  const byName = new Map(roomMembers.map((member) => [member.name, member.id]));
  const atNames = parseMentions(message, names);
  const urgentMentions = parseUrgentMentions(message, names);
  const mentions = [...new Set([...atNames, ...urgentMentions])];
  const toIds = (list: string[]) => list.map((name) => byName.get(name)).filter((id): id is string => Boolean(id));
  return { mentions, mentionMemberIds: toIds(mentions), urgentMentions, urgentMentionMemberIds: toIds(urgentMentions) };
}

// -- Final-text fallback delivery (chat need_response debt turn) --

/**
 * Deliver a member's text into the conversation (room or DM, same rule).
 * Room scope: mention scan + senderMemberId resolution + messageMeta, then
 * postMessage (mention activation handled by router listener). DM scope:
 * direct postMessage, no mention routing.
 * `opts.autoDelivered` marks a fallback-posted message (no chat call was made
 * on a debt turn) — persisted and queryable, not rendered in the UI.
 */
export function deliverMemberMessage(roomId: string, memberName: string, text: string, opts?: { autoDelivered?: boolean }): void {
  // 0.20 DM scope: single scope-routed egress (dm store + broadcast + listeners).
  if (typeof roomId === "string" && roomId.startsWith("dm:")) {
    postMessage(roomId, memberName, text, [], opts?.autoDelivered ? { autoDelivered: true } : undefined);
    logger.info("agent", "finalTextDelivered", { member: memberName, chars: text.length, autoDelivered: opts?.autoDelivered === true });
    return;
  }

  const rosterId = resolveChatScopeRoomId(roomId) || roomId;
  const room = resolveChatScopeRoom(roomId) || roomStore.getRoom(rosterId);
  const roomMembers = ("getRoomMembers" in roomStore ? (roomStore as any).getRoomMembers(rosterId) : undefined) || (room?.members || []).map((name: string) => ({ id: name, name, sourceAgent: name }));
  const senderMember = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(rosterId, memberName) : undefined;
  const info = room ? mentionInfoFromText(text, roomMembers) : { mentions: [], mentionMemberIds: [], urgentMentions: [], urgentMentionMemberIds: [] };

  // Room message via message-bus (writes + broadcasts + notifies listeners)
  // Mention activation is handled by router listener via message-bus.
  const meta = messageMeta({ senderMemberId: senderMember?.id, senderName: memberName, mentionMemberIds: info.mentionMemberIds, urgentMentions: info.urgentMentions, urgentMentionMemberIds: info.urgentMentionMemberIds, mentions: info.mentions, autoDelivered: opts?.autoDelivered });
  if (meta) postMessage(roomId, memberName, text, info.mentions, meta);
  else postMessage(roomId, memberName, text, info.mentions);
  logger.info("agent", "finalTextDelivered", { member: memberName, chars: text.length, autoDelivered: opts?.autoDelivered === true });
}

function resolveTaskAssignee(roomId: string, value: unknown): { name: string; memberId: string } | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const member = roomStore.resolveRoomMemberRef(roomId, raw);
  if (!member) throw new Error(`Assignee is not a room member: ${raw}`);
  return { name: member.name, memberId: member.id };
}

function resolveTaskSubscribers(roomId: string, values: unknown): { names: string[]; memberIds: string[] } | undefined {
  if (!Array.isArray(values)) return undefined;
  const members: Array<{ id: string; name: string }> = [];
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    const member = roomStore.resolveRoomMemberRef(roomId, raw);
    if (!member) throw new Error(`Subscriber is not a room member: ${raw}`);
    if (!members.some((entry) => entry.id === member.id)) members.push(member);
  }
  return { names: members.map((member) => member.name), memberIds: members.map((member) => member.id) };
}

function taskAssigneeMatches(roomId: string, task: Task, assigneeRef: string): boolean {
  const member = roomStore.resolveRoomMemberRef(roomId, assigneeRef);
  if (member) return task.assigneeMemberId === member.id || (!task.assigneeMemberId && task.assignee === member.name);
  return task.assignee === assigneeRef;
}

function messageMeta(meta: {
  attachments?: RoomMessageAttachment[];
  artifacts?: string[];
  senderMemberId?: string;
  senderName?: string;
  mentionMemberIds?: string[];
  urgentMentions?: string[];
  urgentMentionMemberIds?: string[];
  mentions?: string[];
  needResponse?: string[];
  autoDelivered?: boolean;
  replyTo?: { seq: number; messageId: string };
}) {
  const out: {
    attachments?: RoomMessageAttachment[];
    artifacts?: string[];
    senderMemberId?: string;
    mentionMemberIds?: string[];
    urgentMentions?: string[];
    urgentMentionMemberIds?: string[];
    needResponse?: string[];
    autoDelivered?: boolean;
    replyTo?: { seq: number; messageId: string };
  } = {};
  if (meta.attachments?.length) out.attachments = meta.attachments;
  if (meta.artifacts?.length) out.artifacts = meta.artifacts;
  if (meta.senderMemberId && meta.senderMemberId !== meta.senderName) out.senderMemberId = meta.senderMemberId;
  if (meta.mentionMemberIds?.length && meta.mentionMemberIds.join("\0") !== (meta.mentions || []).join("\0")) out.mentionMemberIds = meta.mentionMemberIds;
  if (meta.urgentMentions?.length) out.urgentMentions = meta.urgentMentions;
  if (meta.urgentMentionMemberIds?.length) out.urgentMentionMemberIds = meta.urgentMentionMemberIds;
  if (meta.needResponse?.length) out.needResponse = meta.needResponse;
  if (meta.autoDelivered) out.autoDelivered = true;
  if (meta.replyTo) out.replyTo = meta.replyTo;
  return Object.keys(out).length > 0 ? out : undefined;
}

const REPLY_TO_RE = /^msg:#(\d+)$/i;
const REPLY_EXCERPT_MAX = 200;

/** Parse chat reply_to (`msg:#<seq>`). Validates the target exists in the given scope. */
export function parseReplyToParam(
  raw: unknown,
  scopeMessages: RoomMessage[],
): { ok: true; replyTo: { seq: number; messageId: string } } | { ok: false; error: string } | { ok: true; replyTo: undefined } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, replyTo: undefined };
  if (typeof raw !== "string") return { ok: false, error: "reply_to must be a string like msg:#123" };
  const m = raw.trim().match(REPLY_TO_RE);
  if (!m) return { ok: false, error: "reply_to must match msg:#<seq> (e.g. msg:#42)" };
  const seq = Number(m[1]);
  if (!Number.isInteger(seq) || seq < 1) return { ok: false, error: `reply_to seq out of range: ${m[1]}` };
  const target = scopeMessages.find((msg) => msg.seq === seq);
  if (!target) return { ok: false, error: `reply_to target not found in current scope: msg:#${seq}` };
  return { ok: true, replyTo: { seq, messageId: target.id } };
}

export function excerptForReply(content: string, max = REPLY_EXCERPT_MAX): string {
  const oneLine = String(content || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/** Look up messages in the current conversation scope (room uuid / dm:<id> / topic:<id>). */
export function loadScopeMessages(scopeId: string): RoomMessage[] {
  if (scopeId.startsWith("dm:")) {
    return readAllDmMessages(scopeId.slice("dm:".length));
  }
  if (scopeId.startsWith("topic:")) {
    const topicId = scopeId.slice("topic:".length);
    const parent = resolveOwningRoomId(scopeId);
    if (!parent || parent.startsWith("topic:")) return [];
    return readAllTopicMessages(parent, topicId);
  }
  return messageStore.readAllMessages(scopeId);
}

/** In-memory filter for scopes without a query index (DM + topic). */
function filterMessagesInMemory(
  all: RoomMessage[],
  searchOpts: messageStore.SearchOptions,
  fromSeq: number | undefined,
  limit: number,
): RoomMessage[] {
  let msgs = all;
  if (searchOpts.query) {
    const q = searchOpts.query.toLowerCase();
    msgs = msgs.filter((m) => (m.content || "").toLowerCase().includes(q));
  }
  if (searchOpts.from) msgs = msgs.filter((m) => m.sender === searchOpts.from);
  if (searchOpts.after !== undefined) msgs = msgs.filter((m) => (m.ts ?? 0) >= (searchOpts.after as number));
  if (searchOpts.before !== undefined) msgs = msgs.filter((m) => (m.ts ?? 0) <= (searchOpts.before as number));
  if (searchOpts.type) msgs = msgs.filter((m) => (m as { type?: string }).type === searchOpts.type);
  if (fromSeq !== undefined) {
    return msgs.filter((m) => (m.seq ?? 0) > fromSeq).slice(0, limit);
  }
  if (searchOpts.aroundSeq !== undefined) {
    const center = msgs.findIndex((m) => m.seq === searchOpts.aroundSeq);
    if (center < 0) return [];
    const half = Math.floor(limit / 2);
    return msgs.slice(Math.max(0, center - half), center + half + 1);
  }
  return msgs.slice(-limit);
}

/** Parse chat need_response: string[] of member names. Invalid type → error string. */
export function parseNeedResponseParam(
  raw: unknown,
  roomMembers: Array<{ id: string; name: string }>,
  mentionedNames: string[],
  mentionedIds: string[],
): { ok: true; names: string[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, names: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "need_response must be an array of member names (e.g. [\"developer\"])" };
  }
  const mentionedNameSet = new Set(mentionedNames);
  const mentionedIdSet = new Set(mentionedIds);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      return { ok: false, error: "need_response entries must be non-empty member name strings" };
    }
    const ref = item.trim();
    const member = roomMembers.find((m) => m.name === ref || m.id === ref);
    if (!member) continue; // unknown name — ignore
    // Only @-mentioned members can carry debt (activation gate).
    if (!mentionedNameSet.has(member.name) && !mentionedIdSet.has(member.id)) continue;
    if (seen.has(member.name)) continue;
    seen.add(member.name);
    out.push(member.name);
  }
  return { ok: true, names: out };
}

/** Truncate a serialized tool result if it exceeds the limit. */
export function truncateToolResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const truncated = text.slice(0, MAX_RESULT_CHARS);
  return truncated + `\n\n--- Result truncated (${text.length} chars exceeded ${MAX_RESULT_CHARS} limit). Use a more specific query to get smaller results. ---`;
}

/** Handle a tool callback from an agent runtime */
export async function handleToolCallback(
  tool: string,
  roomId: string,
  agentName: string,
  params: Record<string, any>,
): Promise<unknown> {
  logger.info("callback", "tool-callback", { tool, room: roomId, agent: agentName });

  switch (tool) {
    case "chat": {
      const message = params?.message || "";

      const attachments: RoomMessageAttachment[] = [];
      // Process agent attachments (file paths → validate + copy → structured message metadata).
      // Absolute source/store paths are not written to room-visible message JSON.
      if (Array.isArray(params?.attachments) && params.attachments.length > 0) {
        const attachRoomId = resolveChatScopeRoomId(roomId) || roomId;
        const outcomes = await processAgentAttachments(attachRoomId, params.attachments.map(String));
        const errors: string[] = [];
        for (const o of outcomes) {
          if (o.ok) {
            const originalFilename = displayFilename(o.originalFilename);
            attachments.push({
              id: o.storedFilename,
              storedFilename: o.storedFilename,
              originalFilename,
              size: o.size,
              previewType: inferAttachmentPreviewType(o.storedFilename || originalFilename),
            });
          } else {
            errors.push(`${o.path}: ${o.error}`);
          }
        }
        if (errors.length > 0) {
          const errorMsg = errors.join("; ");
          return { ok: false, error: `Attachment failed: ${errorMsg}` };
        }
      }

      // Resolve reply_to against the current conversation scope (room or dm).
      const scopeMessages = loadScopeMessages(roomId);
      const parsedReply = parseReplyToParam(params?.reply_to, scopeMessages);
      if (!parsedReply.ok) return { ok: false, error: parsedReply.error };
      const replyTo = parsedReply.replyTo;

      // 0.20 DM scope: single scope-routed egress (dm store + broadcast + listeners).
      if (typeof roomId === "string" && roomId.startsWith("dm:")) {
        const dmMeta = messageMeta({
          attachments,
          replyTo,
        });
        postMessage(roomId, agentName, message, [], dmMeta || {});
        const hasNeed = Array.isArray(params?.need_response) && params.need_response.length > 0;
        return { ok: true, ...(hasNeed ? { note: "no @target — need_response ignored" } : {}) };
      }

      const rosterId = resolveChatScopeRoomId(roomId) || roomId;
      const room = resolveChatScopeRoom(roomId) || roomStore.getRoom(rosterId);
      const roomMembers = ("getRoomMembers" in roomStore ? (roomStore as any).getRoomMembers(rosterId) : undefined) || (room?.members || []).map((name: string) => ({ id: name, name, sourceAgent: name }));
      const senderMember = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(rosterId, agentName) : undefined;
      const info = room ? mentionInfoFromText(message, roomMembers) : { mentions: [], mentionMemberIds: [], urgentMentions: [], urgentMentionMemberIds: [] };
      const { mentions, mentionMemberIds, urgentMentions, urgentMentionMemberIds } = info;

      const parsedNeed = parseNeedResponseParam(params?.need_response, roomMembers, mentions, mentionMemberIds);
      if (!parsedNeed.ok) return { ok: false, error: parsedNeed.error };
      const needResponse = parsedNeed.names;

      // Room message via message-bus (writes + broadcasts + notifies listeners)
      // Mention activation is handled by router listener via message-bus.
      const meta = messageMeta({ attachments, senderMemberId: senderMember?.id, senderName: agentName, mentionMemberIds, urgentMentions, urgentMentionMemberIds, mentions, needResponse, replyTo });
      if (meta) postMessage(roomId, agentName, message, mentions, meta);
      else postMessage(roomId, agentName, message, mentions);

      if (Array.isArray(params?.need_response) && params.need_response.length > 0 && needResponse.length === 0) {
        return {
          ok: true,
          note: info.mentionMemberIds.length === 0
            ? "no @target — need_response ignored"
            : "need_response matched no @-mentioned members — treated as FYI",
        };
      }
      return { ok: true };
    }
    case "query_room_messages": {
      const qActor = resolveMemoryActor(roomId, agentName);
      if (!qActor) return { ok: false, error: "Current member is not in this room" };
      const target = resolveReadTarget(roomId, qActor, params?.scope);
      if (params?.target_scope !== undefined) return { ok: false, error: "unknown parameter 'target_scope' — use 'scope' (e.g. 'room:<id>' or 'dm:<memberId>')" };
      if (!target.ok) return { ok: false, error: target.error };
      const targetRoomId = target.roomId;
      const limit = Math.max(1, Math.min(params?.limit ?? 50, 500));
      const searchOpts: messageStore.SearchOptions = {
        query: params?.query ? String(params.query) : undefined,
        from: params?.from ? String(params.from) : undefined,
        after: params?.after !== undefined ? parseTimeArg(String(params.after)) : undefined,
        before: params?.before !== undefined ? parseTimeArg(String(params.before)) : undefined,
        type: params?.type ? String(params.type) : undefined,
        aroundSeq: params?.around_seq !== undefined ? Number(params.around_seq) : undefined,
        limit,
      };
      const fromSeq = params?.from_seq !== undefined ? Number(params.from_seq) : undefined;

      // No search filters — keep original fast path (latest N messages)
      const hasFilter = searchOpts.query || searchOpts.from ||
        searchOpts.after !== undefined || searchOpts.before !== undefined ||
        searchOpts.type !== undefined || searchOpts.aroundSeq !== undefined ||
        fromSeq !== undefined;

      let messages: RoomMessage[];
      if (targetRoomId.startsWith("dm:") || targetRoomId.startsWith("topic:")) {
        // DM / topic have no query index — filter in memory. Topic must not
        // fall through to rooms/topic:xxx/ (that directory does not exist).
        messages = filterMessagesInMemory(loadScopeMessages(targetRoomId), searchOpts, fromSeq, limit);
      } else if (fromSeq !== undefined) {
        // Backlog read (hybrid injection msg:#14818): messages strictly after
        // from_seq, ascending — the actionable primitive the unread hint points at.
        messages = messageStore.getMessages(targetRoomId, { fromSeq, limit });
      } else {
        messages = hasFilter
          ? messageStore.searchMessages(targetRoomId, searchOpts).messages
          : messageStore.getMessages(targetRoomId, { limit });
      }
      // Members never see system notices (runtime failures AND non-error system
      // prompts); typed task/knowledge events stay. Same filter as the
      // activation-context injection path (fish 2026-08-04).
      messages = messages.filter((m) => !isSystemNoticeHiddenFromMembers(m));

      // Read-to-clear (hybrid spec msg:#14818): any successful read of THIS
      // member's own room advances the delivery cursor to the furthest message
      // seen — the unread hint disappears on the next activation. Cross-scope
      // reads and DM (which has no backlog semantics) never touch the cursor.
      if (!targetRoomId.startsWith("dm:") && !targetRoomId.startsWith("topic:") && targetRoomId === roomId && messages.length > 0) {
        let maxSeq = -1;
        let maxMsg: RoomMessage | null = null;
        for (const m of messages) {
          const seq = (m as { seq?: number }).seq ?? 0;
          if (seq > maxSeq) {
            maxSeq = seq;
            maxMsg = m;
          }
        }
        if (maxMsg) roomStore.setCursor(roomId, qActor.id, maxMsg.id);
      }

      // Member-view rows (built once, shared by both output modes):
      // replyTo resolved against the full scope (works across the page window),
      // attachments resolved to store paths (unavailable on miss).
      const byId = new Map(messages.map((m) => [m.id, m]));
      // Also index full scope for resolving reply targets outside the page window.
      const scopeAll = loadScopeMessages(targetRoomId);
      const scopeById = new Map(scopeAll.map((m) => [m.id, m]));
      const rows: QueryRow[] = messages.map((m) => {
        const base: QueryRow = { sender: m.sender, content: m.content, ts: m.ts, seq: m.seq };
        const readAttachments = resolveMessageAttachmentsForRead(targetRoomId, m);
        if (readAttachments.length > 0) {
          base.attachments = readAttachments;
        }
        if (m.replyTo) {
          const target = scopeById.get(m.replyTo.messageId) || byId.get(m.replyTo.messageId);
          base.replyTo = {
            seq: m.replyTo.seq,
            messageId: m.replyTo.messageId,
            ...(target
              ? { sender: target.sender, excerpt: excerptForReply(target.content) }
              : { unavailable: true }),
          };
        }
        return base;
      });

      // File output mode: write markdown file and return path (avoids 25K truncation)
      if (params?.output === "file") {
        const filePath = join(tmpdir(), `bossmode-search-${targetRoomId.replace(":", "-") .slice(0, 12)}-${randomUUID().slice(0, 8)}.md`);
        const content = renderMessagesAsMarkdown(rows, searchOpts);
        writeFileSync(filePath, content, "utf-8");
        logger.info("callback", "query_room_messages:file", { path: filePath, count: messages.length });
        return { ok: true, path: filePath, count: messages.length, format: "markdown" };
      }

      // Default: inline rows — the SDK layer renders them via the shared
      // member-view renderer (renderQueryRowsForMember) so both modes match.
      return rows;
    }
    case "create_topic": {
      const message = String(params?.message ?? "").trim();
      if (!message) return { ok: false, error: "message is required" };
      if (roomId.startsWith("dm:")) return { ok: false, error: "create_topic is not available in a DM scope" };
      const parentRoomId = resolveChatScopeRoomId(roomId) || roomId;
      const room = roomStore.getRoom(parentRoomId);
      if (!room) return { ok: false, error: "Room not found" };
      const actor = resolveMemoryActor(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const brief = String(params?.brief ?? "").trim();
      const seedMode = getTopicSeedMode();
      const title = titleFromMessage(message) || "Untitled topic";
      const guideText = buildTopicGuideText({
        title,
        roomName: room.name,
        roomId: parentRoomId,
        anchorExcerpt: message,
        seedMode,
        ...(brief ? { brief, briefBy: actor.name } : {}),
      });
      const topic = createTopic({
        roomId: parentRoomId,
        title,
        anchorMessageId: "",
        seedMode,
        guideText,
        anchorExcerpt: normalizeAnchorExcerpt(message),
        createdBy: actor.name,
        ...(brief ? { brief } : {}),
      });
      const card = postMessage(parentRoomId, actor.name, `Topic opened: ${topic.title}`, [], {
        type: "topic_event",
        topic_event_meta: {
          action: "opened",
          topicId: topic.id,
          title: topic.title,
          actor: actor.name,
          anchorExcerpt: normalizeAnchorExcerpt(message).slice(0, 120),
        },
      });
      topic.anchorMessageId = card.id;
      topic.anchorSeq = card.seq;
      saveTopic(topic);
      const scopeId = scopeIdOf({ kind: "topic", topicId: topic.id, roomId: parentRoomId });
      const roomMembers = roomStore.getRoomMembers(parentRoomId);
      const urgentMentions = parseUrgentMentions(message, roomMembers.map((m) => m.name));
      const mentions = [...new Set([...parseMentions(message, roomMembers.map((m) => m.name)), ...urgentMentions])];
      const mentionMemberIds = [...new Set([
        ...parseMentionMemberIds(message, roomMembers),
        ...parseUrgentMentionMemberIds(message, roomMembers),
      ])];
      postMessage(scopeId, actor.name, message, mentions, {
        mentionMemberIds,
        ...(urgentMentions.length ? { urgentMentions } : {}),
      });
      return { ok: true, topicId: topic.id, scopeId, title: topic.title };
    }
    case "create_task": {
      const title = params?.title ? String(params.title).trim() : "";
      if (!title) return { ok: false, error: "title is required" };
      try {
        // Topic tasks belong to the parent room; auto-tag topic:<id> (plan §6).
        let taskRoomId = roomId;
        let autoTopicRef: string | undefined;
        if (roomId.startsWith("topic:")) {
          const parent = resolveTopicRoomId(roomId.slice("topic:".length));
          if (!parent) return { ok: false, error: `Unknown topic scope: ${roomId}` };
          taskRoomId = parent;
          autoTopicRef = roomId; // "topic:<id>"
        }
        if (taskRoomId.startsWith("dm:")) return { ok: false, error: "Tasks are room-scoped — a DM scope has no task list" };
        const assignee = resolveTaskAssignee(taskRoomId, params?.assignee);
        const subscribers = resolveTaskSubscribers(taskRoomId, params?.subscribers);
        let references = Array.isArray(params?.references) ? params.references.map(String) : [];
        if (autoTopicRef && !references.includes(autoTopicRef)) references = [...references, autoTopicRef];
        const task = taskStore.createTask(taskRoomId, {
          title,
          createdBy: agentName,
          status: (params?.status as TaskStatus) || "todo",
          priority: (params?.priority as TaskPriority) || "P1",
          assignee: assignee?.name,
          assigneeMemberId: assignee?.memberId,
          description: params?.description ? String(params.description) : undefined,
          references: references.length ? references : undefined,
          subscribers: subscribers?.names,
          subscriberMemberIds: subscribers?.memberIds,
        });
        emitTaskEvent(taskRoomId, "created", task, agentName);
        return { ok: true, taskId: task.id, title: task.title, status: task.status };
      } catch (err: any) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    case "update_task": {
      const taskId = params?.taskId ? String(params.taskId) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      const taskRoomId = resolveChatScopeRoomId(roomId) || roomId;
      const before = taskStore.getTask(taskRoomId, taskId);
      if (!before) return { ok: false, error: `Task not found: ${taskId}` };
      try {
        const patch: Parameters<typeof taskStore.updateTask>[2] = {};
        if (params?.title !== undefined) patch.title = String(params.title);
        if (params?.status !== undefined) patch.status = params.status as TaskStatus;
        if (params?.priority !== undefined) patch.priority = params.priority as TaskPriority;
        if (params?.assignee !== undefined) {
          const assignee = resolveTaskAssignee(taskRoomId, params.assignee);
          patch.assignee = assignee?.name;
          patch.assigneeMemberId = assignee?.memberId;
        }
        if (params?.description !== undefined) patch.description = String(params.description);
        if (params?.references !== undefined) patch.references = Array.isArray(params.references) ? params.references.map(String) : [];
        if (params?.subscribers !== undefined) {
          const subscribers = resolveTaskSubscribers(taskRoomId, params.subscribers) || { names: [], memberIds: [] };
          patch.subscribers = subscribers.names;
          patch.subscriberMemberIds = subscribers.memberIds;
        }
        const updated = taskStore.updateTask(taskRoomId, taskId, patch);
        if (!updated) return { ok: false, error: "Update failed" };
        const action = before.status !== updated.status ? "status_changed" : "updated";
        emitTaskEvent(taskRoomId, action, updated, agentName);
        return { ok: true, taskId: updated.id, status: updated.status, title: updated.title };
      } catch (err: any) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    case "list_scopes": {
      const actor = resolveMemoryActor(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const rooms = listRoomsForMember(actor.id).map((r) => ({ scope: `room:${r.id}`, name: r.name }));
      return { ok: true, scopes: [...rooms, { scope: `dm:${actor.id}`, name: "Direct message with user" }] };
    }
    case "list_tasks": {
      const tActor = resolveMemoryActor(roomId, agentName);
      if (!tActor) return { ok: false, error: "Current member is not in this room" };
      const tTarget = resolveReadTarget(roomId, tActor, params?.scope);
      if (params?.target_scope !== undefined) return { ok: false, error: "unknown parameter 'target_scope' — use 'scope' (e.g. 'room:<id>')" };
      if (!tTarget.ok) return { ok: false, error: tTarget.error };
      if (tTarget.roomId.startsWith("dm:")) return { ok: false, error: "Tasks are room-scoped — a DM scope has no task list" };
      const tasksRoomId = resolveChatScopeRoomId(tTarget.roomId) || tTarget.roomId;
      let tasks = taskStore.listTasks(tasksRoomId);
      if (params?.status) tasks = tasks.filter((t) => t.status === params.status);
      if (params?.assignee) tasks = tasks.filter((t) => taskAssigneeMatches(tasksRoomId, t, String(params.assignee)));
      return tasks.map((t) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        assignee: t.assignee, createdBy: t.createdBy,
        references: t.references,
        subscribers: t.subscribers,
        commentCount: t.comments?.length ?? 0,
      }));
    }
    case "get_task": {
      const gActor = resolveMemoryActor(roomId, agentName);
      if (!gActor) return { ok: false, error: "Current member is not in this room" };
      const gTarget = resolveReadTarget(roomId, gActor, params?.scope);
      if (params?.target_scope !== undefined) return { ok: false, error: "unknown parameter 'target_scope' — use 'scope' (e.g. 'room:<id>')" };
      if (!gTarget.ok) return { ok: false, error: gTarget.error };
      if (gTarget.roomId.startsWith("dm:")) return { ok: false, error: "Tasks are room-scoped — a DM scope has no task list" };
      const taskId = params?.taskId ? String(params.taskId) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      const getTaskRoomId = resolveChatScopeRoomId(gTarget.roomId) || gTarget.roomId;
      const task = taskStore.getTask(getTaskRoomId, taskId);
      if (!task) return { ok: false, error: `Task not found: ${taskId}` };
      return truncateToolResult(renderTaskAsMarkdown(task));
    }
    case "comment_task": {
      const taskId = params?.taskId ? String(params.taskId) : "";
      const comment = params?.comment ? String(params.comment) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      if (!comment.trim()) return { ok: false, error: "comment is required" };
      const commentRoomId = resolveChatScopeRoomId(roomId) || roomId;
      const result = taskStore.addTaskComment(commentRoomId, taskId, { author: agentName, content: comment });
      if (!result) return { ok: false, error: `Task not found: ${taskId}` };
      emitTaskEvent(commentRoomId, "commented", result.task, agentName, { commentId: result.comment.id });
      return { ok: true, taskId: result.task.id, commentId: result.comment.id };
    }
    case "member_status": {
      // Room-scope read-only live status (same source as the member panel lamp).
      const statusRoomId = resolveChatScopeRoomId(roomId) || roomId;
      const room = roomStore.getRoom(statusRoomId);
      if (!room) return { ok: false, error: "Room not found" };
      const { getRoomMemberStatusReport } = await import("./agent-manager.js");
      const memberRef = params?.member !== undefined ? String(params.member).trim() : "";
      const report = getRoomMemberStatusReport(statusRoomId, memberRef || undefined);
      if (!report) return { ok: false, error: `Member not found: ${memberRef}` };
      return { ok: true, members: report };
    }
    case "reload": {
      // Batch 6 §3: rebuild own session in the current scope, history kept.
      // roomId arrives scope-shaped ("dm:<id>" / "topic:<id>" / room id).
      const { reloadMemberSession } = await import("./agent-manager.js");
      let reloadMemberId = agentName;
      if (roomId.startsWith("dm:")) {
        reloadMemberId = roomId.slice("dm:".length);
      } else {
        const rosterRoomId = resolveChatScopeRoomId(roomId) || roomId;
        const rosterMember = roomStore.resolveRoomMemberRef(rosterRoomId, agentName);
        if (rosterMember) reloadMemberId = rosterMember.id;
      }
      const result = await reloadMemberSession(roomId, reloadMemberId, "tool");
      return {
        ok: true,
        queued: result.queued,
        rebuilt: result.rebuilt,
        message: result.queued
          ? "You are mid-run — the session rebuilds when this turn finishes. Conversation history is preserved."
          : "Session rebuilt in the current scope with fresh assets (persona, skills, MCP, extensions, model config). Conversation history is preserved.",
      };
    }
    case "wait": {
      // 0.20: wait available to all room members (no longer leader-only).
      // Roster from parent room; wait watches the current scope (topic instance if any).
      const waitRosterId = resolveChatScopeRoomId(roomId) || roomId;
      const room = roomStore.getRoom(waitRosterId);
      const actor = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(waitRosterId, agentName) : undefined;
      if (!room || !actor) return { ok: false, error: "Room or member not found" };

      const targetRef = String(params?.member || "").trim();
      if (!targetRef) return { ok: false, error: "member is required" };
      const target = (roomStore as any).resolveRoomMemberRef(waitRosterId, targetRef);
      if (!target) return { ok: false, error: `Member not found: ${targetRef}` };
      if (target.id === actor.id) return { ok: false, error: "Cannot wait on yourself" };

      const { waitForMember, WAIT_DEFAULT_TIMEOUT_MIN, WAIT_MAX_TIMEOUT_MIN } = await import("./wait-wait.js");
      const { getAgentStatus } = await import("./agent-manager.js");
      const targetStatus = getAgentStatus(roomId, target.id);
      const timeoutMinutes = params?.timeoutMinutes !== undefined ? Number(params.timeoutMinutes) : undefined;

      // mention_interrupt does NOT abort — activation steers the @ message while working;
      // wait only reports why it ended. Stop button is the sole abort path.
      const outcome = await waitForMember({
        roomId,
        waiterMemberId: actor.id,
        waiterName: actor.name,
        targetMemberId: target.id,
        targetName: target.name,
        targetStatus,
        timeoutMinutes,
      });

      return {
        ...outcome,
        defaults: { timeoutMinutes: WAIT_DEFAULT_TIMEOUT_MIN, maxTimeoutMinutes: WAIT_MAX_TIMEOUT_MIN },
      };
    }
    case "list_members": {
      // Global member directory (DM tool surface). Returns id/name/template for invite flows.
      const { listMembers } = await import("../workspace/member-registry.js");
      const q = String(params?.query || "").trim().toLowerCase();
      let members = listMembers().map((m) => ({
        id: m.id,
        name: m.name,
        agentTemplate: m.agentTemplate,
        model: m.global.model ?? null,
      }));
      if (q) {
        members = members.filter((m) =>
          m.name.toLowerCase().includes(q)
          || m.id.toLowerCase().includes(q)
          || m.agentTemplate.toLowerCase().includes(q),
        );
      }
      return { ok: true, members, count: members.length };
    }
    case "create_room": {
      // DM tool: creator becomes leader; invite by global member id.
      const { findMemberByName, getMember, listMembers } = await import("../workspace/member-registry.js");
      const creator = findMemberByName(agentName) || listMembers().find((m) => m.name === agentName);
      if (!creator) return { ok: false, error: `Creator member not found: ${agentName}` };

      const name = String(params?.name || "").trim();
      if (!name) return { ok: false, error: "name is required" };
      const cwd = String(params?.cwd || "").trim() || process.cwd();
      const { existsSync } = await import("node:fs");
      if (!existsSync(cwd)) return { ok: false, error: `Directory does not exist: ${cwd}` };

      const inviteIds: string[] = Array.isArray(params?.memberIds)
        ? params.memberIds.map(String).filter(Boolean)
        : [];
      // Creator always in the room.
      const allIds = Array.from(new Set([creator.id, ...inviteIds]));
      const invitees = allIds.map((id) => {
        const m = getMember(id);
        if (!m) throw new Error(`Unknown member id: ${id}`);
        return m;
      });

      const drafts = invitees.map((m) => ({
        agent: m.agentTemplate || "general",
        name: m.name,
      }));

      let room;
      try {
        room = roomStore.createRoom(name, cwd, drafts, undefined, {
          promptLeaderMemberName: creator.name,
        });
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }

      // Cutover: stamp globalMemberIds + migrate leader to mem_* + drop roomMembers.
      roomStore.stampGlobalMemberIds(
        room.id,
        invitees.map((m) => m.id),
        creator.id,
      );

      const principles = typeof params?.principles === "string" ? params.principles.trim() : "";
      if (principles) {
        try {
          principlesStore.writePrinciples({
            roomId: room.id,
            scope: "room",
            content: principles,
            actor: { type: "member", memberId: creator.id, name: creator.name },
            reason: "create_room initial principles",
            operation: "write",
          });
        } catch (err: any) {
          return {
            ok: true,
            roomId: room.id,
            name: room.name,
            leader: creator.name,
            members: invitees.map((m) => ({ id: m.id, name: m.name })),
            warning: `Room created but principles write failed: ${err?.message || err}`,
          };
        }
      }

      return {
        ok: true,
        roomId: room.id,
        name: room.name,
        cwd: room.cwd,
        leader: creator.name,
        leaderMemberId: creator.id,
        members: invitees.map((m) => ({ id: m.id, name: m.name })),
        scopeId: `room:${room.id}`,
      };
    }
    case "edit_room": {
      const { findMemberByName, getMember, listMembers } = await import("../workspace/member-registry.js");
      const actorGlobal = findMemberByName(agentName) || listMembers().find((m) => m.name === agentName);
      if (!actorGlobal) return { ok: false, error: `Member not found: ${agentName}` };

      const rawTarget = String(params?.roomId || roomId || "").trim();
      const targetRoomId = resolveChatScopeRoomId(rawTarget) || rawTarget;
      if (!targetRoomId) return { ok: false, error: "roomId is required" };
      const room = roomStore.getRoom(targetRoomId);
      if (!room) return { ok: false, error: "Room not found" };

      const actorLocal = roomStore.resolveRoomMemberRef(targetRoomId, agentName);
      if (!actorLocal) {
        return { ok: false, error: "not_room_member", message: "You must be a member of this room to edit it" };
      }

      if (typeof params?.name === "string" && params.name.trim()) {
        const renamed = roomStore.updateRoomName(targetRoomId, params.name.trim());
        if (!renamed) return { ok: false, error: "Failed to rename room" };
      }

      if (typeof params?.principles === "string") {
        principlesStore.writePrinciples({
          roomId: targetRoomId,
          scope: "room",
          content: params.principles,
          actor: { type: "member", memberId: actorLocal.id, name: actorLocal.name },
          reason: String(params?.reason || "edit_room principles update"),
          operation: "write",
        });
      }

      // Invite additions
      const addIds: string[] = Array.isArray(params?.addMemberIds) ? params.addMemberIds.map(String) : [];
      const added: string[] = [];
      for (const id of addIds) {
        const g = getMember(id);
        if (!g) continue;
        const r = roomStore.inviteGlobalMember(targetRoomId, {
          id: g.id,
          name: g.name,
          agentTemplate: g.agentTemplate || "general",
        });
        if (r.ok) added.push(g.name);
      }

      // Removals (keep scope memory assets — only membership)
      const removeIds: string[] = Array.isArray(params?.removeMemberIds) ? params.removeMemberIds.map(String) : [];
      const removed: string[] = [];
      for (const id of removeIds) {
        if (id === actorGlobal.id) continue; // don't remove self via this tool
        const g = getMember(id);
        if (!g) continue;
        const r = roomStore.removeRoomMemberByRef(targetRoomId, g.name, { globalMemberId: g.id });
        if (r.ok) removed.push(g.name);
      }

      const updated = roomStore.getRoom(targetRoomId);
      return {
        ok: true,
        roomId: targetRoomId,
        name: updated?.name || room.name,
        added,
        removed,
        members: (updated?.members || room.members),
      };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

// -- Tool helpers --

function parseTimeArg(input: string): number | undefined {
  if (!input) return undefined;

  // Relative: "today", "yesterday", "Nh", "Nd"
  const now = Date.now();
  if (input === "today") {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  if (input === "yesterday") {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return d.getTime();
  }
  const hMatch = input.match(/^(\d+)h$/);
  if (hMatch) return now - parseInt(hMatch[1], 10) * 3600_000;
  const dMatch = input.match(/^(\d+)d$/);
  if (dMatch) return now - parseInt(dMatch[1], 10) * 86400_000;

  // ISO or numeric
  const num = typeof input === "string" ? Number(input) : NaN;
  if (!Number.isNaN(num) && num > 0) return num;
  const parsed = Date.parse(input);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function renderTaskAsMarkdown(task: Task | null): string {
  if (!task) return "Task not found.";
  const lines = [
    `# ${task.title}`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    `Assignee: ${task.assignee || "Unassigned"}`,
    `Subscribers: ${(task.subscribers || []).join(", ") || "None"}`,
    `References: ${(task.references || []).join(", ") || "None"}`,
    "",
    "## Description",
    task.description || "(none)",
    "",
    "## Comments",
  ];
  const comments = task.comments || [];
  if (comments.length === 0) {
    lines.push("(none)");
  } else {
    for (const c of comments) {
      lines.push(`- [${new Date(c.createdAt).toISOString()}] ${c.author}: ${c.content}`);
    }
  }
  return lines.join("\n");
}

/** Resolve a message's attachments for member-facing reads (fish No.16834):
 *  {originalFilename, path} — path is the attachment-store absolute path for the
 *  owning scope (room dir / DM dir / topic → parent room dir), or "unavailable"
 *  when the file is missing (envelope catch behavior). */
function resolveMessageAttachmentsForRead(
  scopeRoomId: string,
  msg: RoomMessage,
): Array<{ originalFilename: string; path: string }> {
  if (!msg.attachments?.length) return [];
  return msg.attachments.map((a) => {
    try {
      let absPath: string;
      if (scopeRoomId.startsWith("dm:")) {
        absPath = attachmentStore.getDmAttachmentPath(scopeRoomId.slice(3), a.storedFilename);
      } else {
        const owner = scopeRoomId.startsWith("topic:")
          ? (resolveChatScopeRoomId(scopeRoomId) || scopeRoomId)
          : scopeRoomId;
        absPath = attachmentStore.getAttachmentPath(owner, a.storedFilename);
      }
      if (!existsSync(absPath)) {
        return { originalFilename: a.originalFilename, path: "unavailable" };
      }
      return { originalFilename: a.originalFilename, path: absPath };
    } catch {
      return { originalFilename: a.originalFilename, path: "unavailable" };
    }
  });
}

function renderMessagesAsMarkdown(rows: QueryRow[], opts: messageStore.SearchOptions): string {
  const header = [
    "# Message Search Results\n",
    opts.query ? `**Query**: \`${opts.query}\`  ` : "",
    opts.from ? `**From**: \`${opts.from}\`  ` : "",
    `**Count**: ${rows.length}`,
    "\n---\n",
  ].filter(Boolean).join("\n");

  // Same member-view rendering as inline mode (one shape, both outputs).
  return header + "\n" + renderQueryRowsForMember(rows);
}
