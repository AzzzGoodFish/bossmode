// Task API — CRUD for per-room tasks + global aggregation
import { addRoute, sendJson, parseBody } from "./index.js";
import * as taskStore from "../workspace/task-store.js";
import * as roomStore from "../workspace/room-store.js";
import { queryRoomTasks } from "../workspace/db/tasks-index.js";
import { postMessage } from "../communication/message-bus.js";
import { broadcastToRoom } from "../communication/ws.js";
import { logger } from "../foundation/logger.js";
import type { RoomMemberRecord, Task, TaskEventMeta } from "../shared/types.js";

/** Trim a body of text to a one-line-ish chat snippet. */
function toSnippet(text: string | undefined, max = 280): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
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
  const members: RoomMemberRecord[] = [];
  for (const value of values) {
    const raw = String(value ?? "").trim();
    if (!raw) continue;
    const member = roomStore.resolveRoomMemberRef(roomId, raw);
    if (!member) throw new Error(`Subscriber is not a room member: ${raw}`);
    if (!members.some((entry) => entry.id === member.id)) members.push(member);
  }
  return { names: members.map((member) => member.name), memberIds: members.map((member) => member.id) };
}

/** Emit a structured task_event system message + ws broadcast. */
export function emitTaskEvent(
  roomId: string,
  action: TaskEventMeta["action"],
  task: Task,
  actor: string,
  opts: { commentId?: string } = {},
): void {
  // Inline snippet: surface the actual content into chat so the timeline
  // stays informative without forcing a jump to the task page.
  let snippet: string | undefined;
  if (action === "created") {
    snippet = toSnippet(task.description);
  } else if (action === "commented" && opts.commentId) {
    const comment = task.comments?.find((c) => c.id === opts.commentId);
    snippet = toSnippet(comment?.content);
  }

  const meta: TaskEventMeta = {
    action,
    taskId: task.id,
    taskTitle: task.title,
    newStatus: action === "status_changed" ? task.status : undefined,
    commentId: opts.commentId,
    actor,
    snippet,
  };

  // Human-readable system message
  const verb =
    action === "created" ? "created task" :
    action === "deleted" ? "deleted task" :
    action === "status_changed" ? `moved task to ${task.status}` :
    action === "commented" ? "commented on task" :
    "updated task";
  const content = `[Task] ${actor} ${verb}: **${task.title}**`;

  // Task assignment is metadata only. Activation happens exclusively through chat @mentions.
  postMessage(roomId, "system", content, [], {
    type: "task_event",
    task_event_meta: meta,
  });

  // Also broadcast dedicated ws event for real-time UI updates (no message stream)
  const wsType = action === "deleted" ? "task:deleted" :
    action === "created" ? "task:created" : "task:updated";

  if (wsType === "task:deleted") {
    broadcastToRoom(roomId, { type: "task:deleted", roomId, taskId: task.id });
  } else {
    broadcastToRoom(roomId, { type: wsType as "task:created" | "task:updated", roomId, task });
  }

  logger.info("task-api", "task event", { roomId, action, taskId: task.id, actor });
}

// -- Global --

addRoute("GET", "/api/tasks", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const opts: Parameters<typeof taskStore.listAllTasks>[0] = {
    status: (url.searchParams.get("status") as any) || undefined,
    query: url.searchParams.get("query") || undefined,
  };
  sendJson(res, 200, taskStore.listAllTasks(opts));
});

// -- Per-room --

addRoute("GET", "/api/rooms/:id/tasks", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const url = new URL(req.url || "", "http://localhost");
  const status = (url.searchParams.get("status") as any) || undefined;
  const assignee = url.searchParams.get("assignee") || undefined;
  const q = url.searchParams.get("q") || undefined;
  const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!, 10) : undefined;
  const offset = url.searchParams.get("offset") ? parseInt(url.searchParams.get("offset")!, 10) : undefined;
  const wantsQuery = Boolean(status || assignee || q || limit !== undefined || offset !== undefined);

  // DB-backed list (filters + pagination) when the caller asks for it; else the
  // legacy bare-array shape the current UI expects. Falls back to file store if
  // the projection is unavailable.
  if (wantsQuery) {
    const result = queryRoomTasks(params.id, { status, assignee, q, limit, offset });
    if (result) { sendJson(res, 200, result); return; }
    // Fallback: filter the file-backed list in memory.
    let items = taskStore.listTaskSummaries(params.id);
    if (status) items = items.filter((t) => t.status === status);
    if (assignee) items = items.filter((t) => t.assignee === assignee);
    if (q) items = items.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));
    const total = items.length;
    if (offset) items = items.slice(offset);
    if (limit && limit > 0) items = items.slice(0, limit);
    sendJson(res, 200, { tasks: items, total });
    return;
  }
  sendJson(res, 200, taskStore.listTaskSummaries(params.id));
});

