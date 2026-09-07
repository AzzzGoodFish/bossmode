// Background task store — member-owned background task lifecycle records.
// Storage: <bossmodeDir>/members/<memberId>/background-tasks/<YYYY-MM-DD-UTC>/<taskId>/
//   task.json — lifecycle record (status, ownership, snapshot, final result or error).
//   The SDK session JSONL lives in the same directory; it is written by the SDK,
//   never rewritten by this store. Date folders are archive organization only:
//   tasks never migrate across days (a task keeps its start date).
//
// Rules (architecture/background-task-foundation-discussion-20260907.md + review
// 2026-09-07 11:34):
// - Terminal statuses (done/failed/cancelled/interrupted) are immutable.
// - starting is cancellable (starting → cancelling); cancelling → done is only
//   for work that genuinely completed before the cancel took effect.
// - Writes are atomic (temp file + rename); a failed write throws — never
//   reported as saved.
// - Records are strictly validated: unknown/missing fields are a diagnostic,
//   never guessed defaults. sessionDir is derived from the path the record was
//   found at, never trusted from file contents.
// - `interrupted` is produced only by the restart sweep (service init), never
//   by the live runtime; member reload must not sweep.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { memberDir } from "../workspace/member-registry.js";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import type {
  BackgroundSessionMode,
  BackgroundTaskKind,
  BackgroundTaskRecord,
  BackgroundTaskSnapshot,
  BackgroundTaskStatus,
  BackgroundTaskTerminalStatus,
} from "../shared/types.js";

const TASK_ID_PATTERN = /^bgt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID_KINDS = new Set<BackgroundTaskKind>(["generic", "recall", "memorize"]);
const VALID_MODES = new Set<BackgroundSessionMode>(["new", "fork"]);
const VALID_STATUSES = new Set<BackgroundTaskStatus>([
  "starting", "running", "cancelling", "done", "failed", "cancelled", "interrupted",
]);

export function isTerminalBackgroundTaskStatus(status: BackgroundTaskStatus): status is BackgroundTaskTerminalStatus {
  return status === "done" || status === "failed" || status === "cancelled" || status === "interrupted";
}

/** Task ids are opaque full UUIDs prefixed bgt-; validate before any path use. */
export function isValidBackgroundTaskId(taskId: string): boolean {
  return TASK_ID_PATTERN.test(taskId);
}

/** Allowed live transitions; anything else (and any write to a terminal record) is rejected. */
const ALLOWED_TRANSITIONS: Record<BackgroundTaskStatus, BackgroundTaskStatus[]> = {
  starting: ["running", "cancelling", "failed", "interrupted"],
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

// -- Atomic persistence --------------------------------------------------

/** Atomic record write: temp file + rename. Throws on failure — never silent. */
function writeRecord(record: BackgroundTaskRecord): void {
  const final = taskJsonPath(record.sessionDir);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmp, final);
}

// -- Validation ----------------------------------------------------------

export interface InvalidRecord {
  path: string;
  reason: string;
}

/**
 * Strict validation: every enum field must be a known value, timestamps ISO
 * strings, memberId must match the owning member. The record's sessionDir is
 * replaced by the directory the file was actually found in — file contents
 * never decide write paths.
 */
