// Agent instance table — one runtime instance per member (① B1), wherever it
// serves. This module owns the instance registry, creation registries, the
// member model-switch gate and the state-machine primitives that only touch
// instance fields. Publication (WS push) and business permission checks stay
// with callers; instance code never imports app/chat/member.
import { logger } from "../kernel/logger.js";
import type { AgentStatus, ContextUsage } from "../kernel/types.js";
import type { AgentHistoryEvent } from "./events.js";
import type { AgentHandle, AgentMemberConfig } from "./types.js";

export type DispatchState = "idle" | "promptSubmitted" | "running" | "aborting";

export interface PendingThinkingSwitch {
  thinkingLevel: string;
}

export interface PendingCredentialRefresh {
  profileId: string;
  providerSlug: string;
  changeType: "profileUpdated" | "profileDeleted";
}

/** Start-time sources a live instance was built from: member config as
 *  applied at build, compiled prompts, skills, cwd, roster, runtime name.
 *  Refresh paths consume these instead of re-resolving config. */
export interface SessionSources {
  /** Member config as applied at instance build (model/credential/thinking of that moment). */
  member: AgentMemberConfig;
  compiled: { agentPrompt: string; appendSystemPrompt: string[] };
  skills: string[];
  skillPaths: string[];
  cwd: string;
  runtimeName: string;
}

export interface AgentInstance {
  handle: AgentHandle;
  /** Opaque source currently owned by the scheduler; null between batches. */
  activeSourceRef: string | null;
  memberId: string;
  agentName: string; // current member name snapshot for display/mentions
  sourceAgent: string;
  status: AgentStatus;
  dispatchState: DispatchState;
  promptInFlight: boolean;
  profilePromptDirty?: boolean;
  pendingThinkingSwitch?: PendingThinkingSwitch;
  pendingCredentialRefresh?: PendingCredentialRefresh;
  hadErrorInTurn: boolean;
  /** Last turn failure text for wait() error-idle wake. Cleared at next runPrompt start. */
  lastTurnError: string | null;
  /** Defer system error notice until final agent_end (suppress during willRetry). */
  pendingErrorNotice: string | null;
  lastMessageEndWasLength: boolean;
  lengthContinuationPending: boolean;
  lengthContinuationAttempted: boolean;
  /** True while an SDK-driven compaction is running between turns (no active prompt/turn). */
  compacting: boolean;
  /** True from agent_start until agent_end — an SDK turn is actively in flight (distinct from dispatchState, which stays busy past agent_end until prompt() settles). */
  turnActive: boolean;
  /** Start-time session sources: exactly what this instance was built from —
   *  member config, compiled prompts, skills, cwd, roster, runtime name.
   *  Refresh/reload paths consume these instead of re-resolving config. */
  sessionSources: SessionSources;
  unsubscribe: () => void;
  eventBuffer: AgentHistoryEvent[];
  appliedModel: string;
  appliedCredentialId?: string;
  /** Live model switch in progress (design-model-switch-single-path-v1): the
   *  TARGET credential served to setModel's auth check before the applied
   *  binding flips. Set/cleared only by applyModelSwitchToInstance. */
  /** Batch 6 §3: reload requested mid-run — flushed when the turn settles. */
  pendingReload: string | null;
}

/** Runtime instance table key: one runtime per member, wherever it serves (① B1 2026-09-15). */
export function instanceKey(memberId: string): string {
  if (!memberId) throw new Error("instanceKey requires memberId");
  return memberId;
}

// Application continuations outlive SDK idle; keep their ownership until all
// post-prompt/config work has settled, including fire-and-forget control work.
const memberOperations = new Map<Promise<unknown>,string>();
export function trackMemberOperation<T>(memberId: string, operation:()=>Promise<T>): Promise<T> {
  let resolve!: (value:T|PromiseLike<T>)=>void;
  let reject!: (error:unknown)=>void;
  const pending=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  const settlement=pending.finally(()=>memberOperations.delete(settlement));
  memberOperations.set(settlement,memberId);
  try {operation().then(resolve,reject);}catch(error){reject(error);}
  return settlement;
}
export async function settleMemberOperations(memberId?: string): Promise<void> {
  for (;;) {
    const pending=[...memberOperations].filter(([,owner])=>memberId===undefined || owner===memberId).map(([operation])=>operation);
    if (!pending.length) return;
    // Execution/control failures are reported by their caller. Here only
    // completion matters; SDK/resource cleanup failures are collected separately.
    await Promise.allSettled(pending);
  }
}

export const instances = new Map<string, AgentInstance>();
export const cancelledCreations = new Set<string>();
export const sessionPublishOwners = new Map<string, object>();
export const pendingCreations = new Map<string, Promise<AgentInstance | null>>();

/** §10 interlock, ONE map: presence = a member model switch is in progress.
 * The promise resolves when that switch finishes (commit or rollback). It is
 * both the switch lock (synchronous has/set at switchMemberModel entry) and
 * the creation gate (creations wait for it to end before building). */
