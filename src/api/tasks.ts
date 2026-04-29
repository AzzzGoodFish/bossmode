// Task API — CRUD for per-room tasks + global aggregation
import { addRoute, sendJson, parseBody } from "./index.js";
import * as taskStore from "../workspace/task-store.js";
import * as roomStore from "../workspace/room-store.js";
import { postMessage } from "../communication/message-bus.js";
import { broadcastToRoom } from "../communication/ws.js";
import { logger } from "../foundation/logger.js";
import type { Task, TaskEventMeta } from "../shared/types.js";

/** Emit a structured task_event system message + ws broadcast.
 *  When activateAssignee is true and the assignee is an agent in the room
 *  (not self, not same as previous), the system message includes a mention
 *  that triggers the existing router → activateAgent flow.
 */
export function emitTaskEvent(
  roomId: string,
  action: TaskEventMeta["action"],
  task: Task,
  actor: string,
  options?: { activateAssignee?: boolean; previousAssignee?: string },
): void {
  const meta: TaskEventMeta = {
    action,
    taskId: task.id,
    taskTitle: task.title,
    newStatus: action === "status_changed" ? task.status : undefined,
    actor,
  };

  // Human-readable system message
  const verb =
    action === "created" ? "created task" :
    action === "deleted" ? "deleted task" :
    action === "status_changed" ? `moved task to ${task.status}` :
    "updated task";
  const content = `[Task] ${actor} ${verb}: **${task.title}**`;

  // Determine if assignee should be auto-activated via mention
  const mentions: string[] = [];
  if (options?.activateAssignee && task.assignee) {
    const room = roomStore.getRoom(roomId);
    const isAgent = room?.members.includes(task.assignee) ?? false;
    const isSelfAssign = task.assignee === actor;
    const isReassignment = options.previousAssignee !== task.assignee;
    if (isAgent && !isSelfAssign && isReassignment) {
      mentions.push(task.assignee);
    }
  }

  // Write + broadcast + notify listeners (including router for mention activation)
  postMessage(roomId, "system", content, mentions, {
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

addRoute("GET", "/api/rooms/:id/tasks", async (_req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  sendJson(res, 200, taskStore.listTasks(params.id));
});

addRoute("POST", "/api/rooms/:id/tasks", async (req, res, params) => {
  if (!roomStore.getRoom(params.id)) { sendJson(res, 404, { error: "Room not found" }); return; }
  const body = (await parseBody(req)) as any;
  if (!body?.title) { sendJson(res, 400, { error: "title is required" }); return; }
  try {
    const task = taskStore.createTask(params.id, {
      title: String(body.title),
      createdBy: String(body.createdBy || "user"),
      status: body.status,
      priority: body.priority,
      assignee: body.assignee ? String(body.assignee) : undefined,
      description: body.description ? String(body.description) : undefined,
      references: Array.isArray(body.references) ? body.references.map(String) : undefined,
    });
    const actor = String(body.createdBy || "user");
    emitTaskEvent(params.id, "created", task, actor, {
      activateAssignee: true,
      previousAssignee: undefined,
    });
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
    if (body.assignee !== undefined) patch.assignee = body.assignee || undefined;
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.references !== undefined) patch.references = Array.isArray(body.references) ? body.references.map(String) : [];
    const updated = taskStore.updateTask(params.id, params.taskId, patch);
    if (!updated) { sendJson(res, 404, { error: "Task not found" }); return; }

    // Only emit system message for status change
    const action = before.status !== updated.status ? "status_changed" : "updated";
    const actor = String(body.updatedBy || "user");
    emitTaskEvent(params.id, action, updated, actor, {
      activateAssignee: true,
      previousAssignee: before.assignee,
    });
    sendJson(res, 200, updated);
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
