// Background task store — member-owned background task lifecycle records.
// Storage: <bossmodeDir>/members/<memberId>/background-tasks/<YYYY-MM-DD-UTC>/<taskId>/
//   task.json — lifecycle record (status, ownership, snapshot, final result or error).
//   The SDK session JSONL lives in the same directory; it is written by the SDK,
//   never rewritten by this store. Date folders are archive organization only:
//   tasks never migrate across days (a task keeps its start date).
//
// Rules (architecture/background-task-foundation-discussion-20260907.md):
// - Terminal statuses (done/failed/cancelled/interrupted) are immutable.
// - Result is readable only through the wait path (the record itself is the store;
//   the wait tool is the only surface that exposes result/error to the model).
// - `interrupted` is produced only by the restart sweep, never by the live runtime.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { memberDir } from "../workspace/member-registry.js";
import { getBossmodeDir } from "../shared/config.js";
import type {
  BackgroundSessionMode,
  BackgroundTaskKind,
  BackgroundTaskRecord,
  BackgroundTaskStatus,
  BackgroundTaskTerminalStatus,
} from "../shared/types.js";

export function isTerminalBackgroundTaskStatus(status: BackgroundTaskStatus): status is BackgroundTaskTerminalStatus {
  return status === "done" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/** Allowed live transitions; anything else (and any write to a terminal record) is rejected. */
const ALLOWED_TRANSITIONS: Record<BackgroundTaskStatus, BackgroundTaskStatus[]> = {
  starting: ["running", "failed", "interrupted"],
  running: ["done", "failed", "cancelling", "interrupted"],
  cancelling: ["cancelled", "done", "failed", "interrupted"],
  done: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

// -- Paths --------------------------------------------------------------

function backgroundTasksRoot(memberId: string): string {
  return join(memberDir(memberId), "background-tasks");
}

function dateFolder(isoNow: string): string {
  return isoNow.slice(0, 10); // UTC YYYY-MM-DD, same clock as startedAt
}

function taskDir(memberId: string, dateFolder: string, taskId: string): string {
  return join(backgroundTasksRoot(memberId), dateFolder, taskId);
}

function taskJsonPath(dir: string): string {
  return join(dir, "task.json");
}

// -- Normalization ------------------------------------------------------

function normalizeRecord(raw: any): BackgroundTaskRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const taskId = String(raw.taskId ?? "").trim();
  const memberId = String(raw.memberId ?? "").trim();
  if (!taskId || !memberId) return null;
  return {
    taskId,
    kind: (["generic", "recall", "memorize"] as const).includes(raw.kind) ? raw.kind : "generic",
    memberId,
    scopeId: String(raw.scopeId ?? "").trim(),
    sessionMode: raw.sessionMode === "new" || raw.sessionMode === "fork" ? raw.sessionMode : "new",
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    snapshot: {
      model: raw.snapshot?.model ?? null,
      credentialId: raw.snapshot?.credentialId ?? null,
      thinkingLevel: raw.snapshot?.thinkingLevel ?? null,
    },
    status: raw.status as BackgroundTaskStatus,
    startedAt: String(raw.startedAt ?? new Date().toISOString()),
    endedAt: raw.endedAt ? String(raw.endedAt) : null,
    result: typeof raw.result === "string" ? raw.result : null,
    error: typeof raw.error === "string" ? raw.error : null,
    sessionDir: String(raw.sessionDir ?? ""),
    parentSessionRef: raw.parentSessionRef ? String(raw.parentSessionRef) : null,
  };
}

function writeRecord(record: BackgroundTaskRecord): void {
  writeFileSync(taskJsonPath(record.sessionDir), JSON.stringify(record, null, 2), "utf-8");
}

// -- Wait registry (in-process; concurrent + repeatable) ----------------

type TerminalListener = (record: BackgroundTaskRecord) => void;

const terminalListeners = new Map<string, Set<TerminalListener>>();

function listenerKey(memberId: string, taskId: string): string {
  return `${memberId}/${taskId}`;
}

function notifyTerminal(record: BackgroundTaskRecord): void {
  const listeners = terminalListeners.get(listenerKey(record.memberId, record.taskId));
  if (!listeners) return;
  for (const listener of listeners) listener(record);
  terminalListeners.delete(listenerKey(record.memberId, record.taskId));
}

/**
 * Resolves with the terminal record. Resolves immediately for tasks already
 * terminal. Multiple concurrent waiters all resolve; settling is one-shot —
 * later waiters read the stored terminal record immediately.
 */
export function whenTerminal(memberId: string, taskId: string): Promise<BackgroundTaskRecord> {
  const existing = getBackgroundTask(memberId, taskId);
  if (existing && isTerminalBackgroundTaskStatus(existing.status)) return Promise.resolve(existing);
  return new Promise<BackgroundTaskRecord>((resolve) => {
    const key = listenerKey(memberId, taskId);
    let listeners = terminalListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      terminalListeners.set(key, listeners);
    }
    listeners.add(resolve);
  });
}

// -- CRUD ---------------------------------------------------------------

export interface CreateBackgroundTaskInput {
  memberId: string;
  scopeId: string;
  kind: BackgroundTaskKind;
  sessionMode: BackgroundSessionMode;
  prompt: string;
  snapshot: BackgroundTaskRecord["snapshot"];
  parentSessionRef?: string | null;
}

