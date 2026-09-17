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
  compiled: { agentPrompt: string; envPrompt: string; appendSystemPrompt: string[] };
  skills: string[];
  skillPaths: string[];
  cwd: string;
  roomMembers: string[];
  runtimeName: string;
}

export interface AgentInstance {
  handle: AgentHandle;
  /** ① B1: the chat currently being processed; one instance serves every chat. */
  activeChat: { scopeId: string };
  /** Conversation scope id: "room:<roomId>" | "dm:<memberId>" — chat owns the ScopeId alias. */
  scopeId: string;
  /** Room id when scope is room:*; empty string for dm. */
  roomId: string;
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

/** ① B4: member-level live status — one runtime, one status, every chat. */
export function getMemberLiveStatus(memberId: string): AgentStatus {
  const instance = instances.get(instanceKey(memberId));
  return instance ? instance.status : "inactive";
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
