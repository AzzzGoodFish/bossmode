// Task store — per-room task CRUD, backed by rooms/<id>/tasks.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir, listRooms, getRoom } from "./room-store.js";
import type { Task, TaskStatus, TaskPriority } from "../shared/types.js";

function tasksPath(roomId: string): string {
  return join(roomDir(roomId), "tasks.json");
}

function readTasks(roomId: string): Task[] {
  const p = tasksPath(roomId);
  if (!existsSync(p)) return [];
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeTasks(roomId: string, tasks: Task[]): void {
  const p = tasksPath(roomId);
  const dir = join(p, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(tasks, null, 2), "utf-8");
}

export function listTasks(roomId: string): Task[] {
  return readTasks(roomId);
}

export function getTask(roomId: string, taskId: string): Task | null {
  return readTasks(roomId).find((t) => t.id === taskId) ?? null;
}

export function createTask(
  roomId: string,
  input: { title: string; createdBy: string; status?: TaskStatus; priority?: TaskPriority; assignee?: string; description?: string; references?: string[] },
): Task {
  const now = Date.now();
  const task: Task = {
    id: `task-${randomUUID().slice(0, 8)}`,
    roomId,
    title: input.title.trim(),
    status: input.status ?? "todo",
    priority: input.priority ?? "P1",
    assignee: input.assignee,
    description: input.description,
    references: input.references,
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
  patch: Partial<Pick<Task, "title" | "status" | "priority" | "assignee" | "description" | "references">>,
): Task | null {
  const tasks = readTasks(roomId);
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return null;
  // Only apply defined fields from patch (don't overwrite with undefined)
  const cleanPatch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) cleanPatch[k] = v;
  }
  const updated: Task = { ...tasks[idx], ...cleanPatch, updatedAt: Date.now() };
  tasks[idx] = updated;
  writeTasks(roomId, tasks);
  return updated;
}

export function deleteTask(roomId: string, taskId: string): boolean {
  const tasks = readTasks(roomId);
  const next = tasks.filter((t) => t.id !== taskId);
  if (next.length === tasks.length) return false;
  writeTasks(roomId, next);
  return true;
}

export interface TaskWithRoomName extends Task {
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
      result.push({ ...t, roomName: room.name });
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}
