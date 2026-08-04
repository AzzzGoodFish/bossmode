// Agent tool callback handler — business logic for chat/messages/summary tools
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { postMessage } from "../communication/message-bus.js";
import { broadcastToRoom } from "../communication/ws.js";
import * as messageStore from "../workspace/message-store.js";
import * as roomStore from "../workspace/room-store.js";
import * as taskStore from "../workspace/task-store.js";
import * as principlesStore from "../workspace/principles-store.js";
import * as mainlineStore from "../workspace/mainline-store.js";
import { emitTaskEvent } from "../api/tasks.js";
import type { Task, TaskStatus, TaskPriority } from "../shared/types.js";
import { parseMentions } from "../communication/router.js";
import { getActivationSource } from "./activation-context.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage } from "../shared/types.js";

/** Max chars for tool result text. ~6K tokens, aligned with CLI output constraints. */
const MAX_RESULT_CHARS = 25_000;

function mentionIdsFromNames(message: string, roomMembers: Array<{ id: string; name: string }>): string[] {
  const byName = new Map(roomMembers.map((member) => [member.name, member.id]));
  return parseMentions(message, roomMembers.map((member) => member.name))
    .map((name) => byName.get(name))
    .filter((id): id is string => Boolean(id));
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

function messageMeta(meta: { attachments?: RoomMessageAttachment[]; artifacts?: string[]; senderMemberId?: string; senderName?: string; mentionMemberIds?: string[]; mentions?: string[] }) {
  const out: { attachments?: RoomMessageAttachment[]; artifacts?: string[]; senderMemberId?: string; mentionMemberIds?: string[] } = {};
  if (meta.attachments?.length) out.attachments = meta.attachments;
  if (meta.artifacts?.length) out.artifacts = meta.artifacts;
  if (meta.senderMemberId && meta.senderMemberId !== meta.senderName) out.senderMemberId = meta.senderMemberId;
  if (meta.mentionMemberIds?.length && meta.mentionMemberIds.join("\0") !== (meta.mentions || []).join("\0")) out.mentionMemberIds = meta.mentionMemberIds;
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

      const room = roomStore.getRoom(roomId);
      const roomMembers = ("getRoomMembers" in roomStore ? (roomStore as any).getRoomMembers(roomId) : undefined) || (room?.members || []).map((name: string) => ({ id: name, name, sourceAgent: name }));
      const senderMember = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(roomId, agentName) : undefined;
      const mentions = room ? parseMentions(message, roomMembers.map((member: any) => member.name)) : [];
      const mentionMemberIds = room ? mentionIdsFromNames(message, roomMembers) : [];

      // Room message via message-bus (writes + broadcasts + notifies listeners)
      // Mention activation is handled by router listener via message-bus.
      const meta = messageMeta({ attachments, artifacts, senderMemberId: senderMember?.id, senderName: agentName, mentionMemberIds, mentions });
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
      const mentions = room ? parseMentions(content, roomMembers.map((member: any) => member.name)) : [];
      const meta = messageMeta({ senderMemberId: senderMember?.id, senderName: agentName, mentionMemberIds: room ? mentionIdsFromNames(content, roomMembers) : [], mentions });
      if (meta) postMessage(roomId, agentName, content, mentions, meta);
      else postMessage(roomId, agentName, content, mentions);
      return { ok: true };
    }
    case "query_room_messages": {
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

      const messages: RoomMessage[] = hasFilter
        ? messageStore.searchMessages(roomId, searchOpts).messages
        : messageStore.getMessages(roomId, { limit });

      // File output mode: write markdown file and return path (avoids 25K truncation)
      if (params?.output === "file") {
        const filePath = join(tmpdir(), `bossmode-search-${roomId.slice(0, 8)}-${randomUUID().slice(0, 8)}.md`);
        const content = renderMessagesAsMarkdown(messages, searchOpts);
        writeFileSync(filePath, content, "utf-8");
        logger.info("callback", "query_room_messages:file", { path: filePath, count: messages.length });
        return { ok: true, path: filePath, count: messages.length, format: "markdown" };
      }

      // Default: inline text (may be truncated by MAX_RESULT_CHARS)
      return messages.map((m) => ({ sender: m.sender, content: m.content, ts: m.ts, seq: m.seq }));
    }
    case "read_memory": {
      const actor = roomStore.resolveRoomMemberRef(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const asset = String(params?.asset || "");
      if (asset !== "principles" && asset !== "mainline") return { ok: false, error: "asset must be 'principles' or 'mainline'" };
      const scope = String(params?.scope || "member");
      if (asset === "mainline") {
        if (scope === "room") return { ok: false, error: "Mainline is member-level only; a room-level shared focus is not supported yet" };
        const mainline = mainlineStore.readMainlineWithBudget(roomId, actor.id);
        return {
          ok: true,
          asset,
          scope: "member",
          content: mainlineStore.resolveMainlineRefs(roomId, mainline.content),
          revision: mainline.revision,
          contentHash: mainline.contentHash,
          contentLength: mainline.contentLength,
          updatedAt: mainline.updatedAt,
          updatedBy: mainline.updatedBy,
          updatedByMemberId: mainline.updatedByMemberId,
          updatedByName: mainline.updatedByName,
          budget: mainline.budget,
          budgetHeader: principlesStore.formatBudgetHeader(mainline.budget),
          suggestedTemplate: mainline.content.trim() ? undefined : mainlineStore.MAINLINE_TEMPLATE,
        };
      }
      if (scope !== "room" && scope !== "member") return { ok: false, error: "scope must be 'room' or 'member'" };
      const principles = principlesStore.readPrinciplesWithBudget(roomId, scope, scope === "member" ? actor.id : undefined);
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
      const actor = roomStore.resolveRoomMemberRef(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const room = roomStore.getRoom(roomId);
      if (!room) return { ok: false, error: "Room not found" };
      const asset = String(params?.asset || "");
      if (asset !== "principles" && asset !== "mainline") return { ok: false, error: "asset must be 'principles' or 'mainline'" };
      const scope = String(params?.scope || "member");
      const reason = String(params?.reason ?? "").trim();
      if (!reason) return { ok: false, error: "reason is required — record the source of this change (user feedback, a decision, or curation)" };
      if (asset === "mainline") {
        if (scope === "room") return { ok: false, error: "Mainline is member-level only; a room-level shared focus is not supported yet" };
        try {
          const common = { roomId, memberId: actor.id, actor: { type: "member" as const, memberId: actor.id, name: actor.name }, reason };
          const mainline = tool === "write_memory"
            ? mainlineStore.writeMainline({ ...common, content: String(params?.content ?? "") })
            : mainlineStore.editMainline({ ...common, oldText: String(params?.oldText ?? ""), newText: String(params?.newText ?? "") });
          const budget = mainlineStore.readMainlineWithBudget(roomId, actor.id).budget;
          return {
            ok: true,
            asset,
            scope: "member",
            revision: mainline.revision,
            contentHash: mainline.contentHash,
            contentLength: mainline.contentLength,
            budget,
            budgetHeader: principlesStore.formatBudgetHeader(budget),
            message: "Saved. Applies on next member activation or Reload.",
          };
        } catch (err: any) {
          return { ok: false, error: err.message || String(err) };
        }
      }
      if (scope !== "room" && scope !== "member") return { ok: false, error: "scope must be 'room' or 'member'" };
      if (scope === "room") {
        if (!room.promptLeaderMemberId) return { ok: false, error: "No room leader is configured; room principles writes are disabled" };
        if (room.promptLeaderMemberId !== actor.id) return { ok: false, error: "Only the configured room leader can write the room principles" };
      }
      try {
        const common = {
          roomId,
          scope: scope as principlesStore.PrinciplesScope,
          memberId: scope === "member" ? actor.id : undefined,
          actor: { type: "member" as const, memberId: actor.id, name: actor.name },
          reason,
        };
        const principles = tool === "write_memory"
          ? principlesStore.writePrinciples({ ...common, content: String(params?.content ?? "") })
          : principlesStore.editPrinciples({ ...common, oldText: String(params?.oldText ?? ""), newText: String(params?.newText ?? "") });
        const budget = principlesStore.readPrinciplesWithBudget(roomId, scope as principlesStore.PrinciplesScope, scope === "member" ? actor.id : undefined).budget;
        return {
          ok: true,
          asset,
          scope,
          revision: principles.revision,
          contentHash: principles.contentHash,
          contentLength: principles.contentLength,
          budget,
          budgetHeader: principlesStore.formatBudgetHeader(budget),
          message: "Saved. Applies on next member activation or Reload.",
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
    case "list_tasks": {
      let tasks = taskStore.listTasks(roomId);
      if (params?.status) tasks = tasks.filter((t) => t.status === params.status);
      if (params?.assignee) tasks = tasks.filter((t) => taskAssigneeMatches(roomId, t, String(params.assignee)));
      return tasks.map((t) => ({
        id: t.id, title: t.title, status: t.status, priority: t.priority,
        assignee: t.assignee, createdBy: t.createdBy,
        references: t.references,
        subscribers: t.subscribers,
        commentCount: t.comments?.length ?? 0,
      }));
    }
    case "get_task": {
      const taskId = params?.taskId ? String(params.taskId) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      const task = taskStore.getTask(roomId, taskId);
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
