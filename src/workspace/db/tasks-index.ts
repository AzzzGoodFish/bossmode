// Retained public task query API, now backed by normalized authority, not a projection.
import { resolveRoomMemberRef } from "../room-store.js";
import { toTaskListItem } from "../task-store.js";
import { TasksRepository } from "../../storage/repositories/tasks.js";
import type { Task, TaskListItem, TaskStatus } from "../../shared/types.js";

/** Explicit authoritative replacement. Bootstrap must import source tasks before serving reads. */
export function syncRoomTasks(roomId: string, tasks: Task[]): void {
  new TasksRepository().replaceRoomTasks(roomId, tasks);
}

export interface TaskListQuery {
  status?: TaskStatus;
  assignee?: string;
  q?: string;
  limit?: number;
  offset?: number;
}
export interface TaskListResult { tasks: TaskListItem[]; total: number }

/** Storage errors propagate; there is no unavailable-projection/file fallback. */
export function queryRoomTasks(roomId: string, query: TaskListQuery): TaskListResult {
  const ref = query.assignee?.trim();
  const member = ref ? resolveRoomMemberRef(roomId, ref) : null;
  const result = new TasksRepository().query(roomId, {
    ...query,
    assignee: ref ? { id: member?.id ?? ref, label: ref, stableOnly: Boolean(member?.id.startsWith("mem_")) } : undefined,
  });
  return { tasks: result.tasks.map(toTaskListItem), total: result.total };
}