function parseRecord(raw: any, foundDir: string, expectedMemberId: string): BackgroundTaskRecord | InvalidRecord {
  const invalid = (reason: string): InvalidRecord => ({ path: taskJsonPath(foundDir), reason });
  if (!raw || typeof raw !== "object") return invalid("not an object");
  if (typeof raw.taskId !== "string" || !isValidBackgroundTaskId(raw.taskId)) return invalid(`bad taskId: ${String(raw.taskId)}`);
  if (raw.memberId !== expectedMemberId) return invalid(`memberId mismatch: ${String(raw.memberId)}`);
  if (!VALID_KINDS.has(raw.kind)) return invalid(`bad kind: ${String(raw.kind)}`);
  if (!VALID_MODES.has(raw.sessionMode)) return invalid(`bad sessionMode: ${String(raw.sessionMode)}`);
  if (!VALID_STATUSES.has(raw.status)) return invalid(`bad status: ${String(raw.status)}`);
  if (typeof raw.startedAt !== "string" || Number.isNaN(Date.parse(raw.startedAt))) return invalid("bad startedAt");
  if (raw.endedAt !== null && raw.endedAt !== undefined && (typeof raw.endedAt !== "string" || Number.isNaN(Date.parse(raw.endedAt)))) return invalid("bad endedAt");
  if (isTerminalBackgroundTaskStatus(raw.status)) {
    if (!raw.endedAt) return invalid(`terminal status ${raw.status} without endedAt`);
    if (raw.status === "done" && typeof raw.result !== "string") return invalid("done without string result");
    if (raw.status !== "done" && typeof raw.error !== "string") return invalid(`${raw.status} without string error`);
  } else if (raw.result !== null && raw.result !== undefined) {
    return invalid(`non-terminal status ${raw.status} with result`);
  }
  if (basename(foundDir) !== raw.taskId) return invalid(`taskId does not match directory name ${basename(foundDir)}`);
  return {
    taskId: raw.taskId,
    kind: raw.kind,
    memberId: raw.memberId,
    scopeId: typeof raw.scopeId === "string" ? raw.scopeId : "",
    sessionMode: raw.sessionMode,
    prompt: typeof raw.prompt === "string" ? raw.prompt : "",
    snapshot: {
      model: raw.snapshot?.model ?? null,
      credentialId: raw.snapshot?.credentialId ?? null,
      thinkingLevel: raw.snapshot?.thinkingLevel ?? null,
    },
    status: raw.status,
    startedAt: raw.startedAt,
    endedAt: raw.endedAt ?? null,
    result: typeof raw.result === "string" ? raw.result : null,
    error: typeof raw.error === "string" ? raw.error : null,
    sessionDir: foundDir, // derived from disk layout, never from file contents
    parentSessionRef: typeof raw.parentSessionRef === "string" ? raw.parentSessionRef : null,
  };
}

function basename(dir: string): string {
  const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Read + validate one record. Bad records log a diagnostic and read as absent. */
function loadRecordAt(foundDir: string, expectedMemberId: string): BackgroundTaskRecord | null {
  const p = taskJsonPath(foundDir);
  if (!existsSync(p)) return null;
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    logger.error("background-tasks", "unreadable task record", { path: p, error: String(err) });
    return null;
  }
  const parsed = parseRecord(raw, foundDir, expectedMemberId);
  if ("reason" in parsed) {
    logger.error("background-tasks", "invalid task record", { path: parsed.path, reason: parsed.reason });
    return null;
  }
  return parsed;
}

// -- Wait registry (in-process; concurrent, repeatable, disposable) -------

type TerminalListener = (record: BackgroundTaskRecord | null) => void;

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

export interface TerminalWait {
  promise: Promise<BackgroundTaskRecord>;
  /** Remove this waiter without affecting other waiters. Call on timeout/abort. */
  dispose(): void;
}

/**
 * Register a terminal waiter for an EXISTING task. Missing tasks resolve null
 * immediately (never a forever-pending promise). Terminal tasks resolve the
 * stored record immediately. Concurrent + repeatable: every waiter gets the
 * record; no consumption. dispose() detaches a single waiter.
 */
export function whenTerminal(memberId: string, taskId: string): TerminalWait {
  const existing = getBackgroundTask(memberId, taskId);
  if (!existing) {
    return { promise: Promise.reject(new Error(`background task not found: ${taskId}`)), dispose: () => {} };
  }
  if (isTerminalBackgroundTaskStatus(existing.status)) {
    return { promise: Promise.resolve(existing), dispose: () => {} };
  }
  let listener: TerminalListener;
  const promise = new Promise<BackgroundTaskRecord>((resolve) => {
    listener = (record) => resolve(record ?? getBackgroundTask(memberId, taskId)!);
    const key = listenerKey(memberId, taskId);
    let listeners = terminalListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      terminalListeners.set(key, listeners);
    }
    listeners.add(listener);
  });
  return {
    promise,
    dispose() {
      const listeners = terminalListeners.get(listenerKey(memberId, taskId));
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) terminalListeners.delete(listenerKey(memberId, taskId));
      }
    },
  };
}

