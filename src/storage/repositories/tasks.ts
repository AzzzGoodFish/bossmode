import { getDatabase, type Database } from "../database.js";
import type { Task, TaskComment, TaskStatus } from "../../shared/types.js";

interface TaskRow {
  room_id: string; task_id: string; title: string; status: Task["status"]; priority: Task["priority"];
  assignee: string | null; assignee_member_id: string | null; description: string | null;
  created_by: string; created_at: number; updated_at: number; has_references: number;
}
export interface TaskRepositoryQuery {
  status?: TaskStatus; assignee?: { id: string; label: string; stableOnly: boolean };
  q?: string; limit?: number; offset?: number;
}

/** No dispatch or file IO. Parent services can compose these synchronous writes in one transaction. */
export class TasksRepository {
  constructor(readonly db: Database = getDatabase()) {}

  /** Import/upsert an exact source record. Labels and IDs are independent, never zipped or guessed. */
  upsert(task: Task): void {
    this.db.transaction(() => {
      this.db.run(`INSERT INTO tasks(room_id,task_id,title,status,priority,assignee,assignee_member_id,description,
        created_by,created_at,updated_at,has_references) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(room_id,task_id) DO UPDATE SET title=excluded.title,status=excluded.status,priority=excluded.priority,
        assignee=excluded.assignee,assignee_member_id=excluded.assignee_member_id,description=excluded.description,
        created_by=excluded.created_by,created_at=excluded.created_at,updated_at=excluded.updated_at,has_references=excluded.has_references`,
        task.roomId, task.id, task.title, task.status, task.priority, task.assignee ?? null, task.assigneeMemberId ?? null,
        task.description ?? null, task.createdBy, task.createdAt, task.updatedAt, Number(task.references !== undefined));
      for (const table of ["task_references", "task_subscribers", "task_comments"]) {
        this.db.run(`DELETE FROM ${table} WHERE room_id=? AND task_id=?`, task.roomId, task.id);
      }
      (task.references ?? []).forEach((value, i) => this.db.run("INSERT INTO task_references VALUES (?,?,?,?)", task.roomId, task.id, i, value));
      (task.subscribers ?? []).forEach((value, i) => this.db.run("INSERT INTO task_subscribers VALUES (?,?,?,?,?)",
        task.roomId, task.id, i, value === "user" ? "human" : "snapshot", value));
      (task.subscriberMemberIds ?? []).forEach((value, i) => this.db.run("INSERT INTO task_subscribers VALUES (?,?,?,?,?)",
        task.roomId, task.id, i, "member", value));
      (task.comments ?? []).forEach((c, i) => this.db.run("INSERT INTO task_comments VALUES (?,?,?,?,?,?,?)",
        task.roomId, task.id, i, c.id, c.author, c.content, c.createdAt));
    });
  }

  /** Bounded importer batches do not prune already imported records. */
  importTasks(roomId: string, tasks: readonly Task[]): void {
    this.db.transaction(() => {
      for (const task of tasks) {
        if (task.roomId !== roomId) throw new Error("Task import room ownership mismatch");
        this.upsert(task);
      }
    });
  }

  /** Explicit authoritative replacement; retained syncRoomTasks API delegates here, never best-effort. */
  replaceRoomTasks(roomId: string, tasks: readonly Task[]): void {
    this.db.transaction(() => {
      this.importTasks(roomId, tasks);
      const keep = new Set(tasks.map(t => t.id));
      for (const row of this.db.all<{ task_id: string }>("SELECT task_id FROM tasks WHERE room_id=?", roomId)) {
        if (!keep.has(row.task_id)) this.delete(roomId, row.task_id);
      }
    });
  }

  private hydrate(row: TaskRow): Task {
    const ids = [row.room_id, row.task_id];
    const subscribers = this.db.all<{ kind: string; value: string }>(
      "SELECT kind,value FROM task_subscribers WHERE room_id=? AND task_id=? ORDER BY position", ...ids);
    return {
      id: row.task_id, roomId: row.room_id, title: row.title, status: row.status, priority: row.priority,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.assignee !== null ? { assignee: row.assignee } : {}),
      ...(row.assignee_member_id !== null ? { assigneeMemberId: row.assignee_member_id } : {}),
      ...(row.description !== null ? { description: row.description } : {}),
      ...(row.has_references ? { references: this.db.all<{ value: string }>(
        "SELECT value FROM task_references WHERE room_id=? AND task_id=? ORDER BY position", ...ids).map(r => r.value) } : {}),
      subscribers: subscribers.filter(r => r.kind !== "member").map(r => r.value),
      subscriberMemberIds: subscribers.filter(r => r.kind === "member").map(r => r.value),
      comments: this.db.all<{ id: string; author: string; content: string; created_at: number }>(
        "SELECT id,author,content,created_at FROM task_comments WHERE room_id=? AND task_id=? ORDER BY position", ...ids)
        .map((r): TaskComment => ({ id: r.id, author: r.author, content: r.content, createdAt: r.created_at })),
    };
  }

  get(roomId: string, taskId: string): Task | null {
    const row = this.db.get<TaskRow>("SELECT * FROM tasks WHERE room_id=? AND task_id=?", roomId, taskId);
    return row ? this.hydrate(row) : null;
  }

  list(roomId: string): Task[] {
    // Preserve the original insertion/list order independently of edits and source timestamps.
    return this.db.all<TaskRow>("SELECT * FROM tasks WHERE room_id=? ORDER BY rowid", roomId).map(r => this.hydrate(r));
  }

  query(roomId: string, query: TaskRepositoryQuery): { tasks: Task[]; total: number } {
    const where = ["room_id=?"];
    const params: unknown[] = [roomId];
    if (query.status) { where.push("status=?"); params.push(query.status); }
    if (query.assignee) {
      const a = query.assignee;
      where.push(a.stableOnly ? "assignee_member_id=?" : "(assignee_member_id=? OR (COALESCE(assignee_member_id,'')='' AND assignee=?))");
      params.push(a.id, ...(!a.stableOnly ? [a.label] : []));
    }
    if (query.q?.trim()) { where.push("title LIKE ?"); params.push(`%${query.q.trim()}%`); }
    const sql = where.join(" AND ");
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM tasks WHERE ${sql}`, ...params)!.n;
    const page = query.limit && query.limit > 0 ? " LIMIT ? OFFSET ?" : "";
    const rows = this.db.all<TaskRow>(`SELECT * FROM tasks WHERE ${sql} ORDER BY updated_at DESC,created_at DESC,rowid${page}`,
      ...params, ...(page ? [query.limit, Math.max(0, query.offset ?? 0)] : []));
    return { tasks: rows.map(r => this.hydrate(r)), total };
  }

  delete(roomId: string, taskId: string): boolean {
    if (!this.db.get("SELECT 1 FROM tasks WHERE room_id=? AND task_id=?", roomId, taskId)) return false;
    this.db.run("DELETE FROM tasks WHERE room_id=? AND task_id=?", roomId, taskId);
    return true;
  }
}
