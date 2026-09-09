import { basename, dirname, isAbsolute, normalize } from "node:path";
import type { BackgroundTaskRecord, BackgroundTaskStatus } from "../../shared/types.js";
import type { Database } from "../database.js";
import { assertExecutionOwner } from "./execution-identity.js";

export const BACKGROUND_TRANSITIONS: Record<BackgroundTaskStatus, readonly BackgroundTaskStatus[]> = {
  starting: ["running", "cancelling", "failed", "interrupted"],
  running: ["done", "failed", "cancelling", "interrupted"],
  cancelling: ["cancelled", "done", "failed", "interrupted"],
  done: [], failed: [], cancelled: [], interrupted: [],
};
export function terminalBackgroundStatus(status: BackgroundTaskStatus): boolean {
  return ["done", "failed", "cancelled", "interrupted"].includes(status);
}
export function validBackgroundId(id: string): boolean {
  return /^bgt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}
export interface BackgroundUpdate { status?: BackgroundTaskStatus; result?: string | null; error?: string | null }
interface Row {
  task_id: string; member_id: string; scope_id: string; kind: BackgroundTaskRecord["kind"];
  session_mode: BackgroundTaskRecord["sessionMode"]; prompt: string; model: string | null;
  credential_id: string | null; thinking_level: string | null; status: BackgroundTaskStatus;
  started_at: string; ended_at: string | null; result: string | null; error: string | null;
  session_dir: string; parent_session_ref: string | null;
}
function record(r: Row): BackgroundTaskRecord {
  return {taskId: r.task_id, memberId: r.member_id, scopeId: r.scope_id.includes(":") ? r.scope_id : `room:${r.scope_id}`,
    kind: r.kind, sessionMode: r.session_mode, prompt: r.prompt,
    snapshot: {model: r.model, credentialId: r.credential_id, thinkingLevel: r.thinking_level},
    status: r.status, startedAt: r.started_at, endedAt: r.ended_at, result: r.result, error: r.error,
    sessionDir: r.session_dir, parentSessionRef: r.parent_session_ref};
}
/** No disk reads: importer supplies a verified path, never a raw task.json sessionDir. */
export function validateBackgroundRecord(r: BackgroundTaskRecord): void {
  const invalid = (reason: string): never => { throw new Error(`Invalid background task ${r.taskId}: ${reason}`); };
  if (!validBackgroundId(r.taskId)) invalid("task ID");
  if (!["generic", "recall", "memorize"].includes(r.kind)) invalid("kind");
  if (!["new", "fork"].includes(r.sessionMode)) invalid("session mode");
  if (!Object.hasOwn(BACKGROUND_TRANSITIONS, r.status)) invalid("status");
  if (typeof r.startedAt !== "string" || Number.isNaN(Date.parse(r.startedAt))) invalid("startedAt");
  if (typeof r.prompt !== "string" || typeof r.scopeId !== "string") invalid("prompt/scope");
  if (!r.snapshot || Object.values({model:r.snapshot.model, credentialId:r.snapshot.credentialId, thinkingLevel:r.snapshot.thinkingLevel})
    .some(v => v !== null && typeof v !== "string")) invalid("snapshot");
  if (typeof r.sessionDir !== "string" || !isAbsolute(r.sessionDir) || normalize(r.sessionDir) !== r.sessionDir ||
    basename(r.sessionDir) !== r.taskId || !/^\d{4}-\d{2}-\d{2}$/.test(basename(dirname(r.sessionDir))) ||
    basename(dirname(dirname(r.sessionDir))) !== "background-tasks" ||
    basename(dirname(dirname(dirname(r.sessionDir)))) !== r.memberId) invalid("session directory ownership/reference");
  if (r.parentSessionRef !== null && (typeof r.parentSessionRef !== "string" || !isAbsolute(r.parentSessionRef) || r.parentSessionRef.includes("\0"))) invalid("parent reference");
  if (terminalBackgroundStatus(r.status)) {
    if (typeof r.endedAt !== "string" || Number.isNaN(Date.parse(r.endedAt))) invalid("terminal endedAt");
    if (r.status === "done" ? typeof r.result !== "string" : typeof r.error !== "string" || r.result !== null) invalid("terminal result/error");
    if (r.error !== null && typeof r.error !== "string") invalid("terminal error");
  } else if (r.endedAt !== null || r.result !== null || r.error !== null) invalid("nonterminal outcome");
}

