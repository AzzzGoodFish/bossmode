// Agent tool callback handler — business logic for chat/messages/summary tools
import { writeFileSync } from "node:fs";
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
import type { ScopeId } from "../shared/conversation-ref.js";
import { emitTaskEvent } from "../api/tasks.js";
import type { Task, TaskStatus, TaskPriority } from "../shared/types.js";
import { parseMentions, parseUrgentMentions } from "../communication/router.js";
import { getActivationSource } from "./activation-context.js";
import { isSystemNoticeHiddenFromMembers } from "../shared/runtime-error-limit.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage } from "../shared/types.js";

/** Max chars for tool result text. ~6K tokens, aligned with CLI output constraints. */
const MAX_RESULT_CHARS = 25_000;

/**
 * 0.20: tool `roomId` is the runtime scope key — a plain room id for room
 * scope, `dm:<memberId>` for DM scope. Member memory layers live in the
 * member-global store keyed by ScopeId (contract §6).
 */
function toolScopeId(roomId: string): ScopeId {
  return roomId.startsWith("dm:") ? roomId : `room:${roomId}`;
}

function resolveMemoryActor(roomId: string, agentName: string): { id: string; name: string } | null {
  if (roomId.startsWith("dm:")) {
    const member = getMember(roomId.slice("dm:".length));
    return member ? { id: member.id, name: member.name } : null;
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
    return { ok: true, roomId: access.kind === "dm" ? `dm:${access.memberId}` : access.roomId };
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

function messageMeta(meta: { attachments?: RoomMessageAttachment[]; artifacts?: string[]; senderMemberId?: string; senderName?: string; mentionMemberIds?: string[]; urgentMentions?: string[]; urgentMentionMemberIds?: string[]; mentions?: string[] }) {
  const out: { attachments?: RoomMessageAttachment[]; artifacts?: string[]; senderMemberId?: string; mentionMemberIds?: string[]; urgentMentions?: string[]; urgentMentionMemberIds?: string[] } = {};
  if (meta.attachments?.length) out.attachments = meta.attachments;
  if (meta.artifacts?.length) out.artifacts = meta.artifacts;
  if (meta.senderMemberId && meta.senderMemberId !== meta.senderName) out.senderMemberId = meta.senderMemberId;
  if (meta.mentionMemberIds?.length && meta.mentionMemberIds.join("\0") !== (meta.mentions || []).join("\0")) out.mentionMemberIds = meta.mentionMemberIds;
  if (meta.urgentMentions?.length) out.urgentMentions = meta.urgentMentions;
  if (meta.urgentMentionMemberIds?.length) out.urgentMentionMemberIds = meta.urgentMentionMemberIds;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Truncate a serialized tool result if it exceeds the limit. */
import { processAgentAttachments } from "./agent-attachments.js";
import { displayFilename, inferAttachmentPreviewType, type RoomMessageAttachment } from "../shared/attachments.js";

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
      const source = getActivationSource(roomId, agentName);

      const attachments: RoomMessageAttachment[] = [];
      const artifacts = Array.isArray(params?.artifacts)
        ? params.artifacts.map(String).map((value) => value.trim()).filter(Boolean)
        : [];
      // Process agent attachments (file paths → validate + copy → structured message metadata).
      // Absolute source/store paths are not written to room-visible message JSON.
      if (Array.isArray(params?.attachments) && params.attachments.length > 0) {
        const outcomes = await processAgentAttachments(roomId, params.attachments.map(String));
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

      // 0.20 DM scope: single scope-routed egress (dm store + broadcast + listeners).
      if (typeof roomId === "string" && roomId.startsWith("dm:")) {
        postMessage(roomId, agentName, message, [], {
          ...(attachments.length ? { attachments } : {}),
          ...(artifacts.length ? { artifacts } : {}),
        });
        return { ok: true };
      }

      const room = roomStore.getRoom(roomId);
      const roomMembers = ("getRoomMembers" in roomStore ? (roomStore as any).getRoomMembers(roomId) : undefined) || (room?.members || []).map((name: string) => ({ id: name, name, sourceAgent: name }));
      const senderMember = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(roomId, agentName) : undefined;
      const info = room ? mentionInfoFromText(message, roomMembers) : { mentions: [], mentionMemberIds: [], urgentMentions: [], urgentMentionMemberIds: [] };
      const { mentions, mentionMemberIds, urgentMentions, urgentMentionMemberIds } = info;

      // Room message via message-bus (writes + broadcasts + notifies listeners)
      // Mention activation is handled by router listener via message-bus.
      const meta = messageMeta({ attachments, artifacts, senderMemberId: senderMember?.id, senderName: agentName, mentionMemberIds, urgentMentions, urgentMentionMemberIds, mentions });
      if (meta) postMessage(roomId, agentName, message, mentions, meta);
      else postMessage(roomId, agentName, message, mentions);

      return { ok: true };
    }
    case "mention": {
      // Legacy — redirect to chat with textual @mention.
      // Mention activation is handled by router listener.
      const target = params?.agent || "";
      const message = params?.message || "";
      const content = target ? `@${target} ${message}`.trim() : message;
      const room = roomStore.getRoom(roomId);
      const roomMembers = ("getRoomMembers" in roomStore ? (roomStore as any).getRoomMembers(roomId) : undefined) || (room?.members || []).map((name: string) => ({ id: name, name, sourceAgent: name }));
      const senderMember = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(roomId, agentName) : undefined;
      const info = room ? mentionInfoFromText(content, roomMembers) : { mentions: [], mentionMemberIds: [], urgentMentions: [], urgentMentionMemberIds: [] };
      const mentions = info.mentions;
      const meta = messageMeta({ senderMemberId: senderMember?.id, senderName: agentName, mentionMemberIds: info.mentionMemberIds, urgentMentions: info.urgentMentions, urgentMentionMemberIds: info.urgentMentionMemberIds, mentions });
      if (meta) postMessage(roomId, agentName, content, mentions, meta);
      else postMessage(roomId, agentName, content, mentions);
      return { ok: true };
    }
    case "query_room_messages": {
      const qActor = resolveMemoryActor(roomId, agentName);
      if (!qActor) return { ok: false, error: "Current member is not in this room" };
      const target = resolveReadTarget(roomId, qActor, params?.scope);
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

      // No search filters — keep original fast path (latest N messages)
      const hasFilter = searchOpts.query || searchOpts.from ||
        searchOpts.after !== undefined || searchOpts.before !== undefined ||
        searchOpts.type !== undefined || searchOpts.aroundSeq !== undefined;

      let messages: RoomMessage[];
      if (targetRoomId.startsWith("dm:")) {
        // DM store has no query index — filter in memory with the same semantics.
        let all = readAllDmMessages(targetRoomId.slice("dm:".length));
        if (searchOpts.query) {
          const q = searchOpts.query.toLowerCase();
          all = all.filter((m) => (m.content || "").toLowerCase().includes(q));
        }
        if (searchOpts.from) all = all.filter((m) => m.sender === searchOpts.from);
        if (searchOpts.after !== undefined) all = all.filter((m) => (m.ts ?? 0) >= (searchOpts.after as number));
        if (searchOpts.before !== undefined) all = all.filter((m) => (m.ts ?? 0) <= (searchOpts.before as number));
        if (searchOpts.type) all = all.filter((m) => (m as any).type === searchOpts.type);
        if (searchOpts.aroundSeq !== undefined) {
          const center = all.findIndex((m) => m.seq === searchOpts.aroundSeq);
          if (center >= 0) {
            const half = Math.floor(limit / 2);
            all = all.slice(Math.max(0, center - half), center + half + 1);
          } else {
            all = [];
          }
        } else {
          all = all.slice(-limit);
        }
        messages = all;
      } else {
        messages = hasFilter
          ? messageStore.searchMessages(targetRoomId, searchOpts).messages
          : messageStore.getMessages(targetRoomId, { limit });
      }
      // Members never see system notices (runtime failures AND non-error system
      // prompts); typed task/knowledge events stay. Same filter as the
      // activation-context injection path (fish 2026-08-04).
      messages = messages.filter((m) => !isSystemNoticeHiddenFromMembers(m));

      // File output mode: write markdown file and return path (avoids 25K truncation)
      if (params?.output === "file") {
        const filePath = join(tmpdir(), `bossmode-search-${targetRoomId.replace(":", "-") .slice(0, 12)}-${randomUUID().slice(0, 8)}.md`);
        const content = renderMessagesAsMarkdown(messages, searchOpts);
        writeFileSync(filePath, content, "utf-8");
        logger.info("callback", "query_room_messages:file", { path: filePath, count: messages.length });
        return { ok: true, path: filePath, count: messages.length, format: "markdown" };
      }

      // Default: inline text (may be truncated by MAX_RESULT_CHARS)
      return messages.map((m) => ({ sender: m.sender, content: m.content, ts: m.ts, seq: m.seq }));
    }
    case "read_memory": {
      const actor = resolveMemoryActor(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const asset = String(params?.asset || "");
      if (asset !== "principles" && asset !== "mainline") return { ok: false, error: "asset must be 'principles' or 'mainline'" };
      const scope = String(params?.scope || "member");
      // Cross-scope read: optional target_scope ('room:<id>' | 'dm:<memberId>',
      // membership-checked) — default current scope.
      const memTarget = resolveReadTarget(roomId, actor, params?.target_scope);
      if (!memTarget.ok) return { ok: false, error: memTarget.error };
      const memRoomId = memTarget.roomId;
      if (asset === "mainline") {
        if (scope === "room") return { ok: false, error: "Mainline is member-level only; a room-level shared focus is not supported yet" };
        const info = readMemoryLayerInfo(actor.id, "mainline", toolScopeId(memRoomId));
        const content = memRoomId.startsWith("dm:") ? info.content : mainlineStore.resolveMainlineRefs(memRoomId, info.content);
        return {
          ok: true,
          asset,
          scope: "member",
          content,
          revision: info.revision,
          contentHash: info.contentHash,
          contentLength: info.contentLength,
          updatedAt: info.updatedAt,
          updatedBy: info.updatedBy,
          updatedByMemberId: info.updatedByMemberId,
          updatedByName: info.updatedByName,
          budget: info.budget,
          budgetHeader: principlesStore.formatBudgetHeader(info.budget),
          suggestedTemplate: info.content.trim() ? undefined : mainlineStore.MAINLINE_TEMPLATE,
        };
      }
      if (scope !== "room" && scope !== "member") return { ok: false, error: "scope must be 'room' or 'member'" };
      if (scope === "member") {
        const info = readMemoryLayerInfo(actor.id, "principles", toolScopeId(memRoomId));
        return {
          ok: true,
          asset,
          scope,
          content: info.content,
          revision: info.revision,
          contentHash: info.contentHash,
          contentLength: info.contentLength,
          updatedAt: info.updatedAt,
          updatedBy: info.updatedBy,
          updatedByMemberId: info.updatedByMemberId,
          updatedByName: info.updatedByName,
          budget: info.budget,
          budgetHeader: principlesStore.formatBudgetHeader(info.budget),
          suggestedTemplate: info.content.trim() ? undefined : principlesStore.PRINCIPLES_TEMPLATE,
        };
      }
      // Room principles — room-level shared asset, still room-keyed (contract §6).
      if (memRoomId.startsWith("dm:")) return { ok: false, error: "Room principles are not available in a DM scope" };
      const principles = principlesStore.readPrinciplesWithBudget(memRoomId, "room");
      return {
        ok: true,
        asset,
        scope,
        content: principles.content,
        revision: principles.revision,
        contentHash: principles.contentHash,
        contentLength: principles.contentLength,
        updatedAt: principles.updatedAt,
        updatedBy: principles.updatedBy,
        updatedByMemberId: principles.updatedByMemberId,
        updatedByName: principles.updatedByName,
        budget: principles.budget,
        budgetHeader: principlesStore.formatBudgetHeader(principles.budget),
        suggestedTemplate: principles.content.trim() ? undefined : principlesStore.PRINCIPLES_TEMPLATE,
      };
    }
    case "write_memory":
    case "edit_memory": {
      const actor = resolveMemoryActor(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const asset = String(params?.asset || "");
      if (asset !== "principles" && asset !== "mainline") return { ok: false, error: "asset must be 'principles' or 'mainline'" };
      const scope = String(params?.scope || "member");
      const reason = String(params?.reason ?? "").trim();
      if (!reason) return { ok: false, error: "reason is required — record the source of this change (user feedback, a decision, or curation)" };
      const memoryActor = { type: "member" as const, memberId: actor.id, name: actor.name };
      if (asset === "mainline") {
        if (scope === "room") return { ok: false, error: "Mainline is member-level only; a room-level shared focus is not supported yet" };
        try {
          const scopeId = toolScopeId(roomId);
          if (tool === "write_memory") {
            writeMemoryLayer(actor.id, "mainline", String(params?.content ?? ""), memoryActor, { scopeId, reason, operation: "write" });
          } else {
            editMemoryLayer(actor.id, "mainline", String(params?.oldText ?? ""), String(params?.newText ?? ""), memoryActor, { scopeId, reason });
          }
          const info = readMemoryLayerInfo(actor.id, "mainline", scopeId);
          return {
            ok: true,
            asset,
            scope: "member",
            revision: info.revision,
            contentHash: info.contentHash,
            contentLength: info.contentLength,
            budget: info.budget,
            budgetHeader: principlesStore.formatBudgetHeader(info.budget),
            message: "Applies on Reload or a fresh session — a running session keeps its already-compiled prompt.",
          };
        } catch (err: any) {
          return { ok: false, error: err.message || String(err) };
        }
      }
      if (scope !== "room" && scope !== "member") return { ok: false, error: "scope must be 'room' or 'member'" };
      if (scope === "member") {
        try {
          const scopeId = toolScopeId(roomId);
          if (tool === "write_memory") {
            writeMemoryLayer(actor.id, "principles", String(params?.content ?? ""), memoryActor, { scopeId, reason, operation: "write" });
          } else {
            editMemoryLayer(actor.id, "principles", String(params?.oldText ?? ""), String(params?.newText ?? ""), memoryActor, { scopeId, reason });
          }
          const info = readMemoryLayerInfo(actor.id, "principles", scopeId);
          return {
            ok: true,
            asset,
            scope,
            revision: info.revision,
            contentHash: info.contentHash,
            contentLength: info.contentLength,
            budget: info.budget,
            budgetHeader: principlesStore.formatBudgetHeader(info.budget),
            message: "Applies on Reload or a fresh session — a running session keeps its already-compiled prompt.",
          };
        } catch (err: any) {
          return { ok: false, error: err.message || String(err) };
        }
      }
      // Room principles — room-level shared asset, still room-keyed; leader-only writes.
      if (roomId.startsWith("dm:")) return { ok: false, error: "Room principles are not available in a DM scope" };
      const room = roomStore.getRoom(roomId);
      if (!room) return { ok: false, error: "Room not found" };
      if (!room.promptLeaderMemberId) return { ok: false, error: "No room leader is configured; room principles writes are disabled" };
      if (room.promptLeaderMemberId !== actor.id) return { ok: false, error: "Only the configured room leader can write the room principles" };
      try {
        const common = {
          roomId,
          scope: "room" as principlesStore.PrinciplesScope,
          memberId: undefined,
          actor: memoryActor,
          reason,
        };
        const principles = tool === "write_memory"
          ? principlesStore.writePrinciples({ ...common, content: String(params?.content ?? "") })
          : principlesStore.editPrinciples({ ...common, oldText: String(params?.oldText ?? ""), newText: String(params?.newText ?? "") });
        const budget = principlesStore.readPrinciplesWithBudget(roomId, "room").budget;
        return {
          ok: true,
          asset,
          scope,
          revision: principles.revision,
          contentHash: principles.contentHash,
          contentLength: principles.contentLength,
          budget,
          budgetHeader: principlesStore.formatBudgetHeader(budget),
          message: "Applies on Reload or a fresh session — a running session keeps its already-compiled prompt.",
        };
      } catch (err: any) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    case "create_task": {
      const title = params?.title ? String(params.title).trim() : "";
      if (!title) return { ok: false, error: "title is required" };
      try {
        const assignee = resolveTaskAssignee(roomId, params?.assignee);
        const subscribers = resolveTaskSubscribers(roomId, params?.subscribers);
        const task = taskStore.createTask(roomId, {
          title,
          createdBy: agentName,
          status: (params?.status as TaskStatus) || "todo",
          priority: (params?.priority as TaskPriority) || "P1",
          assignee: assignee?.name,
          assigneeMemberId: assignee?.memberId,
          description: params?.description ? String(params.description) : undefined,
          references: Array.isArray(params?.references) ? params.references.map(String) : undefined,
          subscribers: subscribers?.names,
          subscriberMemberIds: subscribers?.memberIds,
        });
        emitTaskEvent(roomId, "created", task, agentName);
        return { ok: true, taskId: task.id, title: task.title, status: task.status };
      } catch (err: any) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    case "update_task": {
      const taskId = params?.taskId ? String(params.taskId) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      const before = taskStore.getTask(roomId, taskId);
      if (!before) return { ok: false, error: `Task not found: ${taskId}` };
      try {
        const patch: Parameters<typeof taskStore.updateTask>[2] = {};
        if (params?.title !== undefined) patch.title = String(params.title);
        if (params?.status !== undefined) patch.status = params.status as TaskStatus;
        if (params?.priority !== undefined) patch.priority = params.priority as TaskPriority;
        if (params?.assignee !== undefined) {
          const assignee = resolveTaskAssignee(roomId, params.assignee);
          patch.assignee = assignee?.name;
          patch.assigneeMemberId = assignee?.memberId;
        }
        if (params?.description !== undefined) patch.description = String(params.description);
        if (params?.references !== undefined) patch.references = Array.isArray(params.references) ? params.references.map(String) : [];
        if (params?.subscribers !== undefined) {
          const subscribers = resolveTaskSubscribers(roomId, params.subscribers) || { names: [], memberIds: [] };
          patch.subscribers = subscribers.names;
          patch.subscriberMemberIds = subscribers.memberIds;
        }
        const updated = taskStore.updateTask(roomId, taskId, patch);
        if (!updated) return { ok: false, error: "Update failed" };
        const action = before.status !== updated.status ? "status_changed" : "updated";
        emitTaskEvent(roomId, action, updated, agentName);
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
      if (!tTarget.ok) return { ok: false, error: tTarget.error };
      if (tTarget.roomId.startsWith("dm:")) return { ok: false, error: "Tasks are room-scoped — a DM scope has no task list" };
      const tasksRoomId = tTarget.roomId;
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
      if (!gTarget.ok) return { ok: false, error: gTarget.error };
      if (gTarget.roomId.startsWith("dm:")) return { ok: false, error: "Tasks are room-scoped — a DM scope has no task list" };
      const taskId = params?.taskId ? String(params.taskId) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      const task = taskStore.getTask(gTarget.roomId, taskId);
      if (!task) return { ok: false, error: `Task not found: ${taskId}` };
      return truncateToolResult(renderTaskAsMarkdown(task));
    }
    case "comment_task": {
      const taskId = params?.taskId ? String(params.taskId) : "";
      const comment = params?.comment ? String(params.comment) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      if (!comment.trim()) return { ok: false, error: "comment is required" };
      const result = taskStore.addTaskComment(roomId, taskId, { author: agentName, content: comment });
      if (!result) return { ok: false, error: `Task not found: ${taskId}` };
      emitTaskEvent(roomId, "commented", result.task, agentName, { commentId: result.comment.id });
      return { ok: true, taskId: result.task.id, commentId: result.comment.id };
    }
    case "query_integration": {
      const provider = String(params?.provider || "linear");
      if (provider !== "linear") return { ok: false, error: `Unsupported integration provider: ${provider}` };
      const { getLinearApiKey, getRoomLinearIntegration } = await import("../integrations/linear-settings.js");
      const { LinearClient, findTeam } = await import("../integrations/linear-client.js");
      const apiKey = getLinearApiKey();
      if (!apiKey) return { ok: true, provider, connected: false, guidance: "Configure Linear API key in Settings → Integrations first." };
      try {
        const client = new LinearClient(apiKey);
        const [viewer, teams] = await Promise.all([client.viewer(), client.listTeams()]);
        const config = getRoomLinearIntegration(roomId);
        const teamQuery = params?.team ? String(params.team) : undefined;
        const projectTeam = teamQuery ? findTeam(teams, teamQuery) : (config ? teams.find((t) => t.id === config.teamId) : undefined);
        const projects = projectTeam ? await client.listProjects(projectTeam.id) : [];
        return {
          ok: true,
          provider,
          connected: true,
          viewer,
          current: config || null,
          teams: teams.map((t) => ({ id: t.id, name: t.name, key: t.key })),
          projects,
        };
      } catch (err: any) {
        return { ok: false, provider, connected: false, error: err.message || String(err) };
      }
    }
    case "configure_integration": {
      const provider = String(params?.provider || "linear");
      if (provider !== "linear") return { ok: false, error: `Unsupported integration provider: ${provider}` };
      if (params?.apiKey || params?.api_key || params?.linear_api_key) return { ok: false, error: "API keys must be configured in Settings, not through agent tools." };
      const { getLinearApiKey, saveRoomLinearIntegration } = await import("../integrations/linear-settings.js");
      const { LinearClient, findTeam, findProject } = await import("../integrations/linear-client.js");
      const apiKey = getLinearApiKey();
      if (!apiKey) return { ok: false, error: "Configure Linear API key in Settings → Integrations first." };
      const client = new LinearClient(apiKey);
      const teams = await client.listTeams();
      const teamInput = params?.team ? String(params.team) : "";
      if (!teamInput) return { ok: false, error: "team is required", teams: teams.map((t) => ({ id: t.id, name: t.name, key: t.key })) };
      const team = findTeam(teams, teamInput);
      if (!team) return { ok: false, error: `Linear team not found: ${teamInput}`, teams: teams.map((t) => ({ id: t.id, name: t.name, key: t.key })) };
      const projects = await client.listProjects(team.id);
      const projectInput = params?.project ? String(params.project) : "";
      const project = projectInput ? findProject(projects, projectInput) : undefined;
      if (projectInput && !project) return { ok: false, error: `Linear project not found in ${team.name}: ${projectInput}`, projects };
      const config = saveRoomLinearIntegration(roomId, {
        teamId: team.id,
        teamName: team.name,
        teamKey: team.key,
        projectId: project?.id,
        projectName: project?.name,
        enabled: params?.enabled !== false,
      });
      return { ok: true, provider, configured: config, projects };
    }
    case "member_status": {
      // Room-scope read-only live status (same source as the member panel lamp).
      const room = roomStore.getRoom(roomId);
      if (!room) return { ok: false, error: "Room not found" };
      const { getRoomMemberStatusReport } = await import("./agent-manager.js");
      const memberRef = params?.member !== undefined ? String(params.member).trim() : "";
      const report = getRoomMemberStatusReport(roomId, memberRef || undefined);
      if (!report) return { ok: false, error: `Member not found: ${memberRef}` };
      return { ok: true, members: report };
    }
    case "wait": {
      // 0.20: wait available to all room members (no longer leader-only).
      const room = roomStore.getRoom(roomId);
      const actor = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(roomId, agentName) : undefined;
      if (!room || !actor) return { ok: false, error: "Room or member not found" };

      const targetRef = String(params?.member || "").trim();
      if (!targetRef) return { ok: false, error: "member is required" };
      const target = (roomStore as any).resolveRoomMemberRef(roomId, targetRef);
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

      const targetRoomId = String(params?.roomId || roomId || "").trim();
      if (!targetRoomId) return { ok: false, error: "roomId is required" };
      const room = roomStore.getRoom(targetRoomId);
      if (!room) return { ok: false, error: "Room not found" };

      // Leader gate: promptLeaderGlobalMemberId / promptLeaderMemberId (mem_*) vs actor.
      const actorLocal = roomStore.resolveRoomMemberRef(targetRoomId, agentName);
      if (!actorLocal) {
        return { ok: false, error: "not_room_leader", message: "Only the room leader can edit this room" };
      }
      const leaderId = room.promptLeaderGlobalMemberId || room.promptLeaderMemberId;
      const actorGlobalId = roomStore.resolveGlobalMemberId(room, actorLocal) || actorLocal.id;
      if (!leaderId || (leaderId !== actorLocal.id && leaderId !== actorGlobalId)) {
        return { ok: false, error: "not_room_leader", message: "Only the room leader can edit this room" };
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

function renderMessagesAsMarkdown(messages: RoomMessage[], opts: messageStore.SearchOptions): string {
  const header = [
    "# Message Search Results\n",
    opts.query ? `**Query**: \`${opts.query}\`  ` : "",
    opts.from ? `**From**: \`${opts.from}\`  ` : "",
    `**Count**: ${messages.length}`,
    "\n---\n",
  ].filter(Boolean).join("\n");

  const body = messages.map((m) => {
    const time = new Date(m.ts).toISOString();
    return `## [${m.sender}] ${time}\n\n${m.content}`;
  }).join("\n\n---\n\n");

  return header + "\n" + body;
}
