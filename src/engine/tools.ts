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
import * as promptSupplementStore from "../workspace/prompt-supplement-store.js";
import { emitTaskEvent } from "../api/tasks.js";
import type { Task, TaskStatus, TaskPriority } from "../shared/types.js";
import { parseMentions } from "../communication/router.js";
import { emitAgentReply } from "./agent-manager.js";
import { getActivationSource } from "./activation-context.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage, SummaryMeta } from "../shared/types.js";

/** Max chars for tool result text. ~6K tokens, aligned with CLI output constraints. */
const MAX_RESULT_CHARS = 25_000;

function mentionIdsFromNames(message: string, roomMembers: Array<{ id: string; name: string }>): string[] {
  const byName = new Map(roomMembers.map((member) => [member.name, member.id]));
  return parseMentions(message, roomMembers.map((member) => member.name))
    .map((name) => byName.get(name))
    .filter((id): id is string => Boolean(id));
}

function messageMeta(meta: { attachments?: RoomMessageAttachment[]; senderMemberId?: string; senderName?: string; mentionMemberIds?: string[]; mentions?: string[] }) {
  const out: { attachments?: RoomMessageAttachment[]; senderMemberId?: string; mentionMemberIds?: string[] } = {};
  if (meta.attachments?.length) out.attachments = meta.attachments;
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
      let target = params?.target || "room";
      let message = params?.message || "";
      const source = getActivationSource(roomId, agentName);

      const attachments: RoomMessageAttachment[] = [];
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

      let warning: string | undefined;

      if (target === "user") {
        // Private reply: emit as agent_reply event, don't write to room messages
        // F11: no mention parsing/activation on private path
        emitAgentReply(roomId, agentName, message);
        logger.info("callback", "agent_reply", { roomId, agent: agentName, source: source || "unknown" });
        return warning ? { ok: true, target: "user", warning } : { ok: true, target: "user" };
      }

      const room = roomStore.getRoom(roomId);
      const roomMembers = ("getRoomMembers" in roomStore ? (roomStore as any).getRoomMembers(roomId) : undefined) || (room?.members || []).map((name: string) => ({ id: name, name, sourceAgent: name }));
      const senderMember = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef(roomId, agentName) : undefined;
      const mentions = room ? parseMentions(message, roomMembers.map((member: any) => member.name)) : [];
      const mentionMemberIds = room ? mentionIdsFromNames(message, roomMembers) : [];

      // Room message via message-bus (writes + broadcasts + notifies listeners)
      // Mention activation is handled by router listener via message-bus.
      const meta = messageMeta({ attachments, senderMemberId: senderMember?.id, senderName: agentName, mentionMemberIds, mentions });
      if (meta) postMessage(roomId, agentName, message, mentions, meta);
      else postMessage(roomId, agentName, message, mentions);

      return warning ? { ok: true, warning } : { ok: true };
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
        limit,
      };

      // No search filters — keep original fast path (latest N messages)
      const hasFilter = searchOpts.query || searchOpts.from ||
        searchOpts.after !== undefined || searchOpts.before !== undefined;

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
      return messages.map((m) => ({ sender: m.sender, content: m.content, ts: m.ts }));
    }
    case "read_prompt_supplement": {
      const actor = roomStore.resolveRoomMemberRef(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const scope = String(params?.scope || "member");
      if (scope !== "room" && scope !== "member") return { ok: false, error: "scope must be 'room' or 'member'" };
      const supplement = promptSupplementStore.readPromptSupplement(roomId, scope, scope === "member" ? actor.id : undefined);
      return {
        ok: true,
        scope,
        content: supplement.content,
        revision: supplement.revision,
        contentHash: supplement.contentHash,
        contentLength: supplement.contentLength,
        updatedAt: supplement.updatedAt,
        updatedBy: supplement.updatedBy,
        updatedByMemberId: supplement.updatedByMemberId,
        updatedByName: supplement.updatedByName,
        suggestedTemplate: supplement.content.trim() ? undefined : promptSupplementStore.PROMPT_SUPPLEMENT_TEMPLATE,
      };
    }
    case "write_prompt_supplement":
    case "edit_prompt_supplement": {
      const actor = roomStore.resolveRoomMemberRef(roomId, agentName);
      if (!actor) return { ok: false, error: "Current member is not in this room" };
      const room = roomStore.getRoom(roomId);
      if (!room) return { ok: false, error: "Room not found" };
      const scope = String(params?.scope || "member");
      if (scope !== "room" && scope !== "member") return { ok: false, error: "scope must be 'room' or 'member'" };
      if (scope === "room") {
        if (!room.promptLeaderMemberId) return { ok: false, error: "No room leader is configured; room supplement writes are disabled" };
        if (room.promptLeaderMemberId !== actor.id) return { ok: false, error: "Only the configured room leader can write the room supplement" };
      }
      try {
        const common = {
          roomId,
          scope: scope as promptSupplementStore.PromptSupplementScope,
          memberId: scope === "member" ? actor.id : undefined,
          actor: { type: "member" as const, memberId: actor.id, name: actor.name },
          note: params?.note ? String(params.note) : undefined,
        };
        const supplement = tool === "write_prompt_supplement"
          ? promptSupplementStore.writePromptSupplement({ ...common, content: String(params?.content ?? "") })
          : promptSupplementStore.editPromptSupplement({ ...common, oldText: String(params?.oldText ?? ""), newText: String(params?.newText ?? "") });
        return {
          ok: true,
          scope,
          revision: supplement.revision,
          contentHash: supplement.contentHash,
          contentLength: supplement.contentLength,
          message: "Saved. Applies on next member restart/reset/recreate.",
        };
      } catch (err: any) {
        return { ok: false, error: err.message || String(err) };
      }
    }
    case "create_task": {
      const title = params?.title ? String(params.title).trim() : "";
      if (!title) return { ok: false, error: "title is required" };
      const task = taskStore.createTask(roomId, {
        title,
        createdBy: agentName,
        status: (params?.status as TaskStatus) || "todo",
        priority: (params?.priority as TaskPriority) || "P1",
        assignee: params?.assignee ? String(params.assignee) : undefined,
        description: params?.description ? String(params.description) : undefined,
        references: Array.isArray(params?.references) ? params.references.map(String) : undefined,
        subscribers: Array.isArray(params?.subscribers) ? params.subscribers.map(String) : undefined,
      });
      emitTaskEvent(roomId, "created", task, agentName);
      return { ok: true, taskId: task.id, title: task.title, status: task.status };
    }
    case "update_task": {
      const taskId = params?.taskId ? String(params.taskId) : "";
      if (!taskId) return { ok: false, error: "taskId is required" };
      const before = taskStore.getTask(roomId, taskId);
      if (!before) return { ok: false, error: `Task not found: ${taskId}` };
      const patch: Parameters<typeof taskStore.updateTask>[2] = {};
      if (params?.title !== undefined) patch.title = String(params.title);
      if (params?.status !== undefined) patch.status = params.status as TaskStatus;
      if (params?.priority !== undefined) patch.priority = params.priority as TaskPriority;
      if (params?.assignee !== undefined) patch.assignee = params.assignee ? String(params.assignee) : undefined;
      if (params?.description !== undefined) patch.description = String(params.description);
      if (params?.references !== undefined) patch.references = Array.isArray(params.references) ? params.references.map(String) : [];
      if (params?.subscribers !== undefined) patch.subscribers = Array.isArray(params.subscribers) ? params.subscribers.map(String) : [];
      const updated = taskStore.updateTask(roomId, taskId, patch);
      if (!updated) return { ok: false, error: "Update failed" };
      const action = before.status !== updated.status ? "status_changed" : "updated";
      emitTaskEvent(roomId, action, updated, agentName);
      return { ok: true, taskId: updated.id, status: updated.status, title: updated.title };
    }
    case "list_tasks": {
      let tasks = taskStore.listTasks(roomId);
      if (params?.status) tasks = tasks.filter((t) => t.status === params.status);
      if (params?.assignee) tasks = tasks.filter((t) => t.assignee === String(params.assignee));
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
    case "request_approval": {
      const title = params?.title ? String(params.title).trim() : "";
      const summary = params?.summary ? String(params.summary).trim() : "";
      if (!title) return { ok: false, error: "title is required" };
      if (!summary) return { ok: false, error: "summary is required" };
      try {
        const { createGateAndAnnounce } = await import("../api/gates.js");
        const gate = createGateAndAnnounce(roomId, {
          title,
          summary,
          artifacts: Array.isArray(params?.artifacts) ? params.artifacts.map(String) : undefined,
          requestedBy: agentName,
          handoffTo: params?.handoff_to ? String(params.handoff_to) : undefined,
        });
        return {
          ok: true,
          gateId: gate.id,
          status: "pending",
          note: "Approval requested. STOP here — do not continue to the next stage. The user will approve or reject; you will be re-activated with their decision.",
        };
      } catch (err: any) {
        return { ok: false, error: String(err?.message || err) };
      }
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
    case "write_summary": {
      // P0 security: only summarizer agent can call this tool
      if (agentName !== "summarizer") {
        return { ok: false, error: "write_summary can only be called by the summarizer agent" };
      }

      const { title, summary, from_id, to_id } = params;
      if (!title || !summary || !from_id || !to_id) {
        return { ok: false, error: "Missing required fields: title, summary, from_id, to_id" };
      }

      // Read range of original messages to compute metadata
      const rangeMessages = messageStore.getMessagesByRange(roomId, from_id, to_id);
      if (rangeMessages.length === 0) {
        return { ok: false, error: `No messages found in range ${from_id} to ${to_id}` };
      }

      const participants = [...new Set(rangeMessages.map((m) => m.sender))];
      const timeFrom = rangeMessages[0].ts;
      const timeTo = rangeMessages[rangeMessages.length - 1].ts;

      const summaryMeta: SummaryMeta = {
        title,
        covered_range: { from_id, to_id, count: rangeMessages.length },
        time_range: { from: timeFrom, to: timeTo },
        participants,
      };

      // Agent-friendly content format
      const dateFrom = new Date(timeFrom).toISOString().slice(0, 10);
      const dateTo = new Date(timeTo).toISOString().slice(0, 10);
      const content = `[Summary | covers ${from_id} to ${to_id} | ${dateFrom} ~ ${dateTo}]\n## ${title}\n${summary}`;

      // Write directly to message-store (bypass postMessage to avoid router @mention parsing)
      const message = messageStore.addMessage(roomId, {
        sender: "summarizer",
        content,
        mentions: [],
        type: "summary",
        summary_meta: summaryMeta,
      });

      // Broadcast via WS
      broadcastToRoom(roomId, { type: "room:message", roomId, message });
      logger.info("summarizer", "summary written", { roomId, title, from_id, to_id, count: rangeMessages.length });

      return { ok: true, title, coveredCount: rangeMessages.length };
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
