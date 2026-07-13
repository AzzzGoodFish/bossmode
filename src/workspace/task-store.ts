// Task store — per-room task CRUD, backed by rooms/<id>/tasks.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir, listRooms } from "./room-store.js";
import type { Task, TaskStatus, TaskPriority, TaskComment, TaskListItem } from "../shared/types.js";

function tasksPath(roomId: string): string {
  return join(roomDir(roomId), "tasks.json");
}

function uniqueStrings(values: unknown[] | undefined): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const s = String(value ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    result.push(s);
  }
  return result;
}

function normalizeComment(raw: any): TaskComment | null {
  if (!raw || typeof raw !== "object") return null;
  const content = String(raw.content ?? "").trim();
  const author = String(raw.author ?? "").trim();
  if (!content || !author) return null;
  return {
    id: String(raw.id || `comment-${randomUUID().slice(0, 8)}`),
    author,
    content,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

function normalizeTask(raw: any): Task {
  const comments = Array.isArray(raw?.comments)
    ? raw.comments.map(normalizeComment).filter((c: TaskComment | null): c is TaskComment => Boolean(c))
    : [];
  return {
    ...raw,
    comments,
    subscribers: uniqueStrings(raw?.subscribers),
    subscriberMemberIds: uniqueStrings(raw?.subscriberMemberIds),
  } as Task;
}

function readTasks(roomId: string): Task[] {
  const p = tasksPath(roomId);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(normalizeTask) : [];
  } catch {
    return [];
  }
}

function writeTasks(roomId: string, tasks: Task[]): void {
  const p = tasksPath(roomId);
  const dir = join(p, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(tasks.map(normalizeTask), null, 2), "utf-8");
}

export function toTaskListItem(task: Task): TaskListItem {
  const { comments: _comments, ...rest } = normalizeTask(task);
  return { ...rest, commentCount: _comments?.length ?? 0 };
}

export function listTasks(roomId: string): Task[] {
  return readTasks(roomId);
}

export function listTaskSummaries(roomId: string): TaskListItem[] {
  return listTasks(roomId).map(toTaskListItem);
}

export function getTask(roomId: string, taskId: string): Task | null {
  return readTasks(roomId).find((t) => t.id === taskId) ?? null;
}

export function createTask(
  roomId: string,
  input: { title: string; createdBy: string; status?: TaskStatus; priority?: TaskPriority; assignee?: string; assigneeMemberId?: string; description?: string; references?: string[]; subscribers?: string[]; subscriberMemberIds?: string[] },
): Task {
  const now = Date.now();
  const task: Task = {
    id: `task-${randomUUID().slice(0, 8)}`,
    roomId,
    title: input.title.trim(),
    status: input.status ?? "todo",
    priority: input.priority ?? "P1",
    assignee: input.assignee,
    assigneeMemberId: input.assigneeMemberId,
    description: input.description,
    references: input.references,
    subscribers: uniqueStrings([input.createdBy, ...(input.subscribers ?? [])]),
    subscriberMemberIds: uniqueStrings(input.subscriberMemberIds),
    comments: [],
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  const tasks = readTasks(roomId);
  tasks.push(task);
  writeTasks(roomId, tasks);
  return task;
}

export function updateTask(
  roomId: string,
  taskId: string,
  patch: Partial<Pick<Task, "title" | "status" | "priority" | "assignee" | "assigneeMemberId" | "description" | "references" | "subscribers" | "subscriberMemberIds">>,
): Task | null {
  const tasks = readTasks(roomId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return null;
  // Only apply defined fields from patch (don't overwrite with undefined)
  const cleanPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) cleanPatch[k] = k === "subscribers" || k === "subscriberMemberIds" ? uniqueStrings(v as unknown[]) : v;
  }
  const updated: Task = normalizeTask({ ...tasks[idx], ...cleanPatch, updatedAt: Date.now() });
  tasks[idx] = updated;
  writeTasks(roomId, tasks);
  return updated;
}

export function updateTaskLinearMetadata(
  roomId: string,
  taskId: string,
  patch: Pick<Partial<Task>, "linearIssueId" | "linearIssueUrl" | "linearIssueIdentifier" | "linearSyncedAt" | "linearSyncError">,
): Task | null {
  const tasks = readTasks(roomId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return null;
  const cleanPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) cleanPatch[k] = v;
  }
  const updated = normalizeTask({ ...tasks[idx], ...cleanPatch, updatedAt: Date.now() });
  tasks[idx] = updated;
  writeTasks(roomId, tasks);
  return updated;
}

export function addTaskComment(
  roomId: string,
  taskId: string,
  input: { author: string; content: string },
): { task: Task; comment: TaskComment } | null {
  const content = input.content.trim();
  if (!content) throw new Error("comment is required");
  const author = input.author.trim();
  if (!author) throw new Error("author is required");

  const tasks = readTasks(roomId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return null;
  const comment: TaskComment = {
    id: `comment-${randomUUID().slice(0, 8)}`,
    author,
    content,
    createdAt: Date.now(),
  };
  const task = normalizeTask(tasks[idx]);
  const updated: Task = {
    ...task,
    comments: [...(task.comments ?? []), comment],
    updatedAt: Date.now(),
  };
  tasks[idx] = updated;
  writeTasks(roomId, tasks);
  return { task: updated, comment };
}

export function deleteTask(roomId: string, taskId: string): boolean {
  const tasks = readTasks(roomId);
  const next = tasks.filter((t) => t.id !== taskId);
  if (next.length === tasks.length) return false;
  writeTasks(roomId, next);
  return true;
}

export function renameParticipant(roomId: string, input: { memberId: string; oldName: string; newName: string }): number {
  const tasks = readTasks(roomId);
  let changed = 0;
  const next = tasks.map((raw) => {
    const task = normalizeTask(raw);
    let didChange = false;
    const assigneeMatches = task.assigneeMemberId === input.memberId || (!task.assigneeMemberId && task.assignee === input.oldName);
    let updated: Task = task;
    if (assigneeMatches && task.assignee !== input.newName) {
      updated = { ...updated, assignee: input.newName };
      didChange = true;
    }
    const subscribers = task.subscribers || [];
    if (subscribers.includes(input.oldName)) {
      updated = { ...updated, subscribers: subscribers.map((name) => name === input.oldName ? input.newName : name) };
      didChange = true;
    }
    if (didChange) {
      changed += 1;
      updated = { ...updated, updatedAt: Date.now() };
    }
    return updated;
  });
  if (changed > 0) writeTasks(roomId, next);
  return changed;
}

export interface TaskWithRoomName extends TaskListItem {
  roomName: string;
}

export function listAllTasks(opts: { status?: TaskStatus; query?: string } = {}): TaskWithRoomName[] {
  const rooms = listRooms();
  const result: TaskWithRoomName[] = [];
  for (const room of rooms) {
    const tasks = listTasks(room.id);
    for (const t of tasks) {
      if (opts.status && t.status !== opts.status) continue;
      if (opts.query && !t.title.toLowerCase().includes(opts.query.toLowerCase())) continue;
      result.push({ ...toTaskListItem(t), roomName: room.name });
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}