addRoute("GET", "/api/rooms/:id/tasks/:taskId", async (_req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const task = taskStore.getTask(params.id, params.taskId);
  if (!task) { sendJson(res, 404, { error: "Task not found" }); return; }
  sendJson(res, 200, task);
});

addRoute("POST", "/api/rooms/:id/tasks", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const body = (await parseBody(req)) as any;
  if (!body?.title) { sendJson(res, 400, { error: "title is required" }); return; }
  try {
    const assignee = resolveTaskAssignee(params.id, body.assignee);
    const subscribers = resolveTaskSubscribers(params.id, body.subscribers);
    const task = taskStore.createTask(params.id, {
      title: String(body.title),
      createdBy: String(body.createdBy || "user"),
      status: body.status,
      priority: body.priority,
      assignee: assignee?.name,
      assigneeMemberId: assignee?.memberId,
      description: body.description ? String(body.description) : undefined,
      references: Array.isArray(body.references) ? body.references.map(String) : undefined,
      subscribers: subscribers?.names,
      subscriberMemberIds: subscribers?.memberIds,
    });
    const actor = String(body.createdBy || "user");
    emitTaskEvent(params.id, "created", task, actor);
    sendJson(res, 200, task);
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

addRoute("PATCH", "/api/rooms/:id/tasks/:taskId", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const body = (await parseBody(req)) as any;
  const before = taskStore.getTask(params.id, params.taskId);
  if (!before) { sendJson(res, 404, { error: "Task not found" }); return; }
  try {
    const patch: Parameters<typeof taskStore.updateTask>[2] = {};
    if (body.title !== undefined) patch.title = String(body.title);
    if (body.status !== undefined) patch.status = body.status;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.assignee !== undefined) {
      const assignee = resolveTaskAssignee(params.id, body.assignee);
      patch.assignee = assignee?.name;
      patch.assigneeMemberId = assignee?.memberId;
    }
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.references !== undefined) patch.references = Array.isArray(body.references) ? body.references.map(String) : [];
    if (body.subscribers !== undefined) {
      const subscribers = resolveTaskSubscribers(params.id, body.subscribers) || { names: [], memberIds: [] };
      patch.subscribers = subscribers.names;
      patch.subscriberMemberIds = subscribers.memberIds;
    }
    const updated = taskStore.updateTask(params.id, params.taskId, patch);
    if (!updated) { sendJson(res, 404, { error: "Task not found" }); return; }

    // Only emit system message for status change
    const action = before.status !== updated.status ? "status_changed" : "updated";
    const actor = String(body.updatedBy || "user");
    emitTaskEvent(params.id, action, updated, actor);
    sendJson(res, 200, updated);
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

addRoute("POST", "/api/rooms/:id/tasks/:taskId/comments", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const body = (await parseBody(req)) as any;
  try {
    const actor = String(body.author || "user");
    const result = taskStore.addTaskComment(params.id, params.taskId, {
      author: actor,
      content: String(body.comment || ""),
    });
    if (!result) { sendJson(res, 404, { error: "Task not found" }); return; }
    emitTaskEvent(params.id, "commented", result.task, actor, { commentId: result.comment.id });
    sendJson(res, 200, result.task);
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

addRoute("DELETE", "/api/rooms/:id/tasks/:taskId", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const body = (await parseBody(req)) as any;
  const task = taskStore.getTask(params.id, params.taskId);
  if (!task) { sendJson(res, 404, { error: "Task not found" }); return; }
  const deleted = taskStore.deleteTask(params.id, params.taskId);
  if (!deleted) { sendJson(res, 404, { error: "Task not found" }); return; }
  emitTaskEvent(params.id, "deleted", task, String(body?.deletedBy || "user"));
  sendJson(res, 200, { ok: true });
});
