// Task business rules over normalized SQLite authority.
import { randomUUID } from "node:crypto";
import { listRooms, getRoom, getRoomMembersFromRoom, resolveRoomMemberRef } from "./room-store.js";
import { getConversationMember as getMember } from "../storage/repositories/conversations.js";
import { TasksRepository } from "../storage/repositories/tasks.js";
import type { Task, TaskStatus, TaskPriority, TaskComment, TaskListItem } from "../shared/types.js";

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

function normalizeTask(raw: Task): Task {
  return { ...raw, comments: raw.comments ?? [], subscribers: uniqueStrings(raw.subscribers), subscriberMemberIds: uniqueStrings(raw.subscriberMemberIds) };
}

function readTasks(roomId: string): Task[] { return new TasksRepository().list(roomId); }

/** Current participant labels are a read projection; stored names remain snapshots. */
export function presentTaskParticipants(task: Task): Task {
  const normalized = normalizeTask(task);
  if (!normalized.assigneeMemberId && !normalized.subscriberMemberIds?.length) return normalized;
  const room = getRoom(task.roomId);
  // Do not treat synthesized IDs from legacy members: string[] as stable identity.
  const members = room && (Array.isArray(room.globalMemberIds) || Array.isArray(room.roomMembers))
    ? getRoomMembersFromRoom(room) : [];
  const currentName = (id: string): string =>
    (id.startsWith("mem_") ? getMember(id)?.name : undefined)
    ?? members.find((member) => member.id === id)?.name
    ?? id;
  return {
    ...normalized,
    assignee: normalized.assigneeMemberId ? currentName(normalized.assigneeMemberId) : normalized.assignee,
    // The two historical arrays are not positional pairs. Once IDs exist they
    // are authority; merging old labels would reintroduce renamed identities.
    // "user" is the non-member creator, not a member name snapshot.
    subscribers: normalized.subscriberMemberIds?.length
      ? uniqueStrings([
        ...(normalized.subscribers?.includes("user") ? ["user"] : []),
        ...normalized.subscriberMemberIds.map(currentName),
      ])
      : normalized.subscribers,
  };
}

/** ID-backed tasks never match an old name snapshot, including after name reuse. */
export function taskMatchesAssignee(roomId: string, task: Pick<Task, "assignee" | "assigneeMemberId">, ref: string): boolean {
  const value = ref.trim();
  const member = resolveRoomMemberRef(roomId, value);
  if (!task.assigneeMemberId) return !member?.id.startsWith("mem_") && task.assignee === value;
  return task.assigneeMemberId === (member?.id ?? value);
}

export function toTaskListItem(task: Task): TaskListItem {
  const { comments: _comments, ...rest } = presentTaskParticipants(task);
  return { ...rest, commentCount: _comments?.length ?? 0 };
}

export function listTasks(roomId: string): Task[] {
  return readTasks(roomId).map(presentTaskParticipants);
}

export function listTaskSummaries(roomId: string): TaskListItem[] {
  return readTasks(roomId).map(toTaskListItem);
}

export function getTask(roomId: string, taskId: string): Task | null {
  const task = new TasksRepository().get(roomId, taskId);
  return task ? presentTaskParticipants(task) : null;
}

export function createTask(
  roomId: string,
  input: { title: string; createdBy: string; status?: TaskStatus; priority?: TaskPriority; assignee?: string; assigneeMemberId?: string; description?: string; references?: string[]; subscribers?: string[]; subscriberMemberIds?: string[] },
): Task {
  const now = Date.now();
  const room = getRoom(roomId);
  const creator = room && (Array.isArray(room.globalMemberIds) || Array.isArray(room.roomMembers))
    ? getRoomMembersFromRoom(room).find((member) => member.name === input.createdBy)
    : undefined;
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
    subscriberMemberIds: uniqueStrings([creator?.id, ...(input.subscriberMemberIds ?? [])]),
    comments: [],
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  new TasksRepository().upsert(task);
  return presentTaskParticipants(task);
}

export function updateTask(
  roomId: string,
  taskId: string,
  patch: Partial<Pick<Task, "title" | "status" | "priority" | "description" | "references" | "subscribers" | "subscriberMemberIds">> & { assignee?: string | null; assigneeMemberId?: string | null },
): Task | null {
  const repository = new TasksRepository();
  return repository.db.transaction(() => {
    const current = repository.get(roomId, taskId);
    if (!current) return null;
    // Only apply defined fields from patch (don't overwrite with undefined)
    const cleanPatch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) cleanPatch[k] = k === "subscribers" || k === "subscriberMemberIds" ? uniqueStrings(v as unknown[]) : v;
    }
    // Explicit clearing removes both identity fields; omitted/undefined fields leave them alone.
    if (patch.assignee === null || patch.assigneeMemberId === null) {
      cleanPatch.assignee = undefined;
      cleanPatch.assigneeMemberId = undefined;
    }
    const updated: Task = normalizeTask({ ...current, ...cleanPatch, updatedAt: Date.now() });
    repository.upsert(updated);
    return presentTaskParticipants(updated);
  });
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

  const repository = new TasksRepository();
  return repository.db.transaction(() => {
    const current = repository.get(roomId, taskId);
    if (!current) return null;
    const comment: TaskComment = {
      id: `comment-${randomUUID().slice(0, 8)}`,
      author,
      content,
      createdAt: Date.now(),
    };
    const task = normalizeTask(current);
    const updated: Task = {
      ...task,
      comments: [...(task.comments ?? []), comment],
      updatedAt: Date.now(),
    };
    repository.upsert(updated);
    return { task: presentTaskParticipants(updated), comment };
  });
}

export function deleteTask(roomId: string, taskId: string): boolean {
  return new TasksRepository().delete(roomId, taskId);
}

export interface TaskWithRoomName extends TaskListItem {
  roomName: string;
}

export function listAllTasks(opts: { status?: TaskStatus; query?: string } = {}): TaskWithRoomName[] {
  const rooms = listRooms();
  const result: TaskWithRoomName[] = [];
  for (const room of rooms) {
    const tasks = readTasks(room.id);
    for (const t of tasks) {
      if (opts.status && t.status !== opts.status) continue;
      if (opts.query && !t.title.toLowerCase().includes(opts.query.toLowerCase())) continue;
      result.push({ ...toTaskListItem(t), roomName: room.name });
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}