export class BackgroundRepository {
  constructor(private readonly db: Database) {}
  get(memberId: string, taskId: string): BackgroundTaskRecord | null {
    const r = this.db.get<Row>("SELECT * FROM background_tasks WHERE task_id=? AND member_id=?", taskId, memberId);
    return r ? record(r) : null;
  }
  list(memberId: string): BackgroundTaskRecord[] {
    return this.db.all<Row>("SELECT * FROM background_tasks WHERE member_id=? ORDER BY started_at,task_id", memberId).map(record);
  }
  private insert(r: BackgroundTaskRecord): void {
    validateBackgroundRecord(r);
    const scope = assertExecutionOwner(this.db, r.memberId, r.scopeId);
    this.db.run(`INSERT INTO background_tasks(task_id,member_id,scope_id,kind,session_mode,prompt,model,credential_id,thinking_level,
      status,started_at,ended_at,result,error,session_dir,parent_session_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    r.taskId, r.memberId, scope, r.kind, r.sessionMode, r.prompt, r.snapshot.model, r.snapshot.credentialId, r.snapshot.thinkingLevel,
    r.status, r.startedAt, r.endedAt, r.result, r.error, r.sessionDir, r.parentSessionRef);
  }
  create(r: BackgroundTaskRecord): void {
    if (r.status !== "starting") throw new Error("New background task must be starting");
    this.insert(r);
  }
  /** Idempotent exact import, not overwrite. Conflicting IDs abort cutover, including terminal rows. */
  importRecord(r: BackgroundTaskRecord): void {
    this.db.transaction(() => {
      validateBackgroundRecord(r);
      const scope = assertExecutionOwner(this.db, r.memberId, r.scopeId);
      const existing = this.get(r.memberId, r.taskId);
      if (existing) {
        const normalized = {...r, scopeId: scope.includes(":") ? scope : `room:${scope}`};
        const keys = Object.keys(existing) as (keyof BackgroundTaskRecord)[];
        const snapshotKeys = ["model", "credentialId", "thinkingLevel"] as const;
        if (keys.some(k => k === "snapshot"
          ? snapshotKeys.some(key => existing.snapshot[key] !== normalized.snapshot[key])
          : existing[k] !== normalized[k])) throw new Error(`Conflicting background import: ${r.taskId}`);
        return;
      }
      this.insert(r);
    });
  }
  private transition(memberId: string, taskId: string, patch: BackgroundUpdate, endedAt: string, restart: boolean): BackgroundTaskRecord {
    return this.db.transaction(tx => {
      const current = this.get(memberId, taskId);
      if (!current) throw new Error(`background task not found: ${taskId}`);
      if (terminalBackgroundStatus(current.status)) throw new Error(`background task ${taskId} already terminal (${current.status}); records are immutable`);
      if (patch.status === "interrupted" && !restart) throw new Error("interrupted is reserved for service restart");
      if (patch.status !== undefined && !BACKGROUND_TRANSITIONS[current.status].includes(patch.status)) {
        throw new Error(`illegal background task transition ${current.status} -> ${patch.status} (${taskId})`);
      }
      const next = {...current, ...patch};
      // Undefined patch properties mean 'unchanged', not data removal.
      next.status = patch.status ?? current.status;
      next.result = patch.result === undefined ? current.result : patch.result;
      next.error = patch.error === undefined ? current.error : patch.error;
      if (terminalBackgroundStatus(next.status)) next.endedAt = endedAt;
      validateBackgroundRecord(next);
      const changed = tx.get<{task_id: string}>(`UPDATE background_tasks SET status=?,ended_at=?,result=?,error=?
        WHERE task_id=? AND member_id=? AND status=? RETURNING task_id`, next.status, next.endedAt, next.result, next.error,
      taskId, memberId, current.status);
      if (!changed) throw new Error(`Concurrent background transition rejected: ${taskId}`);
      if (terminalBackgroundStatus(next.status)) {
        tx.run(`INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES('background.terminal',?,?,?,?)`,
        assertExecutionOwner(tx, memberId, current.scopeId), `background.terminal:${taskId}`,
        JSON.stringify({taskId, memberId, status: next.status}), Date.parse(endedAt));
      }
      return next;
    });
  }
  update(memberId: string, taskId: string, patch: BackgroundUpdate, endedAt: string): BackgroundTaskRecord {
    return this.transition(memberId, taskId, patch, endedAt, false);
  }
  /** Startup only. One transaction; a failed write aborts readiness instead of leaving live-looking tasks. */
  interruptIncomplete(endedAt: string): BackgroundTaskRecord[] {
    return this.db.transaction(tx => tx.all<Row>("SELECT * FROM background_tasks WHERE status IN ('starting','running','cancelling') ORDER BY task_id")
      .map(r => this.transition(r.member_id, r.task_id, {status: "interrupted", error: "interrupted by service restart; not resumed"}, endedAt, true)));
  }
}
