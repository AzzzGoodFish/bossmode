// DB authority for application lifecycle/results. Only SDK session bodies use files.
// Directory preparation is file-first and may leave an orphan if DB insertion fails;
// no task is discovered from that orphan and external SDK work is never auto-replayed.
import { mkdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { memberDir } from "../workspace/member-profile.js";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getDatabase } from "../storage/database.js";
import { assertExecutionOwner } from "../storage/repositories/execution-identity.js";
import { BackgroundRepository, terminalBackgroundStatus, validBackgroundId } from "../storage/repositories/background-repository.js";
import type { BackgroundUpdate } from "../storage/repositories/background-repository.js";
import type { BackgroundSessionMode, BackgroundTaskKind, BackgroundTaskRecord, BackgroundTaskSnapshot,
  BackgroundTaskStatus, BackgroundTaskTerminalStatus } from "../shared/types.js";

function repository(): BackgroundRepository { return new BackgroundRepository(getDatabase()); }
export function isTerminalBackgroundTaskStatus(status: BackgroundTaskStatus): status is BackgroundTaskTerminalStatus {
  return terminalBackgroundStatus(status);
}
export const isValidBackgroundTaskId = validBackgroundId;

interface TerminalListener { resolve(record: BackgroundTaskRecord): void; reject(error: Error): void }
const terminalListeners = new Map<string, Set<TerminalListener>>();
function listenerKey(memberId: string, taskId: string): string { return `${memberId}/${taskId}`; }
function notifyTerminal(record: BackgroundTaskRecord): void {
  const key = listenerKey(record.memberId, record.taskId);
  const listeners = terminalListeners.get(key);
  terminalListeners.delete(key);
  for (const listener of listeners ?? []) listener.resolve(record);
}
/** Outbox dispatcher hook: read committed truth, never deliver a caller's terminal snapshot. */
export function deliverBackgroundTerminal(memberId: string, taskId: string): void {
  const record = getBackgroundTask(memberId, taskId);
  if (record && isTerminalBackgroundTaskStatus(record.status)) notifyTerminal(record);
}
function scheduleTerminal(record: BackgroundTaskRecord): void {
  // Transactions are strictly synchronous. Defer until the outermost caller's
  // transaction has committed/rolled back, then re-read the durable status.
  queueMicrotask(() => {
    try { deliverBackgroundTerminal(record.memberId, record.taskId); }
    catch (error) { failBackgroundTaskUnsaved(record.memberId, record.taskId, String(error)); }
  });
}
export interface TerminalWait { promise: Promise<BackgroundTaskRecord>; dispose(): void }
export function whenTerminal(memberId: string, taskId: string): TerminalWait {
  const existing = getBackgroundTask(memberId, taskId);
  if (!existing) return {promise: Promise.reject(new Error(`background task not found: ${taskId}`)), dispose() {}};
  if (isTerminalBackgroundTaskStatus(existing.status)) return {promise: Promise.resolve(existing), dispose() {}};
  const key = listenerKey(memberId, taskId);
  let listener: TerminalListener;
  const promise = new Promise<BackgroundTaskRecord>((resolve, reject) => {
    listener = {resolve, reject};
    let listeners = terminalListeners.get(key);
    if (!listeners) { listeners = new Set(); terminalListeners.set(key, listeners); }
    listeners.add(listener);
  });
  return {promise, dispose() {
    const listeners = terminalListeners.get(key);
    listeners?.delete(listener);
    if (!listeners?.size) terminalListeners.delete(key);
  }};
}

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
  assertExecutionOwner(getDatabase(), input.memberId, input.scopeId);
  const startedAt = new Date().toISOString();
  const taskId = `bgt-${randomUUID()}`;
  const dir = join(memberDir(input.memberId), "background-tasks", startedAt.slice(0, 10), taskId);
  // Prepare only an SDK archive directory, not an application metadata file.
  // Validate each existing ancestor before creation to reject symlink escapes.
  const root = realpathSync(getBossmodeDir());
  let current = root;
  for (const segment of ["members", input.memberId, "background-tasks", startedAt.slice(0, 10)]) {
    current = join(current, segment);
    mkdirSync(current, {recursive: true});
    if (realpathSync(current) !== current || !current.startsWith(root + sep)) throw new Error("Background session directory escapes data root");
  }
  // Never reuse an orphan preparation or overwrite another SDK archive, even
  // if a generated ID collides. EEXIST is an observable failed preparation.
  mkdirSync(join(current, taskId));
  const record: BackgroundTaskRecord = {taskId, kind: input.kind, memberId: input.memberId, scopeId: input.scopeId,
    sessionMode: input.sessionMode, prompt: input.prompt, snapshot: {...input.snapshot}, status: "starting",
    startedAt, endedAt: null, result: null, error: null, sessionDir: dir, parentSessionRef: input.parentSessionRef ?? null};
  repository().create(record);
  return record;
}
export function getBackgroundTask(memberId: string, taskId: string): BackgroundTaskRecord | null {
  return isValidBackgroundTaskId(taskId) ? repository().get(memberId, taskId) : null;
}
export function listBackgroundTasks(memberId: string): BackgroundTaskRecord[] { return repository().list(memberId); }
export interface BackgroundTaskUpdate extends BackgroundUpdate {}
export function updateBackgroundTask(memberId: string, taskId: string, update: BackgroundTaskUpdate): BackgroundTaskRecord {
  const next = repository().update(memberId, taskId, update, new Date().toISOString());
  if (isTerminalBackgroundTaskStatus(next.status)) scheduleTerminal(next);
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

/** Reject waiters with a storage error, never invent a successful terminal write.
 * If a cancellation/completion race already committed a terminal state, report it. */
export function failBackgroundTaskUnsaved(memberId: string, taskId: string, reason: string): void {
  logger.error("background-tasks", "record write failed (unsaved diagnosis)", {memberId, taskId, reason});
  try {
    const record = getBackgroundTask(memberId, taskId);
    if (record && isTerminalBackgroundTaskStatus(record.status)) { scheduleTerminal(record); return; }
  } catch { /* Storage can be unavailable; reject without a second required read. */ }
  const key = listenerKey(memberId, taskId);
  const listeners = terminalListeners.get(key);
  terminalListeners.delete(key);
  for (const listener of listeners ?? []) listener.reject(new Error(`background task record write failed (unsaved diagnosis): ${reason}`));
}
/** Service initialization only, before execution starts. Failure blocks readiness. */
export function sweepInterruptedBackgroundTasks(): number {
  const records = repository().interruptIncomplete(new Date().toISOString());
  for (const record of records) scheduleTerminal(record);
  return records.length;
}