export function createBackgroundTask(input: CreateBackgroundTaskInput): BackgroundTaskRecord {
  const startedAt = new Date().toISOString();
  const folder = dateFolder(startedAt);
  let taskId = `bgt-${randomUUID().slice(0, 8)}`;
  let dir = taskDir(input.memberId, folder, taskId);
  while (existsSync(dir)) {
    taskId = `bgt-${randomUUID().slice(0, 8)}`;
    dir = taskDir(input.memberId, folder, taskId);
  }
  mkdirSync(dir, { recursive: true });
  const record: BackgroundTaskRecord = {
    taskId,
    kind: input.kind,
    memberId: input.memberId,
    scopeId: input.scopeId,
    sessionMode: input.sessionMode,
    prompt: input.prompt,
    snapshot: input.snapshot,
    status: "starting",
    startedAt,
    endedAt: null,
    result: null,
    error: null,
    sessionDir: dir,
    parentSessionRef: input.parentSessionRef ?? null,
  };
  writeRecord(record);
  return record;
}

export function getBackgroundTask(memberId: string, taskId: string): BackgroundTaskRecord | null {
  const root = backgroundTasksRoot(memberId);
  if (!existsSync(root)) return null;
  // taskId is unique per member; scan the (few) date folders to locate it.
  for (const folder of readdirSync(root)) {
    const p = taskJsonPath(join(root, folder, taskId));
    if (!existsSync(p)) continue;
    try {
      return normalizeRecord(JSON.parse(readFileSync(p, "utf-8")));
    } catch {
      return null; // unreadable record: treated as absent; never guessed around
    }
  }
  return null;
}

export function listBackgroundTasks(memberId: string): BackgroundTaskRecord[] {
  const root = backgroundTasksRoot(memberId);
  if (!existsSync(root)) return [];
  const records: BackgroundTaskRecord[] = [];
  for (const folder of readdirSync(root)) {
    const folderDir = join(root, folder);
    let entries: string[];
    try {
      entries = readdirSync(folderDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = taskJsonPath(join(folderDir, entry));
      if (!existsSync(p)) continue;
      try {
        const record = normalizeRecord(JSON.parse(readFileSync(p, "utf-8")));
        if (record) records.push(record);
      } catch {
        // unreadable record: skipped from listing, not fatal
      }
    }
  }
  records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  return records;
}

export interface BackgroundTaskUpdate {
  status?: BackgroundTaskStatus;
  result?: string | null;
  error?: string | null;
}

/**
 * Single live transition path. Rejects illegal transitions and any write to a
 * terminal record; on success persists atomically (single writeFileSync) and
 * wakes concurrent waiters if the new status is terminal.
 */
export function updateBackgroundTask(
  memberId: string,
  taskId: string,
  update: BackgroundTaskUpdate,
): BackgroundTaskRecord {
  const current = getBackgroundTask(memberId, taskId);
  if (!current) throw new Error(`background task not found: ${taskId}`);
  if (isTerminalBackgroundTaskStatus(current.status)) {
    throw new Error(`background task ${taskId} already terminal (${current.status}); records are immutable`);
  }
  const next: BackgroundTaskRecord = { ...current };
  if (update.status !== undefined) {
    if (!(ALLOWED_TRANSITIONS[current.status] as string[]).includes(update.status)) {
      throw new Error(`illegal background task transition ${current.status} -> ${update.status} (${taskId})`);
    }
    next.status = update.status;
    if (isTerminalBackgroundTaskStatus(update.status)) next.endedAt = new Date().toISOString();
  }
  if (update.result !== undefined) {
    if (next.status !== "done") {
      throw new Error(`result may only be set on transition to done (${taskId}, status=${next.status})`);
    }
    next.result = update.result;
  }
  if (update.error !== undefined) {
    if (!isTerminalBackgroundTaskStatus(next.status)) {
      throw new Error(`error may only be set together with a terminal status (${taskId}, status=${next.status})`);
    }
    next.error = update.error;
  }
  writeRecord(next);
  if (isTerminalBackgroundTaskStatus(next.status)) notifyTerminal(next);
  return next;
}

// -- Restart sweep ------------------------------------------------------

/**
 * Startup-only: mark every non-terminal task of every member `interrupted`.
 * Records and already-terminal results are preserved; execution never resumes.
 * Returns the number of tasks marked interrupted.
 */
export function sweepInterruptedBackgroundTasks(): number {
  const membersRoot = join(getBossmodeDir(), "members");
  if (!existsSync(membersRoot)) return 0;
  let marked = 0;
  for (const memberId of readdirSync(membersRoot)) {
    const root = backgroundTasksRoot(memberId);
    if (!existsSync(root)) continue;
    for (const record of listBackgroundTasks(memberId)) {
      if (isTerminalBackgroundTaskStatus(record.status)) continue;
      try {
        updateBackgroundTask(memberId, record.taskId, {
          status: "interrupted",
          error: "interrupted by service restart; not resumed",
        });
        marked += 1;
      } catch {
        // unreadable/illegal record: leave on disk, do not block startup
      }
    }
  }
  return marked;
}
