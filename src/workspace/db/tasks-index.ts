// Tasks projection: dual-write + DB-backed list query (0.19.1 S3).
//
// tasks.json remains authority. On every CRUD write the task-store calls
// `syncRoomTasks` to mirror the full room list into the `tasks` table (upsert +
// prune deleted). The list API then reads from SQLite with status/assignee/q
// filters + pagination instead of parsing tasks.json each call.
//
// Best-effort: a DB failure logs and leaves tasks.json as the working source;
// callers fall back to the file store.
import { resolveRoomMemberRef } from "../room-store.js";
import { toTaskListItem } from "../task-store.js";
import { getProjectionDb } from "./projection.js";
import { logger } from "../../foundation/logger.js";
import type { Task, TaskListItem, TaskStatus } from "../../shared/types.js";

/**
 * Mirror the authoritative room task list into the projection. Upserts each
 * task and deletes rows no longer present. Called after tasks.json is written.
 */
export function syncRoomTasks(roomId: string, tasks: Task[]): void {
  const db = getProjectionDb();
  if (!db) return;
  try {
    db.transaction((tx) => {
      const upsert = tx.raw.prepare(
        `INSERT OR REPLACE INTO tasks (room_id, task_id, title, status, priority, assignee, created_at, updated_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const keep = new Set<string>();
      for (const t of tasks) {
        if (!t || typeof t.id !== "string") continue;
        keep.add(t.id);
        upsert.run(
          roomId,
          t.id,
          String(t.title ?? ""),
          String(t.status ?? "todo"),
          t.priority ?? null,
          t.assignee ?? null,
          typeof t.createdAt === "number" ? t.createdAt : null,
          typeof t.updatedAt === "number" ? t.updatedAt : null,
          JSON.stringify(t),
        );
      }
      // Prune rows for tasks removed from the file.
      const existing = tx.all<{ task_id: string }>("SELECT task_id FROM tasks WHERE room_id = ?", roomId);
      const del = tx.raw.prepare("DELETE FROM tasks WHERE room_id = ? AND task_id = ?");
      for (const row of existing) {
        if (!keep.has(row.task_id)) del.run(roomId, row.task_id);
      }
    });
  } catch (err) {
    logger.error("db", "tasks sync failed", { roomId, error: String(err) });
  }
}

export interface TaskListQuery {
  status?: TaskStatus;
  assignee?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface TaskListResult {
  tasks: TaskListItem[];
  total: number;
}

/**
 * DB-backed task list with filters + pagination. Returns null when the
 * projection is unavailable so the caller can fall back to the file store.
 * Rows are hydrated from `payload_json` (full Task) and mapped to list items.
 */
export function queryRoomTasks(roomId: string, query: TaskListQuery): TaskListResult | null {
  const db = getProjectionDb();
  if (!db) return null;
  try {
    const where: string[] = ["room_id = ?"];
    const params: unknown[] = [roomId];
    if (query.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    if (query.assignee) {
      const ref = query.assignee.trim();
      const member = resolveRoomMemberRef(roomId, ref);
      const memberId = member?.id ?? ref;
      if (member?.id.startsWith("mem_")) {
        where.push("json_extract(payload_json, '$.assigneeMemberId') = ?");
        params.push(memberId);
      } else {
        where.push(`(json_extract(payload_json, '$.assigneeMemberId') = ? OR
          (COALESCE(json_extract(payload_json, '$.assigneeMemberId'), '') = '' AND assignee = ?))`);
        params.push(memberId, ref);
      }
    }
    if (query.q && query.q.trim()) {
      where.push("title LIKE ?");
      params.push(`%${query.q.trim()}%`);
    }
    const whereSql = where.join(" AND ");

    const totalRow = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE ${whereSql}`, ...params);
    const total = totalRow?.n ?? 0;

    let sql = `SELECT payload_json FROM tasks WHERE ${whereSql} ORDER BY updated_at DESC, created_at DESC`;
    const pageParams = [...params];
    if (query.limit && query.limit > 0) {
      sql += ` LIMIT ?`;
      pageParams.push(query.limit);
      if (query.offset && query.offset > 0) {
        sql += ` OFFSET ?`;
        pageParams.push(query.offset);
      }
    }
    const rows = db.all<{ payload_json: string | null }>(sql, ...pageParams);
    const tasks: TaskListItem[] = [];
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const task = JSON.parse(row.payload_json) as Task;
        tasks.push(toTaskListItem({ ...task, roomId }));
      } catch {
        /* skip bad row */
      }
    }
    return { tasks, total };
  } catch (err) {
    logger.error("db", "tasks query failed", { roomId, error: String(err) });
    return null;
  }
}
