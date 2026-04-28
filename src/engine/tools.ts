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
import { emitTaskEvent } from "../api/tasks.js";
import type { TaskStatus, TaskPriority } from "../shared/types.js";
import { parseMentions } from "../communication/router.js";
import { emitAgentReply } from "./agent-manager.js";
import { getActivationSource } from "./activation-context.js";
import { logger } from "../foundation/logger.js";
import type { RoomMessage, SummaryMeta } from "../shared/types.js";

/** Max chars for tool result text. ~6K tokens, aligned with Claude Code conventions. */
const MAX_RESULT_CHARS = 25_000;

/** Truncate a serialized tool result if it exceeds the limit. */
import { processAgentAttachments } from "./agent-attachments.js";

export function truncateToolResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const truncated = text.slice(0, MAX_RESULT_CHARS);
  return truncated + `\n\n--- Result truncated (${text.length} chars exceeded ${MAX_RESULT_CHARS} limit). Use a more specific query to get smaller results. ---`;
}

/** Handle a tool callback from an agent runtime (pi-cli extension or claude MCP) */
export async function handleToolCallback(
  tool: string,
  roomId: string,
  agentName: string,
  params: Record<string, any>,
): Promise<unknown> {
  logger.info("callback", "tool-callback", { tool, room: roomId, agent: agentName });

  switch (tool) {
    case "chat": {
      const mentions: string[] = Array.isArray(params?.mentions) ? params.mentions : [];
      let target = params?.target || "room";
      let message = params?.message || "";
      const source = getActivationSource(roomId, agentName);

      // Process agent attachments (file paths → validate + copy → append Attachment lines)
      if (Array.isArray(params?.attachments) && params.attachments.length > 0) {
        const outcomes = await processAgentAttachments(roomId, params.attachments.map(String));
        const lines: string[] = [];
        const errors: string[] = [];
        for (const o of outcomes) {
          if (o.ok) {
            lines.push(`Attachment: [original filename: ${o.originalFilename}](${o.absolutePath})`);
          } else {
            errors.push(`${o.path}: ${o.error}`);
          }
        }
        if (lines.length > 0) {
          message = message ? `${message}\n${lines.join("\n")}` : lines.join("\n");
        }
        if (errors.length > 0) {
          const errorMsg = errors.join("; ");
          if (lines.length === 0) {
            return { ok: false, error: `Attachment failed: ${errorMsg}` };
          }
          message += `\n(Attachment errors: ${errorMsg})`;
        }
      }

      let warning: string | undefined;
      if (target === "user" && source === "room_mention") {
        target = "room";
        warning = "target: \"user\" is not allowed when activated from a room @mention. Server rewrote to \"room\". Your message was posted to the room.";
        logger.warn("callback", "target_rewrite", {
          roomId,
          agent: agentName,
          originalTarget: "user",
          rewrittenTo: "room",
          reason: "activated_from_room_mention",
          source,
        });
      }

      if (target === "user") {
        // Private reply: emit as agent_reply event, don't write to room messages
        // F11: no mention parsing/activation on private path
        emitAgentReply(roomId, agentName, message);
        logger.info("callback", "agent_reply", { roomId, agent: agentName, source: source || "unknown" });
        return warning ? { ok: true, target: "user", warning } : { ok: true, target: "user" };
      }

      // Room message via message-bus (writes + broadcasts + notifies listeners)
      // Mention activation is handled by router listener via message-bus.
      postMessage(roomId, agentName, message, mentions);

      // Soft warning: content contains @mentions not listed in mentions[]
      try {
        const room = roomStore.getRoom(roomId);
        if (!room) return warning ? { ok: true, warning } : { ok: true };

        const contentMentions = parseMentions(message, room.members).filter((m) => m !== agentName);
        const orphanMentions = contentMentions.filter((m) => !mentions.includes(m));
        if (orphanMentions.length > 0) {
          const mentionList = orphanMentions.map((m) => `@${m}`).join(", ");
          const mentionArray = orphanMentions.map((m) => `"${m}"`).join(", ");
          const orphanWarning = `Content contains ${mentionList} but mentions[] does not include them. If you meant to activate them, resend with mentions: [${mentionArray}]. If this was only a reference, no action needed.`;
          return {
            ok: true,
            warning: warning ? `${warning} ${orphanWarning}` : orphanWarning,
          };
        }
      } catch {
        // Silent degrade on warning-analysis failure
      }

      return warning ? { ok: true, warning } : { ok: true };
    }
    case "mention": {
      // Legacy — redirect to chat with mentions
      // Mention activation is handled by router listener.
      const target = params?.agent || "";
      postMessage(roomId, agentName, params?.message || "", [target]);
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
      });
      emitTaskEvent(roomId, "created", task, agentName, {
        activateAssignee: true,
        previousAssignee: undefined,
      });
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
      const updated = taskStore.updateTask(roomId, taskId, patch);
      if (!updated) return { ok: false, error: "Update failed" };
      const action = before.status !== updated.status ? "status_changed" : "updated";
      emitTaskEvent(roomId, action, updated, agentName, {
        activateAssignee: true,
        previousAssignee: before.assignee,
      });
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
      }));
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