export const memberSwitchGates = new Map<string, Promise<void>>();

/** §10: creations of this member already in flight (pendingCreations is keyed
 * by member after ① B1) — the switch awaits them so its instance snapshot is
 * complete. */
export function pendingCreationsFor(memberId: string): Array<Promise<AgentInstance | null>> {
  const pending = pendingCreations.get(instanceKey(memberId));
  return pending ? [pending] : [];
}

export function updateDispatchState(instance: AgentInstance, next: DispatchState, trigger: string): void {
  if (instance.dispatchState === next) return;
  logger.info("agent", "dispatchStateTransition", {
    member: instance.agentName,
    from: instance.dispatchState,
    to: next,
    trigger,
  });
  instance.dispatchState = next;
}

// -- Status publication (output port; connected by app/wire) --
/** Same shape as the websocket `agent:status` payload; the app owns the transport. */
export interface AgentStatusBroadcast { type: "agent:status"; roomId: string; agent: string; memberId?: string; status: AgentStatus }
export type AgentStatusSink = (target: string, payload: AgentStatusBroadcast) => void;
let statusSink: AgentStatusSink | undefined;
export function setStatusSink(sink: AgentStatusSink | undefined): void { statusSink = sink; }

export function memberIdentityMeta(agentName: string, memberId: string): { memberId?: string } {
  return memberId && memberId !== agentName ? { memberId } : {};
}

export function transition(
  instance: AgentInstance,
  sourceRef: string | null,
  memberName: string,
  newStatus: AgentStatus,
  trigger: string,
): void {
  if (instance.status === newStatus) return;
  const previous = instance.status;
  instance.status = newStatus;
  const target = instance.activeSourceRef ?? sourceRef;
  logger.info("agent", "stateTransition", {
    member: memberName,
    from: previous,
    to: newStatus,
    trigger,
    ...(target ? { sourceRef: target } : {}),
  });
  if (target) statusSink?.(target, {
    type: "agent:status",
    roomId: target,
    agent: memberName,
    ...memberIdentityMeta(memberName, instance.memberId),
    status: newStatus,
  });
}

// -- Context usage (cache-only API + idle refresh push) --
export const contextUsageCache = new Map<string, ContextUsage>();
export const contextCompactionWarningCache = new Set<string>();

export function isCompactUsageDrop(previous: ContextUsage | undefined, next: ContextUsage): boolean {
  if (!previous) return false;
  if (!Number.isFinite(previous.totalTokens) || !Number.isFinite(next.totalTokens)) return false;
  if (previous.totalTokens <= 0 || next.totalTokens <= 0) return false;
  const max = next.rawMaxTokens || previous.rawMaxTokens || 0;
  const wasNearOrOverLimit = max > 0 ? previous.totalTokens >= max * 0.8 : previous.percentage >= 80;
  return wasNearOrOverLimit && next.totalTokens <= previous.totalTokens * 0.25;
}

export function shouldKeepCompactedMarker(previous: ContextUsage | undefined, next: ContextUsage): boolean {
  if (!previous?.compacted) return false;
  if (!Number.isFinite(previous.totalTokens) || !Number.isFinite(next.totalTokens)) return false;
  if (previous.totalTokens <= 0 || next.totalTokens <= 0) return false;
  return next.totalTokens <= previous.totalTokens * 1.25;
}

// -- Runtime checkpoints (member-level recovery metadata; ① B8 / C3) --
// DB-owned state; module import never initializes storage.
import { getDatabase } from "../data/database.js";
import type { Database } from "../data/database.js";
import type { MountStale, RuntimeStateEntry, RuntimeStateMap } from "../data/types.js";

export type { MountStale, RuntimeStateEntry, RuntimeStateMap };

interface RuntimeCheckpointRow {
  member_id: string; contract_fingerprint: string | null;
  contract_version: number | null; drift_notified: number | null; stale_since: number | null;
}

function mapRuntimeCheckpoint(db: Database, row: RuntimeCheckpointRow): RuntimeStateEntry {
  return {
    ...(row.contract_fingerprint === null ? {} : {contractFingerprint: row.contract_fingerprint}),
    ...(row.contract_version === null ? {} : {contractVersion: row.contract_version}),
    ...(row.drift_notified === null ? {} : {driftNotified: row.drift_notified}),
    ...(row.stale_since === null ? {} : {staleMounts: {since: row.stale_since,
      fields: db.all<{field: string}>("SELECT field FROM runtime_stale_fields WHERE member_id=? ORDER BY ordinal", row.member_id).map(item => item.field)}}),
  };
}

export function getRuntimeStateEntry(memberId: string, db: Database = getDatabase()): RuntimeStateEntry {
  const row = db.get<RuntimeCheckpointRow>("SELECT * FROM runtime_checkpoints WHERE member_id=?", memberId);
  return row ? mapRuntimeCheckpoint(db, row) : {};
}

