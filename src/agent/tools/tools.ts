// Agent tool callback handler — business logic for chat/messages/summary tools
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { postMessage } from "../../chat/message-bus.js";
import * as messageStore from "../../chat/message-store.js";
import * as roomStore from "../../chat/conversations.js";
import { getMember, resolveMemberRef } from "../../member/identity.js";
import { assertMemberScopeAccess, listRoomsForMember } from "../../chat/conversations.js";
import { unknownMemberToolMessage } from "./member-tool-names.js";
import { readAllDmMessages } from "../../chat/dm-message-store.js";
import { chatScopeRoomId, isMmScopeId, mmScopeIdOf, parseMmScopeId, scopeIdOf, type ScopeId } from "../../chat/conversations.js";
import type { RoomMessage } from "../../kernel/types.js";
import { parseMentions, parseMentionMemberIds } from "../../chat/router.js";
import { isSystemNoticeHiddenFromMembers } from "../../kernel/runtime-error-limit.js";
import { logger } from "../../kernel/logger.js";
import { processAgentAttachments } from "../orchestrator/agent-attachments.js";
import * as attachmentStore from "../../files/attachment-store.js";
import { renderQueryRowsForMember, type QueryRow } from "./query-render.js";
import { displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../../kernel/attachments.js";

/** Max chars for tool result text. ~6K tokens, aligned with CLI output constraints. */
const MAX_RESULT_CHARS = 25_000;

/**
 * 0.20: tool `roomId` is the runtime scope key — a plain room id for room
 * scope, `dm:<memberId>` for DM scope. Member memory layers live in the
 * member-global store keyed by ScopeId (contract §6).
 */
function toolScopeId(roomId: string): ScopeId {
  // dm:<id> / mm:<a>-<b> are already full ScopeIds; bare room uuid → room:<uuid>
  if (roomId.startsWith("dm:") || isMmScopeId(roomId)) return roomId;
  return `room:${roomId}`;

}

function resolveMemoryActor(roomId: string, agentName: string): { id: string; name: string } | null {
  if (roomId.startsWith("dm:")) {
    const member = getMember(roomId.slice("dm:".length));
    return member ? { id: member.id, name: member.name } : null;
  }
  if (isMmScopeId(roomId)) {
    const member = resolveMemberRef(agentName);
    return member ? { id: member.id, name: member.name } : null;
  }
  return roomStore.resolveRoomMemberRef(roomId, agentName);
}

/**
 * Batch 3 (member-centric tools): resolve an explicit chat target (`to` /
 * `chat`) to a runtime scope key — plain room id or dm:<memberId>. Accepts
 * scope-id literals ('room:<id>' / 'dm:<memberId>'), raw room ids, exact
 * (case-insensitive) room names — ambiguous names return the candidates — and
 * 'user' for the caller's own DM with the user. Missing/empty keeps the
 * current scope: a transitional default until member-level routing (batch 1)
 * lands. Failures return an explicit error, never a silent fallback.
 */
function resolveChatTarget(
  currentRoomId: string,
  actor: { id: string; name: string },
  ref: unknown,
): { ok: true; roomId: string } | { ok: false; error: string } {
  const value = ref === undefined || ref === null ? "" : String(ref).trim();
  if (!value) return { ok: true, roomId: currentRoomId };
  if (value === "user" || value === "dm" || value === actor.id) return { ok: true, roomId: `dm:${actor.id}` };
  if (value.startsWith("dm:") || value.startsWith("room:") || isMmScopeId(value)) {
    try {
      const access = assertMemberScopeAccess(actor.id, value);
      if (access.kind === "mm") return { ok: true, roomId: mmScopeIdOf(access.memberIds[0], access.memberIds[1]) };
      return { ok: true, roomId: access.kind === "dm" ? `dm:${access.memberId}` : access.roomId };
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
  // Raw room id first, then the current room's name, then the member's room list.
  try {
    const access = assertMemberScopeAccess(actor.id, `room:${value}`);
    if (access.kind === "room") return { ok: true, roomId: access.roomId };
  } catch { /* fall through to name match */ }
  const lower = value.toLowerCase();
  const currentRoom = currentRoomId.startsWith("dm:") ? null : roomStore.getRoom(currentRoomId);
  if (currentRoom && currentRoom.name.toLowerCase() === lower) return { ok: true, roomId: currentRoomId };
  const named = listRoomsForMember(actor.id).filter((room) => room.name.toLowerCase() === lower);
  if (named.length === 1) return { ok: true, roomId: named[0].id };
  if (named.length > 1) {
    return { ok: false, error: `Multiple chats named "${value}": ${named.map((room) => `room:${room.id}`).join(", ")} — use the chat id.` };
  }
  // Member refs (exact id or unique name) open the member↔member chat (⑤ B):
  // sending to a member needs no creation step. Self resolves to the user DM.
  const targetMember = resolveMemberRef(value);
  if (targetMember) {
    if (targetMember.id === actor.id) return { ok: true, roomId: `dm:${actor.id}` };
    if (getMember(targetMember.id)) return { ok: true, roomId: mmScopeIdOf(actor.id, targetMember.id) };
  }
  return { ok: false, error: `Chat not found: ${value} — use chat_list to see your chats.` };
}

/** Display label for a chat scope key (room name / DM / member chat label). */
function chatScopeLabel(scopeId: string, viewerId?: string): string {
  if (scopeId.startsWith("dm:")) return "Direct message with user";
  if (isMmScopeId(scopeId)) {
    const pair = parseMmScopeId(scopeId);
    const other = pair ? (viewerId && pair.includes(viewerId) ? pair.find((id) => id !== viewerId) ?? pair[1] : pair[1]) : "";
    return other ? `Private chat with ${getMember(other)?.name ?? other}` : "Private chat";
  }
  return roomStore.getRoom(scopeId)?.name || scopeId;
}

/** Compact description (first line, capped) from a room's stored description. */
function chatDescriptionOf(roomId: string, max = 120): string {
  try {
    const line = (roomStore.getRoom(roomId)?.description || "").split("\n").map((part) => part.trim()).find(Boolean) || "";
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  } catch {
    return "";
  }
}

/** Mention parse for outgoing member messages: @ targets merge into
 * mentions/mentionMemberIds (unread/highlight/stats share one list). */
function mentionInfoFromText(message: string, roomMembers: Array<{ id: string; name: string }>): {
  mentions: string[];
  mentionMemberIds: string[];
} {
  const names = roomMembers.map((member) => member.name);
  const byName = new Map(roomMembers.map((member) => [member.name, member.id]));
  const mentions = parseMentions(message, names);
  const toIds = (list: string[]) => list.map((name) => byName.get(name)).filter((id): id is string => Boolean(id));
  return { mentions, mentionMemberIds: mentions.includes("all") ? roomMembers.map(member => member.id) : toIds(mentions) };
}

function messageMeta(meta: {
  attachments?: RoomMessageAttachment[];
  artifacts?: string[];
  senderMemberId?: string;
  senderName?: string;
  mentionMemberIds?: string[];
  mentions?: string[];
}) {
  const out: {
    attachments?: RoomMessageAttachment[];
    artifacts?: string[];
    senderMemberId?: string;
    mentionMemberIds?: string[];
  } = {};
  if (meta.attachments?.length) out.attachments = meta.attachments;
  if (meta.artifacts?.length) out.artifacts = meta.artifacts;
  if (meta.senderMemberId) out.senderMemberId = meta.senderMemberId;
  if (meta.mentionMemberIds !== undefined) out.mentionMemberIds = meta.mentionMemberIds;
  return Object.keys(out).length > 0 ? out : undefined;
}

const REPLY_EXCERPT_MAX = 200;

export function excerptForReply(content: string, max = REPLY_EXCERPT_MAX): string {
  const oneLine = String(content || "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + "…";
}

/** Look up messages in the current conversation scope (room uuid / dm:<id>). */
export function loadScopeMessages(scopeId: string): RoomMessage[] {
  if (scopeId.startsWith("dm:")) {
    return readAllDmMessages(scopeId.slice("dm:".length));
  }
  return messageStore.readAllMessages(scopeId);
}

/** In-memory filter for scopes without a query index (DM). */
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

/** Truncate a serialized tool result if it exceeds the limit. */
export function truncateToolResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const truncated = text.slice(0, MAX_RESULT_CHARS);
  return truncated + `\n\n--- Result truncated (${text.length} chars exceeded ${MAX_RESULT_CHARS} limit). Use a more specific query to get smaller results. ---`;
}

/** Handle a tool callback from an agent runtime */
/** Resolve the calling member's global id from a scope-shaped roomId + agent name. */
function resolveCallerMemberId(roomId: string, agentName: string): string {
  if (roomId.startsWith("dm:")) return roomId.slice("dm:".length);
  const rosterRoomId = chatScopeRoomId(roomId) || roomId;
  const rosterMember = roomStore.resolveRoomMemberRef(rosterRoomId, agentName);
  if (rosterMember) return rosterMember.id;
  return agentName;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
  /** Trusted runtime-owned caller identity, never taken from tool arguments. */
  memberId?: string;
}

export async function handleToolCallback(
  tool: string,
  roomId: string,
  agentName: string,
  params: Record<string, any>,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const actorRef = context?.memberId || agentName;
  const boundActor = () => {
    if (!context?.memberId) return null;
    // Historical room-template IDs keep their existing room-local tools. They
    // never fall back from a missing global ID or acquire a DB profile by name.
    const actor = context.memberId.startsWith("mem_") ? getMember(context.memberId) : resolveMemoryActor(roomId, context.memberId);
    return actor?.id === context.memberId ? actor : null;
  };
  if (context?.memberId) {
    if (!boundActor()) return { ok: false, error: "Member not found", code: "not_found" };
    if (context.memberId.startsWith("mem_")) {
      try { assertMemberScopeAccess(context.memberId, toolScopeId(roomId)); }
      catch (error) { return { ok: false, error: (error as Error).message, code: "scope_access_denied" }; }
    }
  }
  const actorName = () => context?.memberId ? boundActor()?.name || (() => { throw new Error("Calling member no longer exists"); })() : agentName;
  logger.info("callback", "tool-callback", { tool, room: roomId, agent: actorName() });

  switch (tool) {
    case "profile_read": {
      if (!context?.memberId?.startsWith("mem_")) return { ok: false, error: "A trusted database member ID is required to read a profile", code: "invalid_caller" };
      const member = getMember(context.memberId);
      if (!member) return { ok: false, error: "Member not found", code: "not_found" };
      return { ok: true, member: { id: member.id, name: member.name, description: member.title ?? "" } };
    }
    case "profile_update": {
      if (!context?.memberId?.startsWith("mem_")) return { ok: false, error: "A trusted database member ID is required to update a profile", code: "invalid_caller" };
      // Batch 3: tool fields are name / description; description maps onto the
      // member title storage until the profile rename (batch 4) lands.
      const unknownKey = Object.keys(params ?? {}).find((key) => key !== "name" && key !== "description");
      if (unknownKey !== undefined) {
        return {
          ok: false,
          code: "invalid_profile",
          error: unknownKey === "title"
            ? "The profile field is now called 'description'. Use name and/or description."
            : `Unknown profile field: ${unknownKey}. Only name and description are editable.`,
        };
      }
      const input: { name?: unknown; title?: unknown } = {};
      if (params?.name !== undefined) input.name = params.name;
      if (params?.description !== undefined) input.title = params.description;
      const { updateProfileForMember } = await import("../../member/profile.js");
      try {
        const result = updateProfileForMember(context.memberId, input);
        return {
          ok: true,
          member: { id: result.memberId, name: result.name, description: result.title ?? "" },
          changed: result.changed,
          ...(result.warnings?.length ? { warnings: result.warnings } : {}),
        };
      }
      catch (error) {
        const e = error as Error & { code?: string };
        const known = ["invalid_profile", "name_taken", "not_found"].includes(e.code || "");
        return { ok: false, code: known ? e.code : "persistence_failed", error: known ? e.message : "Profile could not be saved. No identity change was committed." };
      }
    }
    case "chat_send": {
      const unknownParam = Object.keys(params ?? {}).find((key) => key !== "to" && key !== "message" && key !== "attachments");
      if (unknownParam !== undefined) return { ok: false, error: `Unknown chat_send parameter: ${unknownParam}` };

      // 2026-09-04 pm order / designer incident: a model deep in a full context
      // sent chat with an empty string twice and the tool happily posted both.
      // Reject empty text (attachment-only posts still carry content).
      const message = String(params?.message ?? "");
      const hasAttachments = Array.isArray(params?.attachments) && params.attachments.length > 0;
      if (!message.trim() && !hasAttachments) {
        return { ok: false, error: "message must be a non-empty string — re-send your chat message with the text included" };
      }

      // Explicit target (batch 3): `to` resolves to a chat the member may write;
      // missing/empty keeps the current chat until member-level routing lands.
      const sendActor = context?.memberId ? boundActor() : resolveMemoryActor(roomId, actorRef);
      if (!sendActor) return { ok: false, error: "Current member is not in this room" };
      const target = resolveChatTarget(roomId, sendActor, params?.to);
      if (!target.ok) return { ok: false, error: target.error };
      const targetRoomId = target.roomId;
      if (isMmScopeId(targetRoomId) && Array.isArray(params?.attachments) && params.attachments.length > 0) {
        return { ok: false, error: "Attachments are not supported in member chats yet" };
      }

      // Resolve target IDs before attachment IO; names may be reused while it awaits.
      const rosterId = chatScopeRoomId(targetRoomId) || targetRoomId;
      const room = roomStore.getRoom(rosterId);
      const roomMembers = (targetRoomId.startsWith("dm:") || isMmScopeId(targetRoomId)) ? [] : roomStore.getRoomMembers(rosterId);
      const senderMember = context?.memberId ? boundActor() : roomStore.resolveRoomMemberRef(rosterId, actorRef);
      const info = room ? mentionInfoFromText(message, roomMembers) : { mentions: [], mentionMemberIds: [] };
      const { mentions, mentionMemberIds } = info;

      const attachments: RoomMessageAttachment[] = [];
      // Process agent attachments (file paths → validate + copy → structured message metadata).
      // Absolute source/store paths are not written to room-visible message JSON.
      if (Array.isArray(params?.attachments) && params.attachments.length > 0) {
        const attachRoomId = chatScopeRoomId(targetRoomId) || targetRoomId;
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

      // Member↔member chat: plain text only for now; opened on the first send.
      if (isMmScopeId(targetRoomId)) {
        if (attachments.length > 0) return { ok: false, error: "Attachments are not supported in member chats yet" };
        const senderId = context?.memberId ?? null;
        const pair = parseMmScopeId(targetRoomId);
        if (!senderId || !pair || !pair.includes(senderId)) {
          return { ok: false, error: "Sending in a member chat requires your member identity" };
        }
        roomStore.ensureMmScope(pair[0], pair[1]);
        const firstMessage = loadScopeMessages(targetRoomId).length === 0;
        const mmMeta = messageMeta({ senderMemberId: senderId, senderName: actorName() });
        if (mmMeta) postMessage(targetRoomId, actorName(), message, [], mmMeta);
        else postMessage(targetRoomId, actorName(), message, []);
        if (firstMessage) {
          // ⑤ B/C: the receiver's user DM gets a jump notice into the read-only view.
          const other = pair.find((id) => id !== senderId)!;
          const senderName = actorName();
          const otherName = getMember(other)?.name ?? other;
          postMessage(`dm:${other}`, "system",
            `Members ${senderName} and ${otherName} started a private chat. Open it to read (read-only).`,
            [], { member_chat_meta: { scopeId: targetRoomId, fromMemberId: senderId, toMemberId: other } });
        }
        return { ok: true, chat: { id: targetRoomId, kind: "mm", name: chatScopeLabel(targetRoomId, senderId) } };
      }

      // DM target: single scope-routed egress (dm store + broadcast + listeners).
      if (targetRoomId.startsWith("dm:")) {
        const dmMeta = messageMeta({ attachments });
        postMessage(targetRoomId, actorName(), message, [], { ...dmMeta, senderMemberId: actorRef });
        return { ok: true, chat: { id: targetRoomId, kind: "dm", name: chatScopeLabel(targetRoomId) } };
      }

      // Room message via message-bus (writes + broadcasts + notifies listeners)
      // Mention activation is handled by router listener via message-bus.
      const meta = messageMeta({ attachments, senderMemberId: senderMember?.id, senderName: actorName(), mentionMemberIds, mentions });
      if (meta) postMessage(targetRoomId, actorName(), message, mentions, meta);
      else postMessage(targetRoomId, actorName(), message, mentions);

      return { ok: true, chat: { id: targetRoomId, kind: "room", name: chatScopeLabel(targetRoomId) } };
    }
    case "chat_read":
    case "chat_search": {
      const isSearch = tool === "chat_search";
      const qActor = resolveMemoryActor(roomId, actorRef) ?? (context?.memberId ? { id: context.memberId, name: actorName() } : null);
      if (!qActor) return { ok: false, error: "Current member is not in this room" };
      if (params?.scope !== undefined) return { ok: false, error: "unknown parameter 'scope' — use 'chat' (e.g. 'bossmode dev' or 'room:<id>')" };
      if (params?.target_scope !== undefined) return { ok: false, error: "unknown parameter 'target_scope' — use 'chat'" };
      if (params?.type !== undefined) return { ok: false, error: "unknown parameter 'type' — message-type filters are not part of chat_read/chat_search" };
      const target = resolveChatTarget(roomId, qActor, params?.chat);
      if (!target.ok) return { ok: false, error: target.error };
      const targetRoomId = target.roomId;

      // Split-tool discipline: read never searches text, search always does.
      const queryText = params?.query !== undefined ? String(params.query) : "";
      if (isSearch && !queryText.trim()) return { ok: false, error: "query is required — provide the text to search for" };
      if (!isSearch && queryText.trim()) return { ok: false, error: "chat_read does not take a query — use chat_search to find messages by text" };
      if (!isSearch && params?.from !== undefined) return { ok: false, error: "chat_read does not take 'from' — use chat_search for sender filters" };
      if (isSearch && params?.from_seq !== undefined) return { ok: false, error: "chat_search does not take 'from_seq' — use chat_read to read a window" };
      if (isSearch && params?.around_seq !== undefined) return { ok: false, error: "chat_search does not take 'around_seq' — use chat_read to open a hit's context" };
      if (isSearch && params?.output !== undefined) return { ok: false, error: "chat_search does not take 'output' — use chat_read (output: \"file\") for full windows" };

      const limit = Math.max(1, Math.min(params?.limit ?? 50, 500));
      const searchOpts: messageStore.SearchOptions = {
        query: isSearch ? queryText : undefined,
        from: isSearch && params?.from ? String(params.from) : undefined,
        after: params?.after !== undefined ? parseTimeArg(String(params.after)) : undefined,
        before: params?.before !== undefined ? parseTimeArg(String(params.before)) : undefined,
        aroundSeq: !isSearch && params?.around_seq !== undefined ? Number(params.around_seq) : undefined,
        limit,
      };
      const fromSeq = !isSearch && params?.from_seq !== undefined ? Number(params.from_seq) : undefined;

      // No search filters — keep original fast path (latest N messages)
      const hasFilter = searchOpts.query || searchOpts.from ||
        searchOpts.after !== undefined || searchOpts.before !== undefined ||
        searchOpts.aroundSeq !== undefined || fromSeq !== undefined;

      let messages: RoomMessage[];
      if (targetRoomId.startsWith("dm:")) {
        // DM has no query index — filter in memory.
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
      // seen — the unread hint disappears on the next activation. Cross-chat
      // reads and DM (which has no backlog semantics) never touch the cursor.
      if (!targetRoomId.startsWith("dm:") && targetRoomId === roomId && messages.length > 0) {
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

      if (isSearch) {
        // Hit list: compact references (seq / sender / time / snippet), newest first.
        const hits: QueryRow[] = messages.map((m) => ({
          sender: m.sender,
          content: excerptForReply(m.content, 200),
          ts: m.ts,
          seq: m.seq,
        }));
        return hits;
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
          const replyTarget = scopeById.get(m.replyTo.messageId) || byId.get(m.replyTo.messageId);
          base.replyTo = {
            seq: m.replyTo.seq,
            messageId: m.replyTo.messageId,
            ...(replyTarget && !isSystemNoticeHiddenFromMembers(replyTarget)
              ? { sender: replyTarget.sender, excerpt: excerptForReply(replyTarget.content) }
              : { unavailable: true }),
          };
        }
        return base;
      });

      // File output mode: write markdown file and return path (avoids 25K truncation)
      if (params?.output === "file") {
        const filePath = join(tmpdir(), `bossmode-chat-read-${targetRoomId.replace(":", "-") .slice(0, 12)}-${randomUUID().slice(0, 8)}.md`);
        const content = renderMessagesAsMarkdown(rows, searchOpts);
        writeFileSync(filePath, content, "utf-8");
        logger.info("callback", "chat_read:file", { path: filePath, count: messages.length });
        return { ok: true, path: filePath, count: messages.length, format: "markdown" };
      }

      // Default: inline rows — the SDK layer renders them via the shared
      // member-view renderer (renderQueryRowsForMember) so both modes match.
      return rows;
    }
    case "chat_list": {
      const actor = resolveMemoryActor(roomId, actorRef) ?? (context?.memberId ? { id: context.memberId, name: actorName() } : null);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const rooms = listRoomsForMember(actor.id).map((r) => ({
        id: `room:${r.id}`,
        kind: "room" as const,
        name: r.name,
        description: chatDescriptionOf(r.id),
      }));
      const mmChats = roomStore.listMmScopesForMember(actor.id).map((scope) => {
        const other = parseMmScopeId(scope)?.find((id) => id !== actor.id);
        return {
          id: scope,
          kind: "mm" as const,
          name: other ? `Private chat with ${getMember(other)?.name ?? other}` : "Private chat",
          description: "",
        };
      });
      const chats = [...rooms, ...mmChats, { id: `dm:${actor.id}`, kind: "dm" as const, name: "Direct message with user", description: "" }];
      const q = String(params?.query ?? "").trim().toLowerCase();
      const filtered = q
        ? chats.filter((chat) => chat.name.toLowerCase().includes(q) || chat.description.toLowerCase().includes(q))
        : chats;
      const total = filtered.length;
      const offset = Math.max(0, Number(params?.offset ?? 0) || 0);
      const limit = Math.max(1, Math.min(Number(params?.limit ?? 50) || 50, 500));
      const page = filtered.slice(offset, offset + limit);
      return { ok: true, chats: page, count: page.length, total };
    }
    case "chat_info": {
      const actor = resolveMemoryActor(roomId, actorRef) ?? (context?.memberId ? { id: context.memberId, name: actorName() } : null);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const ref = params?.chat !== undefined ? String(params.chat).trim() : "";
      if (!ref) return { ok: false, error: "chat is required — pass a chat id or name (see chat_list)" };
      const target = resolveChatTarget(roomId, actor, ref);
      if (!target.ok) return { ok: false, error: target.error };
      if (target.roomId.startsWith("dm:")) {
        return { ok: true, chat: { id: target.roomId, kind: "dm", name: "Direct message with user", counterpart: "user" } };
      }
      if (isMmScopeId(target.roomId)) {
        const other = parseMmScopeId(target.roomId)?.find((id) => id !== actor.id);
        return {
          ok: true,
          chat: {
            id: target.roomId,
            kind: "mm",
            name: chatScopeLabel(target.roomId, actor.id),
            counterpart: other ? { id: other, name: getMember(other)?.name ?? other } : null,
          },
        };
      }
      const room = roomStore.getRoom(target.roomId);
      if (!room) return { ok: false, error: "Chat not found" };
      const members = roomStore.getRoomMembers(target.roomId).map((m) => ({ id: m.id || m.name, name: m.name }));
      return {
        ok: true,
        chat: {
          id: `room:${target.roomId}`,
          kind: "room",
          name: room.name,
          description: room.description ?? "",
          members,
        },
      };
    }
    case "member_info": {
      const { resolveMemberRef } = await import("../../member/identity.js");
      const ref = params?.member !== undefined ? String(params.member).trim() : "";
      if (!ref) return { ok: false, error: "member is required — pass a name or id (see member_list)" };
      const member = resolveMemberRef(ref);
      if (!member) return { ok: false, error: `Member not found: ${ref} — use member_list to see members.` };
      // ① B4: member-level live status — one runtime per member, one status.
      let status = "idle";
      try {
        const am = await import("../orchestrator/agent-manager.js");
        status = am.getMemberLiveStatus(member.id) === "working" ? "working" : "idle";
      } catch { /* runtime cold — idle */ }
      return { ok: true, member: { id: member.id, name: member.name, description: member.title ?? "", status } };
    }
    case "workspace_list":
    case "workspace_create":
    case "workspace_use":
    case "workspace_remove": {
      const wsMemberId = resolveCallerMemberId(roomId, actorRef);
      const reg = await import("../../member/workspaces.js");
      if (tool === "workspace_list") {
        const list = reg.readWorkspaces(wsMemberId);
        return {
          ok: true,
          active: list.active,
          workspaces: list.workspaces.map((w) => ({ id: w.id, kind: w.kind, description: w.description, root: w.root, builtin: w.builtin === true })),
        };
      }
      if (tool === "workspace_create") {
        const result = reg.createWorkspace(wsMemberId, {
          id: String(params?.id || ""),
          kind: "ssh",
          description: params?.description ? String(params.description) : undefined,
          host: String(params?.host || ""),
          port: params?.port !== undefined ? Number(params.port) : undefined,
          user: String(params?.user || ""),
          keyPath: params?.keyPath ? String(params.keyPath) : undefined,
          root: params?.root ? String(params.root) : undefined,
        });
        return result.ok ? { ok: true, workspace: { id: result.workspace.id, kind: result.workspace.kind, description: result.workspace.description, root: result.workspace.root } } : { ok: false, error: result.error };
      }
      if (tool === "workspace_use") {
        const result = reg.useWorkspace(wsMemberId, String(params?.id || ""));
        return result.ok ? { ok: true, active: result.active, workspace: { id: result.workspace.id, kind: result.workspace.kind, root: result.workspace.root } } : { ok: false, error: result.error };
      }
      const removed = reg.removeWorkspace(wsMemberId, String(params?.id || ""));
      return removed.ok ? { ok: true } : { ok: false, error: removed.error };
    }
    case "read":
    case "write":
    case "edit": {
      // Batch 7 P1: workspace-aware file tools (shadow pi built-ins by name).
      const fileMemberId = resolveCallerMemberId(roomId, actorRef);
      const fileTools = await import("./file-tools.js");
      if (tool === "read") return fileTools.workspaceReadTool(fileMemberId, params || {});
      if (tool === "write") return fileTools.workspaceWriteTool(fileMemberId, params || {});
      return fileTools.workspaceEditTool(fileMemberId, params || {});
    }
    case "terminal_create":
    case "terminal_exec":
    case "terminal_read":
    case "terminal_wait":
    case "terminal_list":
    case "terminal_close": {
      // Batch 7 P2: persistent terminals — member-owned, cross-scope.
      const shell = await import("../terminal/shell-manager.js");
      const shellMemberId = resolveCallerMemberId(roomId, actorRef);
      if (tool === "terminal_create") {
        const result = await shell.createShell({
          memberId: shellMemberId,
          name: params?.name ? String(params.name) : undefined,
          workspace: params?.workspace ? String(params.workspace) : undefined,
          cwd: params?.cwd ? String(params.cwd) : undefined,
        });
        return result.ok ? { ...result } : result;
      }
      if (tool === "terminal_exec") {
        const result = await shell.execInShell({
          signal:context?.signal,
          memberId: shellMemberId,
          shell: String(params?.terminalId || ""),
          command: params?.command !== undefined ? String(params.command) : undefined,
          keys: params?.keys !== undefined ? String(params.keys) : undefined,
          blockUntilMs: params?.blockSeconds !== undefined ? Math.round(Number(params.blockSeconds) * 1000) : undefined,
        });
        return result.ok ? { ...result } : result;
      }
      if (tool === "terminal_read") {
        const result = shell.readShell({
          memberId: shellMemberId,
          shell: String(params?.terminalId || ""),
          exec: params?.exec ? String(params.exec) : undefined,
          fromLine: params?.fromLine !== undefined ? Number(params.fromLine) : undefined,
          toLine: params?.toLine !== undefined ? Number(params.toLine) : undefined,
        });
        return result.ok
          ? { ok: true, status: result.status, exitCode: result.exitCode, lineStart: result.lineStart, lineEnd: result.lineEnd, truncated: result.truncated, lines: result.lines.map((l: { n: number; text: string }) => `${l.n}: ${l.text}`) }
          : result;
      }
      if (tool === "terminal_wait") {
        const result = await shell.waitShell({
          signal:context?.signal,
          memberId: shellMemberId,
          shell: String(params?.terminalId || ""),
          exec: String(params?.exec || ""),
          blockUntilMs: params?.blockSeconds !== undefined ? Math.round(Number(params.blockSeconds) * 1000) : undefined,
        });
        return result;
      }
      if (tool === "terminal_list") {
        return { ok: true, terminals: shell.listShells(shellMemberId) };
      }
      return shell.closeShell(shellMemberId, String(params?.terminalId || ""));
    }
    case "reload": {
      // Batch 6 §3: rebuild own session in the current scope, history kept.
      // roomId arrives scope-shaped ("dm:<id>" / room id).
      const { reloadMemberSession } = await import("../orchestrator/agent-manager.js");
      const reloadMemberId = resolveCallerMemberId(roomId, actorRef);
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
    case "member_list": {
      // Global member directory (gateway tool). id/name/description for member refs.
      const { listMembers } = await import("../../member/identity.js");
      const q = String(params?.query ?? "").trim().toLowerCase();
      let members = listMembers().map((m) => ({ id: m.id, name: m.name, description: m.title ?? "" }));
      if (q) {
        members = members.filter((m) =>
          m.name.toLowerCase().includes(q)
          || m.id.toLowerCase().includes(q)
          || m.description.toLowerCase().includes(q),
        );
      }
      const total = members.length;
      const offset = Math.max(0, Number(params?.offset ?? 0) || 0);
      const limit = Math.max(1, Math.min(Number(params?.limit ?? 50) || 50, 500));
      const page = members.slice(offset, offset + limit);
      return { ok: true, members: page, count: page.length, total };
    }
    case "chat_create": {
      // Group chat: creator becomes leader; invite by global member id.
      if (params?.cwd !== undefined) return { ok: false, error: "unknown parameter 'cwd' — chats no longer bind a working directory" };
      if (params?.memberIds !== undefined) return { ok: false, error: "unknown parameter 'memberIds' — use 'members' (member ids)" };
      if (params?.principles !== undefined) return { ok: false, error: "unknown parameter 'principles' — use 'description'" };
      const { getMember } = await import("../../member/identity.js");
      const creator = getMember(actorRef);
      if (!creator) return { ok: false, error: `Creator member not found: ${actorName()}` };

      const name = String(params?.name || "").trim();
      if (!name) return { ok: false, error: "name is required" };
      const inviteIds: string[] = Array.isArray(params?.members)
        ? params.members.map(String).filter(Boolean)
        : [];
      // Creator always in the room.
      const allIds = Array.from(new Set([creator.id, ...inviteIds]));
      const missing = allIds.filter((id) => !getMember(id));
      if (missing.length > 0) return { ok: false, error: `Unknown member id: ${missing.join(", ")}` };
      const invitees = allIds.map((id) => getMember(id)!);

      const description = typeof params?.description === "string" ? params.description.trim() : "";
      if (description.length > roomStore.ROOM_DESCRIPTION_MAX_CHARS) {
        return { ok: false, error: `description must be ${roomStore.ROOM_DESCRIPTION_MAX_CHARS} characters or fewer` };
      }

      let room;
      try {
        // DB members already have validated identities. Do not materialize
        // room-local drafts with the retired ASCII-only name validation.
        room = roomStore.createRoom(name, undefined, allIds, undefined, { promptLeaderMemberId: creator.id, description });
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }

      return {
        ok: true,
        chat: { id: `room:${room.id}`, kind: "room", name: room.name },
        members: invitees.map((m) => ({ id: m.id, name: m.name })),
      };
    }
    case "chat_edit": {
      if (params?.roomId !== undefined) return { ok: false, error: "unknown parameter 'roomId' — use 'chat' (a chat id or name)" };
      if (params?.principles !== undefined) return { ok: false, error: "unknown parameter 'principles' — use 'description'" };
      if (params?.addMemberIds !== undefined || params?.removeMemberIds !== undefined) return { ok: false, error: "unknown parameter — use 'add_members' / 'remove_members' (member ids)" };
      const { getMember } = await import("../../member/identity.js");
      const actorGlobal = getMember(actorRef);
      if (!actorGlobal) return { ok: false, error: `Member not found: ${actorName()}` };

      const ref = params?.chat !== undefined ? String(params.chat).trim() : "";
      if (!ref) return { ok: false, error: "chat is required — pass a chat id or name (see chat_list)" };
      const target = resolveChatTarget(roomId, { id: actorGlobal.id, name: actorGlobal.name }, ref);
      if (!target.ok) return { ok: false, error: target.error };
      if (target.roomId.startsWith("dm:") || isMmScopeId(target.roomId)) return { ok: false, error: "chat_edit edits group chats — a private chat has nothing to edit" };
      const targetRoomId = target.roomId;
      const room = roomStore.getRoom(targetRoomId);
      if (!room) return { ok: false, error: "Chat not found" };

      const actorLocal = roomStore.resolveRoomMemberRef(targetRoomId, actorRef);
      if (!actorLocal) {
        return { ok: false, error: "not_room_member", message: "You must be a member of this chat to edit it" };
      }

      if (typeof params?.name === "string" && params.name.trim()) {
        const renamed = roomStore.updateRoomName(targetRoomId, params.name.trim());
        if (!renamed) return { ok: false, error: "Failed to rename chat" };
      }

      if (typeof params?.description === "string") {
        const next = params.description.trim();
        if (next.length > roomStore.ROOM_DESCRIPTION_MAX_CHARS) {
          return { ok: false, error: `description must be ${roomStore.ROOM_DESCRIPTION_MAX_CHARS} characters or fewer` };
        }
        const updated = roomStore.updateRoomDescription(targetRoomId, next);
        if (!updated) return { ok: false, error: "Failed to update description" };
      }

      // Invite additions
      const addIds: string[] = Array.isArray(params?.add_members) ? params.add_members.map(String) : [];
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
      const removeIds: string[] = Array.isArray(params?.remove_members) ? params.remove_members.map(String) : [];
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
        chat: { id: `room:${targetRoomId}`, kind: "room", name: updated?.name || room.name },
        added,
        removed,
      };
    }
    default:
      throw new Error(unknownMemberToolMessage(tool));
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

/** Resolve a message's attachments for member-facing reads (fish No.16834):
 *  {originalFilename, path} — path is the attachment-store absolute path for the
 *  owning scope (room dir / DM dir), or "unavailable"
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
        absPath = attachmentStore.getAttachmentPath(scopeRoomId, a.storedFilename);
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
