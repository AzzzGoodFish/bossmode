import { logger } from "../kernel/logger.js";
import type { AgentHistoryEvent } from "./events.js";
import type {AgentHandle,AgentMemberConfig,AgentStatus,ContextUsage} from "./types.js";
export type DispatchState = "idle" | "promptSubmitted" | "running" | "aborting";
export interface PendingThinkingSwitch {
  thinkingLevel: string;
}
export interface PendingCredentialRefresh {
  profileId: string;
  providerSlug: string;
  changeType: "profileUpdated" | "profileDeleted";
}
export interface SessionSources {compiled:{agentPrompt:string;appendSystemPrompt:string[]};}
export interface AgentInstance {
  handle: AgentHandle;
  activeSourceRef: string | null;
  memberId: string;
  agentName: string;
  status: AgentStatus;
  dispatchState: DispatchState;
  promptInFlight: boolean;
  profilePromptDirty?: boolean;
  pendingThinkingSwitch?: PendingThinkingSwitch;
  pendingCredentialRefresh?: PendingCredentialRefresh;
  hadErrorInTurn: boolean;
  lastTurnError: string | null;
  pendingErrorNotice: string | null;
  lastMessageEndWasLength: boolean;
  lengthContinuationPending: boolean;
  lengthContinuationAttempted: boolean;
  compacting: boolean;
  turnActive: boolean;
  sessionSources: SessionSources;
  unsubscribe: () => void;
  eventBuffer: AgentHistoryEvent[];
  appliedModel: string;
  appliedCredentialId?: string;
  pendingReload: string | null;
}
export function instanceKey(memberId: string): string {
  if (!memberId) throw new Error("instanceKey requires memberId");
  return memberId;
}
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
    await Promise.allSettled(pending);
  }
}
export const instances = new Map<string, AgentInstance>();
export const activeInstanceCount=():number=>instances.size;
export const cancelledCreations = new Set<string>();
export const sessionPublishOwners = new Map<string, object>();
export const pendingCreations = new Map<string, Promise<AgentInstance | null>>();
export const memberSwitchGates = new Map<string, Promise<void>>();
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
export interface AgentStatusBroadcast { type: "agent:status"; roomId: string; agent: string; memberId: string; status: AgentStatus }
export type AgentStatusSink = (target: string, payload: AgentStatusBroadcast) => void;
let statusSink: AgentStatusSink | undefined;
export function setStatusSink(sink: AgentStatusSink | undefined): void { statusSink = sink; }
export function memberIdentityMeta(_agentName: string, memberId: string): { memberId:string } { return {memberId}; }
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
export const contextUsageCache = new Map<string, ContextUsage>();
import { getDatabase } from "../data/database.js";
import type { Database } from "../data/database.js";
export interface RuntimeStateEntry {contractFingerprint?:string;contractVersion?:number;driftNotified?:number}
interface RuntimeCheckpointRow {
  member_id: string; contract_fingerprint: string | null;
  contract_version:number|null;drift_notified:number|null;
}
function mapRuntimeCheckpoint(row:RuntimeCheckpointRow):RuntimeStateEntry {
  return {
    ...(row.contract_fingerprint === null ? {} : {contractFingerprint: row.contract_fingerprint}),
    ...(row.contract_version === null ? {} : {contractVersion: row.contract_version}),
    ...(row.drift_notified === null ? {} : {driftNotified: row.drift_notified}),
  };
}
export function getRuntimeStateEntry(memberId: string, db: Database = getDatabase()): RuntimeStateEntry {
  const row = db.get<RuntimeCheckpointRow>("SELECT * FROM runtime_checkpoints WHERE member_id=?", memberId);
  return row ? mapRuntimeCheckpoint(row) : {};
}
export function importRuntimeStateEntry(db: Database, memberId: string, entry: RuntimeStateEntry, updatedAt: number): void {
  db.transaction(tx => {
    if (!tx.get("SELECT id FROM members WHERE id=?", memberId)) throw new Error(`Unknown execution member ID: ${memberId}`);
    tx.run(`INSERT INTO runtime_checkpoints(member_id,contract_fingerprint,contract_version,drift_notified,stale_since,updated_at)
      VALUES(?,?,?,?,NULL,?) ON CONFLICT(member_id) DO UPDATE SET contract_fingerprint=excluded.contract_fingerprint,
      contract_version=excluded.contract_version,drift_notified=excluded.drift_notified,stale_since=NULL,updated_at=excluded.updated_at`,
      memberId,entry.contractFingerprint??null,entry.contractVersion??null,entry.driftNotified??null,updatedAt);
    tx.run("DELETE FROM runtime_stale_fields WHERE member_id=?",memberId);
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
export function notifyMemberProfileChanged(member: { id: string; name: string; title?: string }): void {
  profileRevision += 1;
  for (const instance of instances.values()) {
    if (!instance.memberId.startsWith("mem_")) continue;
    if (instance.memberId === member.id) {
      instance.agentName = member.name;
    }
    instance.profilePromptDirty = true;
  }
}