/** Pure upgrade/runtime import with an explicit database and source timestamp. */
export function importRuntimeStateEntry(db: Database, memberId: string, entry: RuntimeStateEntry, updatedAt: number): void {
  db.transaction(tx => {
    if (!tx.get("SELECT id FROM members WHERE id=?", memberId)) throw new Error(`Unknown execution member ID: ${memberId}`);
    tx.run(`INSERT INTO runtime_checkpoints(member_id,contract_fingerprint,contract_version,drift_notified,stale_since,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET contract_fingerprint=excluded.contract_fingerprint,
      contract_version=excluded.contract_version, drift_notified=excluded.drift_notified, stale_since=excluded.stale_since, updated_at=excluded.updated_at`,
    memberId, entry.contractFingerprint ?? null, entry.contractVersion ?? null, entry.driftNotified ?? null, entry.staleMounts?.since ?? null, updatedAt);
    tx.run("DELETE FROM runtime_stale_fields WHERE member_id=?", memberId);
    [...new Set(entry.staleMounts?.fields ?? [])].forEach((field, ordinal) =>
      tx.run("INSERT INTO runtime_stale_fields(member_id,field,ordinal) VALUES(?,?,?)", memberId, field, ordinal));
  });
}

function updateRuntimeState(memberId: string, change: (current: RuntimeStateEntry) => RuntimeStateEntry | undefined, updatedAt: number): void {
  const db = getDatabase();
  db.transaction(tx => {
    const next = change(getRuntimeStateEntry(memberId, tx));
    if (next) importRuntimeStateEntry(tx, memberId, next, updatedAt);
  });
}

export function updateRuntimeStateEntry(memberId: string, patch: RuntimeStateEntry): void {
  updateRuntimeState(memberId, current => ({...current, ...patch}), Date.now());
}
export function setContractFingerprint(memberId: string, fingerprint: string, contractVersion: number): void {
  updateRuntimeStateEntry(memberId, {contractFingerprint: fingerprint, contractVersion, driftNotified: undefined});
}
export function markStaleMounts(memberId: string, fields: string[]): void {
  const now = Date.now();
  updateRuntimeState(memberId, current => ({...current, staleMounts: {
    since: now, fields: [...new Set([...(current.staleMounts?.fields ?? []), ...fields])],
  }}), now);
}
export function clearStaleMounts(memberId: string): void {
  updateRuntimeState(memberId, current => current.staleMounts ? ({...current, staleMounts: undefined}) : undefined, Date.now());
}
export function clearRuntimeStateEntry(memberId: string): void {
  getDatabase().run("DELETE FROM runtime_checkpoints WHERE member_id=?", memberId);
}

// -- Runtime admission and public failure messages --
let stopping = false;
export function openRuntimeAdmission(): void { stopping = false; }
export function closeRuntimeAdmission(): void { stopping = true; }
export function runtimeIsStopping(): boolean { return stopping; }
/** Archive intent closes member admission durably before quiescence starts. */
export function memberRuntimeAllowed(memberId: string): boolean {
  if (stopping) return false;
  return !!getDatabase().get(`SELECT 1 FROM members m WHERE m.id=? AND m.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM member_archive_intents a WHERE a.member_id=m.id AND a.state='pending')`, memberId);
}

// -- Instance tracking --

export function formatRuntimeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Failed to extract accountId from token")) {
    return "OAuth credential is invalid or expired. Reconnect it in Settings → Model Credentials.";
  }
  // Binding/session desync after a partial model switch (2026-07-30).
  // Keep the provider name — fish needs it to diagnose which side is stuck.
  const providerMismatch = message.match(/Provider is not configured:\s*(\S+)/i);
  if (providerMismatch) {
    return `Model switch did not finish applying (session still needs provider "${providerMismatch[1]}" but the binding moved on). Retry the model switch, or Restart the member. Original: ${message}`;
  }
  return message;
}

export function isMemberConfigured(member: AgentMemberConfig): boolean {
  return Boolean(member.model && member.credentialId);
}

export function memberUnconfiguredMessage(memberName: string): string {
  return `Member "${memberName}" hasn't selected a model yet. Open the member card to choose a model and credential, then try again.`;
}


let profileRevision = 0;
export function currentProfileRevision(): number { return profileRevision; }

/** Publication after a committed DB identity update. Never resets an active handle. */
export function notifyMemberProfileChanged(member: { id: string; name: string; title?: string }): void {
  profileRevision += 1;
  for (const instance of instances.values()) {
    if (!instance.memberId.startsWith("mem_")) continue;
    if (instance.memberId === member.id) {
      instance.agentName = member.name;
      instance.sessionSources.member.name = member.name;
      instance.sessionSources.member.title = member.title;
    }
    // Environment includes current roster names, including other active members.
    instance.profilePromptDirty = true;
  }
}