// -- CRUD ---------------------------------------------------------------

export interface CreateBackgroundTaskInput {
  memberId: string;
  scopeId: string;
  kind: BackgroundTaskKind;
  sessionMode: BackgroundSessionMode;
  prompt: string;
  snapshot: BackgroundTaskSnapshot;
  parentSessionRef?: string | null;
}

export function createBackgroundTask(input: CreateBackgroundTaskInput): BackgroundTaskRecord {
  const startedAt = new Date().toISOString();
  const folder = dateFolder(startedAt);
  let taskId = `bgt-${randomUUID()}`;
  let dir = taskDir(input.memberId, folder, taskId);
  while (existsSync(dir)) {
    taskId = `bgt-${randomUUID()}`;
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
  if (!isValidBackgroundTaskId(taskId)) return null;
  const root = backgroundTasksRoot(memberId);
  if (!existsSync(root)) return null;
  // taskId is unique per member; scan the date folders to locate it.
  for (const folder of readdirSync(root)) {
    const foundDir = join(root, folder, taskId);
    if (!existsSync(taskJsonPath(foundDir))) continue;
    return loadRecordAt(foundDir, memberId);
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
      if (!isValidBackgroundTaskId(entry)) continue;
      const record = loadRecordAt(join(folderDir, entry), memberId);
      if (record) records.push(record);
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
 * terminal record; persists atomically and wakes concurrent waiters if the new
 * status is terminal. Write failures throw — the caller must not report
 * success when this throws.
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

// -- Interrupt support (member turn abort ends blocking waits; tasks keep running) --

const memberWaitSettles = new Map<string, Set<() => void>>();

/** Register a settle callback for a member's in-flight background_wait calls.
 * Interrupt paths call settleBackgroundWaits so the tool returns the task's
 * real current status instead of holding the member's abort hostage. */
export function registerBackgroundWaitSettle(memberId: string, settle: () => void): () => void {
  let set = memberWaitSettles.get(memberId);
  if (!set) {
    set = new Set();
    memberWaitSettles.set(memberId, set);
  }
  set.add(settle);
  return () => {
    set!.delete(settle);
    if (set!.size === 0) memberWaitSettles.delete(memberId);
  };
}

export function settleBackgroundWaits(memberId: string): void {
  const set = memberWaitSettles.get(memberId);
  if (!set) return;
  const fns = [...set];
  set.clear();
  memberWaitSettles.delete(memberId);
  for (const fn of fns) fn();
}

// -- Restart sweep (service init only; never member reload) --------------

/**
 * Last-resort observable failure: the record itself cannot be written (disk
 * error). Waiters are resolved with an UNSAVED terminal snapshot — clearly
 * marked — so no one waits forever and nothing is reported as saved. The disk
 * record stays non-terminal; the restart sweep will mark it interrupted.
 */
export function failBackgroundTaskUnsaved(memberId: string, taskId: string, reason: string): void {
  const record = getBackgroundTask(memberId, taskId);
  logger.error("background-tasks", "record write failed; waiters resolved with unsaved failure", {
    memberId,
    taskId,
    reason,
  });
  if (!record) return;
  notifyTerminal({ ...record, status: "failed", error: `record write failed (unsaved diagnosis): ${reason}`, endedAt: new Date().toISOString() });
}

/**
 * Service-startup-only: mark every non-terminal task of every member
 * `interrupted`. Records and already-terminal results are preserved; execution
 * never resumes. Invalid records are skipped with their diagnostic already
 * logged — a bad record must not block startup.
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
      } catch (err) {
        logger.error("background-tasks", "restart sweep failed for task", {
          memberId,
          taskId: record.taskId,
          error: String(err),
        });
      }
    }
  }
  return marked;
}
