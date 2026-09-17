import { mainSessionDirectory } from "../../files/layout.js";
import {randomUUID} from "node:crypto";
import {recoverRuntimeInputState,acceptRuntimeInput,acceptControlInput,pendingRuntimeInputs,pendingRuntimeInputCount,memberPendingInputCount,pendingRuntimeInputOwners,runtimeInputOwner,runtimeInputPayload,runtimeReplySources,runtimeInputHasContinuation,hasRuntimeReply,claimRuntimeInputs,finishRuntimeInputs,dismissRuntimeReplies,cancelPendingRuntimeInputs,type PreparedRuntimeInput} from "./runtime-input-service.js";
import {InputQueueRepository,type QueuedInput} from "../../data/repositories/input-queue-repository.js";
import {ReplyObligationRepository,type ReplyDisposition} from "../../data/repositories/reply-obligation-repository.js";
import type {CapturedMessage} from "../../data/repositories/delivery-repository.js";
import {readMemberProfile,isBlankPersona} from "../../member/profile.js";
import type {MentionActivationCtx} from "../../chat/router.js";
import { getDatabase } from "../../data/database.js";
import { closeRuntimeAdmission, openRuntimeAdmission, memberRuntimeAllowed, runtimeIsStopping } from "./runtime-admission.js";
// Agent Manager — agent lifecycle management (slimmed down)
// Prompt compilation → agent/prompt/prompt-compiler.ts
// Event handling → agent/events.ts
// Tool callbacks → agent/tools/tools.ts

import { join } from "node:path";
import { logger } from "../../kernel/logger.js";
import { resolveGlobalSkillPaths } from "../../member/skills.js";
import { activeWorkspaceRoot } from "../../member/workspaces.js";
import { resolveRoomMember } from "../../member/room-member-resolver.js";

import { isSystemNoticeHiddenFromMembers } from "../../kernel/runtime-error-limit.js";
import * as roomStore from "../../chat/conversations.js";
import * as sessionStore from "../../member/sessions.js";

import * as attachmentStore from "../../files/attachment-store.js";
import { postMessage, getMessagesSince, getLatestMessageId } from "../../chat/message-bus.js";
import { initRouter } from "../../chat/router.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../../app/server/ws.js";
import { compileMemberPrompt, currentContractFingerprint, type MemberPromptSource } from "../prompt.js";
import { instanceKey, isMmScopeId, parseMmScopeId, scopeIdOf, parseScopeId, type ScopeId } from "../../chat/conversations.js";
import { listRoomsForMember } from "../../chat/conversations.js";
import { getMember, getMemberConfiguration, applyMemberConfigPatch, type MemberRecord } from "../../member/identity.js";
import { readAllDmMessages } from "../../chat/dm-message-store.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk } from "../events.js";
import { loadScopeMessages } from "../tools/tools.js";
import { MEMBER_CONTRACT_VERSION } from "../../kernel/contract-version.js";
import { setContractFingerprint, clearStaleMounts, clearRuntimeStateEntry } from "../../member/runtime-state.js";
import {
  wrapRoomContextMessage,
  wrapRoomMessagesTranscript,
  resolveSenderRole,
  type SenderRole,
} from "./message-envelope.js";
import {
  setActivationSource,
  clearActivationSource,
  clearAllActivationSources,
} from "./activation-context.js";
import type { AgentHistoryEvent } from "../events.js";
import type { RuntimeRegistry } from "../runtime/registry.js";
import type { AgentHandle, AgentStreamEvent, AgentMemberConfig } from "../types.js";
import { getModelCredentialProfile } from "../../config/models.js";
import { exportPiConfigForMember } from "../../config/pi-adapt/credentials.js";
import { normalizeModelRef, assertModelAvailable } from "../../config/models.js";
import { settleMemberShellWaits } from "../terminal/shell-manager.js";
import type { AgentStatus, RoomMessage, ContextUsage, Room } from "../../kernel/types.js";

// -- Registry injection --

let registry: RuntimeRegistry | null = null;
let promptSource: ((memberId: string) => MemberPromptSource) | null = null;
function compileForMember(memberId: string) {
  if (!promptSource) throw new Error("Member prompt source is not connected");
  return compileMemberPrompt(promptSource(memberId));
}
let shutdownSettlement: Promise<void> | null = null;
let shutdownRunning = false;

export function initAgentManager(reg: RuntimeRegistry, loadPrompt: (memberId: string) => MemberPromptSource): void {
  if (shutdownRunning) throw new Error("Runtime shutdown is still in progress");
  if(registry&&(instances.size||pendingCreations.size||inputPumps.size))throw new Error("Runtime initialization requires completed teardown");
  recoverRuntimeInputState();
  shutdownSettlement = null; openRuntimeAdmission();
  registry = reg;
  promptSource = loadPrompt;
}

/** Called only after HTTP/PID publication, never during historical import. */
export function resumePendingRuntimeInputs():void{
  const pending=new InputQueueRepository(getDatabase());let afterId=0;
  for(;;){const page=pending.listPending({afterId,limit:1000});if(!page.length)break;
    for(const input of page){afterId=input.id;void pumpRuntimeInputs(input.scopeId,input.targetActorKey).catch(error=>logger.error("agent","pending input recovery failed",{inputId:input.id,error:String(error)}));}
  }
}

export function getRegistry(): RuntimeRegistry | null {
  return registry;
}

// -- Instance tracking --

type DispatchState = "idle" | "promptSubmitted" | "running" | "aborting";

function formatRuntimeErrorMessage(error: unknown): string {
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

function isMemberConfigured(member: AgentMemberConfig): boolean {
  return Boolean(member.model && member.credentialId);
}

function memberUnconfiguredMessage(memberName: string): string {
  return `Member "${memberName}" hasn't selected a model yet. Open the member card to choose a model and credential, then try again.`;
}

function filterAgentVisibleMessages(messages: RoomMessage[], _memberName: string): RoomMessage[] {
  // fish 2026-08-04: members never see system notices — neither runtime
  // failures nor non-error system prompts. Typed task/knowledge events stay.
  return messages.filter((message) => !isSystemNoticeHiddenFromMembers(message));
}

/** Last visible message that mentions this member (the @ that fired the
 * activation); -1 when nothing mentions (steer/system activations). */
function isOwnMessage(message: RoomMessage, memberId: string, memberName: string): boolean {
  return message.senderMemberId !== undefined ? message.senderMemberId === memberId
    : !memberId.startsWith("mem_") && message.sender === memberName;
}

function lastMentionTriggerIndex(messages: RoomMessage[], memberName: string, memberId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (Array.isArray(message.mentionMemberIds)) {
      if (message.mentionMemberIds.includes(memberId)) return i;
    } else if (!memberId.startsWith("mem_") && message.mentions?.includes(memberName)) return i;
  }
  return -1;
}

/** One-line unread-backlog hint for hybrid injection (fish-approved spec
 * msg:#14818). Null when there is no backlog (the common path). Senders are
 * user-first, then by count desc; task/knowledge event counts are omitted
 * when zero; system notices are already filtered out upstream. */
export function buildUnreadBacklogHint(backlog: RoomMessage[], opts?: { total?: number; fromSeq?: number }): string | null {
  if (backlog.length === 0) return null;
  const first = (backlog[0] as { seq?: number }).seq;
  const last = (backlog[backlog.length - 1] as { seq?: number }).seq;
  const bySender = new Map<string, number>();
  let taskEvents = 0;
  let knowledgeEvents = 0;
  for (const m of backlog) {
    const sender = m.sender || "unknown";
    bySender.set(sender, (bySender.get(sender) ?? 0) + 1);
    const type = (m as { type?: string }).type;
    if (type === "task_event") taskEvents += 1;
    else if (type === "knowledge_event") knowledgeEvents += 1;
  }
  const ordered = [...bySender.entries()].sort((a, b) => {
    if (a[0] === "user") return -1;
    if (b[0] === "user") return 1;
    return b[1] - a[1];
  });
  const senders = ordered.map(([s, c]) => `${s}×${c}`).join(", ");
  const events: string[] = [];
  if (taskEvents > 0) events.push(`${taskEvents} task events`);
  if (knowledgeEvents > 0) events.push(`${knowledgeEvents} knowledge updates`);
  const eventClause = events.length > 0 ? ` — incl. ${events.join(", ")}` : "";
  const total = opts?.total ?? backlog.length;
  const truncated = total > backlog.length;
  const fromSeq = opts?.fromSeq ?? (typeof first === "number" ? first - 1 : 0);
  const range = truncated
    ? `you have ${total} unread (latest ${backlog.length}, No.${first}–No.${last})`
    : `you have ${backlog.length} unread messages (No.${first}–No.${last})`;
  return `[Earlier in this room ${range}: ${senders}${eventClause}. Read them with chat_read (from_seq ${fromSeq}); reading marks them seen.]`;
}

interface PendingThinkingSwitch {
  thinkingLevel: string;
}

interface PendingCredentialRefresh {
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

interface AgentInstance {
  handle: AgentHandle;
  /** ① B1: the chat currently being processed; one instance serves every chat. */
  activeChat: { scopeId: string };
  /** Conversation scope id: "room:<roomId>" | "dm:<memberId>". */
  scopeId: ScopeId;
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
   * TARGET credential served to setModel's auth check before the applied
   * binding flips. Set/cleared only by applyModelSwitchToInstance. */
  /** Batch 6 §3: reload requested mid-run — flushed when the turn settles. */
  pendingReload: string | null;
}

// Application continuations outlive SDK idle; keep their ownership until all
// post-prompt/config work has settled, including fire-and-forget control work.
const memberOperations = new Map<Promise<unknown>,string>();
function trackMemberOperation<T>(memberId: string, operation:()=>Promise<T>): Promise<T> {
  let resolve!: (value:T|PromiseLike<T>)=>void;
  let reject!: (error:unknown)=>void;
  const pending=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
  const settlement=pending.finally(()=>memberOperations.delete(settlement));
  memberOperations.set(settlement,memberId);
  try {operation().then(resolve,reject);}catch(error){reject(error);}
  return settlement;
}
async function settleMemberOperations(memberId?: string): Promise<void> {
  for (;;) {
    const pending=[...memberOperations].filter(([,owner])=>memberId===undefined || owner===memberId).map(([operation])=>operation);
    if (!pending.length) return;
    // Execution/control failures are reported by their caller. Here only
    // completion matters; SDK/resource cleanup failures are collected separately.
    await Promise.allSettled(pending);
  }
}

const instances = new Map<string, AgentInstance>();
const cancelledCreations = new Set<string>();
const sessionPublishOwners = new Map<string, object>();
const pendingCreations = new Map<string, Promise<AgentInstance | null>>();

/** §10 interlock, ONE map: presence = a member model switch is in progress.
 * The promise resolves when that switch finishes (commit or rollback). It is
 * both the switch lock (synchronous has/set at switchMemberModel entry) and
 * the creation gate (creations wait for it to end before building). */
const memberSwitchGates = new Map<string, Promise<void>>();

/** §10: creations of this member already in flight (pendingCreations is keyed
 * by member after ① B1) — the switch awaits them so its instance snapshot is
 * complete. */
function pendingCreationsFor(memberId: string): Array<Promise<AgentInstance | null>> {
  const pending = pendingCreations.get(instanceKey(memberId));
  return pending ? [pending] : [];
}

function roomScopeId(roomId: string): ScopeId {
  return scopeIdOf({ kind: "room", roomId });
}

/** Current SQL scope access, separate from immutable historical execution ownership. */
function memberHasScopeAccess(scopeValue: string, memberId: string): boolean {
  const scope = runtimeInputOwner(scopeValue, memberId).scopeId;
  if (scope.startsWith("dm:")) return scope === `dm:${memberId}`;
  if (isMmScopeId(scope)) return Boolean(parseMmScopeId(scope)?.includes(memberId));
  return !!scope && !!roomStore.resolveRoomMemberRef(scope, memberId);
}
function memberScopeAllowsExecution(scopeValue: string, memberId: string): boolean {
  return memberRuntimeAllowed(memberId) && memberHasScopeAccess(scopeValue, memberId);
}
class RuntimeScopeRevokedError extends Error {
  constructor() { super("Member no longer has access to this execution scope"); }
}

/** Aggregate live status for a conversation scope (chats list / working-set). */
export function getScopeLiveStatus(scopeId: ScopeId): "idle" | "working" | "inactive" {
  const ref = parseScopeId(scopeId);
  if (!ref) return "inactive";
  if (ref.kind === "dm") {
    const st = getAgentStatus(scopeId, ref.memberId);
    if (st === "working") return "working";
    if (st === "inactive") return "inactive";
    return "idle";
  }
  // Room: any member working → working; else idle if any live instance else inactive
  let sawInstance = false;
  for (const m of roomStore.getRoomMembers(ref.roomId)) {
    const st = getAgentStatus(ref.roomId, m.id);
    if (st === "inactive") continue;
    sawInstance = true;
    if (st === "working") return "working";
  }
  const room = roomStore.getRoom(ref.roomId);
  for (const gid of room?.globalMemberIds || []) {
    const st = getAgentStatus(ref.roomId, gid);
    if (st === "working") return "working";
    if (st !== "inactive") sawInstance = true;
  }
  if (sawInstance) return "idle";
  return "inactive";
}

/**
 * ① B4: working-set for contacts — the scopes where this member has unhandled
 * messages queued or a turn being served right now (one runtime serves every
 * chat, so the build scope says nothing about where it is active).
 */
export function getMemberActiveScopes(globalMemberId: string): ScopeId[] {
  const out: ScopeId[] = [];
  const seen = new Set<string>();
  const push = (scope: string) => { if (scope && !seen.has(scope)) { seen.add(scope); out.push(scope as ScopeId); } };
  const own = instances.get(instanceKey(globalMemberId));
  for (const scope of pendingRuntimeInputOwners(globalMemberId)) push(scope);
  if (own && (own.status === "working" || own.dispatchState !== "idle")) push(own.activeChat?.scopeId || own.scopeId);
  if (own || out.length) return Array.from(out);
  // Historical name-only members (no mem_ id): keep the legacy room/DM match.
  for (const inst of instances.values()) {
    if (inst.status !== "working" && inst.dispatchState === "idle") continue;
    if (inst.memberId.startsWith("mem_")) continue;
    if (inst.scopeId.startsWith("dm:")) {
      if (inst.memberId === globalMemberId || inst.scopeId === `dm:${globalMemberId}`) push(inst.scopeId);
      continue;
    }
    const roomUuid = inst.roomId.startsWith("room:") ? inst.roomId.slice("room:".length) : inst.roomId;
    const r = roomStore.getRoom(roomUuid);
    if (!r) continue;
    const local = roomStore.getRoomMembers(r.id).find((m) => m.id === inst.memberId || m.name === inst.agentName);
    if (!local) continue;
    const gid = roomStore.resolveGlobalMemberId(r, local);
    if (gid === globalMemberId) push(scopeIdOf({ kind: "room", roomId: r.id }));
  }
  return Array.from(out);
}

/** ① B4: member-level live status — one runtime, one status, every chat. */
export function getMemberLiveStatus(memberId: string): AgentStatus {
  const instance = instances.get(instanceKey(memberId));
  return instance ? instance.status : "inactive";
}

function memberIdentityMeta(agentName: string, memberId: string): { memberId?: string } {
  return memberId && memberId !== agentName ? { memberId } : {};
}

function transition(
  instance: AgentInstance,
  roomId: string,
  memberName: string,
  newStatus: AgentStatus,
  trigger: string,
): void {
  if (instance.status === newStatus) return;
  const prev = instance.status;
  instance.status = newStatus;
  // ① B1: status follows the chat the member is serving right now; callers pass
  // the build-time room only as a fallback.
  const chat = instance.activeChat?.scopeId || roomId;
  const publishTo = chatTargetOf(chat);
  logger.info("agent", "stateTransition", { member: memberName, from: prev, to: newStatus, trigger, chat });
  broadcastToRoom(publishTo, { type: "agent:status", roomId: publishTo, agent: memberName, ...memberIdentityMeta(memberName, instance.memberId), status: newStatus });
}

/** ① B1: postMessage/transition target for a scope id — bare room id or dm:<id>. */
function chatTargetOf(scopeId: string): string {
  return scopeId.startsWith("room:") ? scopeId.slice("room:".length) : scopeId;
}

function updateDispatchState(instance: AgentInstance, next: DispatchState, trigger: string): void {
  if (instance.dispatchState === next) return;
  logger.info("agent", "dispatchStateTransition", {
    member: instance.agentName,
    from: instance.dispatchState,
    to: next,
    trigger,
  });
  instance.dispatchState = next;
}

function queueDepth(instance:AgentInstance):number{return memberPendingInputCount(instance.memberId);}
const inputPumps=new Map<string,Promise<void>>();
// Waiter handles observe committed receipts; they are not queue or reply authority.
const inputProgress=new Map<string,Set<(error?:unknown)=>void>>();
function waitForInputSettlement(input:QueuedInput,operation:Promise<void>):Promise<void>{
  const key=instanceKey(input.targetActorKey);
  return new Promise((resolve,reject)=>{
    const listeners=inputProgress.get(key)??new Set<(error?:unknown)=>void>();inputProgress.set(key,listeners);
    let finished=false;
    const cleanup=()=>{finished=true;listeners.delete(check);if(!listeners.size&&inputProgress.get(key)===listeners)inputProgress.delete(key);};
    const check=(error?:unknown)=>{if(finished)return;try{if(error)throw error;if(!memberRuntimeAllowed(input.targetActorKey)){cleanup();resolve();return;}const row=new InputQueueRepository(getDatabase()).get(input);if(row&&row.status!=="pending"&&row.status!=="dispatched"&&!runtimeInputHasContinuation(input)){cleanup();resolve();}}catch(error){cleanup();reject(error);}};
    listeners.add(check);
    void operation.then(()=>check(),error=>check(error));
  });
}
const inputScopeEpoch=new Map<string,number>();
function invalidateInputScope(key:string):void{inputScopeEpoch.set(key,(inputScopeEpoch.get(key)??0)+1);}
function applyPendingAfterPromptSettlement(instance:AgentInstance,trigger:string):void{
  applyPendingCredentialRefresh(instance,trigger);applyPendingThinkingSwitch(instance,trigger);
}
function drainQueuedInputsAsPrompt(instance:AgentInstance,trigger:string):boolean{
  if(!memberRuntimeAllowed(instance.memberId)||!queueDepth(instance)||instance.compacting||instance.promptInFlight||instance.turnActive||instance.dispatchState!=="idle")return false;
  void pumpRuntimeInputs(instance.activeChat?.scopeId||instance.scopeId,instance.memberId).catch(error=>logger.error("agent","queued input failed",{memberId:instance.memberId,trigger,error:String(error)}));
  return true;
}
function pumpRuntimeInputs(scopeValue:string,memberId:string):Promise<void>{
  const owner=runtimeInputOwner(scopeValue,memberId),key=instanceKey(memberId);
  const current=inputPumps.get(key);if(current)return current;
  if(!memberRuntimeAllowed(memberId)||!memberPendingInputCount(memberId))return Promise.resolve();
  if(!memberScopeAllowsExecution(owner.scopeId,memberId)){
    cancelPendingRuntimeInputs(owner,"execution scope access revoked");
    return Promise.resolve();
  }
  const epoch=inputScopeEpoch.get(key)??0;
  let failed=false;
  const operation=trackMemberOperation(memberId,async()=>{
    const scopeId=owner.scopeId.startsWith("dm:")||isMmScopeId(owner.scopeId)?owner.scopeId:roomScopeId(owner.scopeId);
    const instance=await buildMemberAgentSession(memberId,scopeId);
    if(!instance){
      if(!runtimeIsStopping()&&(inputScopeEpoch.get(key)??0)===epoch){
        const revoked=!memberScopeAllowsExecution(owner.scopeId,memberId);
        cancelPendingRuntimeInputs(owner,revoked?"execution scope access revoked":"runtime creation failed",revoked?"cancelled":"failed");
      }
      if(memberScopeAllowsExecution(owner.scopeId,memberId)&&(inputScopeEpoch.get(key)??0)===epoch){
        const member=memberRecordToConfig(memberId);
        postMessage(owner.scopeId,"system",member&&!isMemberConfigured(member)?memberUnconfiguredMessage(member.name):`Failed to activate member "${getMember(memberId)?.name??memberId}": runtime unavailable.`);
      }
      return;
    }
    for(;;){
      if(!memberRuntimeAllowed(memberId)||instances.get(key)!==instance||instance.compacting||instance.promptInFlight||instance.turnActive||instance.dispatchState!=="idle")break;
      if(!memberScopeAllowsExecution(owner.scopeId,memberId)){
        cancelPendingRuntimeInputs(owner,"execution scope access revoked");
        break;
      }
      const inputs=pendingRuntimeInputs(owner);if(!inputs.length)break;
      await runInputBatch(instance,inputs);
      for(const notify of [...(inputProgress.get(key)??[])])notify();
    }
    if(!queueDepth(instance))maybeFlushPendingReload(instance);
  }).catch(error=>{
    failed=true;
    if(!runtimeIsStopping()&&(inputScopeEpoch.get(key)??0)===epoch)cancelPendingRuntimeInputs(owner,"runtime input execution failed","failed");
    for(const notify of [...(inputProgress.get(key)??[])])notify(error);
    if(memberRuntimeAllowed(memberId))postMessage(owner.scopeId,"system",`Failed to activate member "${getMember(memberId)?.name??memberId}": ${formatRuntimeErrorMessage(error)}`);
    throw error;
  });
  inputPumps.set(key,operation);
  return operation.finally(()=>{
    if(inputPumps.get(key)===operation)inputPumps.delete(key);
    // ① B1: a member left publicly "working" only because its queue was going
    // to drain must fall back to idle once that queued work is gone (e.g. a
    // membership removal cancelled it) — otherwise every later activation
    // reads the member as busy.
    const quiet=instances.get(key);
    if(quiet&&!quiet.promptInFlight&&!quiet.turnActive&&quiet.dispatchState==="idle"&&quiet.status!=="idle"&&!memberPendingInputCount(memberId)){
      transition(quiet,quiet.roomId,quiet.agentName,"idle","queue-cancelled");
    }
    for(const notify of [...(inputProgress.get(key)??[])])notify();
    const live=instances.get(key);
    if(!failed&&memberRuntimeAllowed(memberId)&&memberPendingInputCount(memberId)&&(!live||(!live.compacting&&!live.promptInFlight&&!live.turnActive&&live.dispatchState==="idle"))){
      // ① B1: the member's pending work may live in several chats — wake every
      // owner scope, not just the one that started this pump.
      queueMicrotask(()=>{for(const ownerScope of pendingRuntimeInputOwners(memberId))void pumpRuntimeInputs(ownerScope,memberId).catch(error=>logger.error("agent","input wake failed",{memberId,error:String(error)}));});
    }
  });
}
const LENGTH_CONTINUATION_PROMPT="⚠ Your previous response was cut off due to output length. Continue from where you stopped and deliver the result — respond with the `chat_send` tool.";
const LENGTH_CONTINUATION_FAILED_WARNING="Member was cut off due to output length again after one automatic continuation. Automatic continuation stopped to avoid a loop; please send a new instruction if you want them to continue.";
function isLengthStopReason(stopReason:unknown):boolean{
  if(typeof stopReason!=="string")return false;
  const value=stopReason.toLowerCase();return value==="length"||value.includes("max_tokens")||value.includes("max_output");
}
function finalizePromptSettlement(instance:AgentInstance,inputs:QueuedInput[],trigger:string,skipChatWarning:boolean):void{
  if(instances.get(instanceKey(instance.memberId))!==instance)return;
  updateDispatchState(instance,"idle",trigger);
  if(!memberRuntimeAllowed(instance.memberId))return;
  applyPendingAfterPromptSettlement(instance,trigger);
  // ① B1: this batch's chat, not the build-time scope.
  const chat=instance.activeChat?.scopeId||instance.roomId;
  const chatTarget=chatTargetOf(chat);
  // Pending work does not inherit this batch's reply obligations. Complete or
  // explicitly hand off this batch before the pump chooses its next inputs.
  if(instance.lengthContinuationPending&&!skipChatWarning){
    instance.lengthContinuationPending=false;instance.lastMessageEndWasLength=false;
    if(instance.lengthContinuationAttempted){
      dismissRuntimeReplies(inputs,"continuation-exhausted","length continuation budget exhausted");
      postMessage(chatTarget,"system",`Member "${instance.agentName}" ${LENGTH_CONTINUATION_FAILED_WARNING}`);
    }else{
      instance.lengthContinuationAttempted=true;
      const owed=hasRuntimeReply(runtimeInputOwner(chat,instance.memberId),inputs);
      acceptControlInput(chat,instance.memberId,{prompt:owed?LENGTH_CONTINUATION_PROMPT:"Your response was cut off due to output length. Continue the unfinished work, respecting the original reply requirements.",source:"system",trigger:"length_continuation",replySources:runtimeReplySources(inputs)},owed);
    }
    return;
  }
  const owner=runtimeInputOwner(chat,instance.memberId);
  if(!skipChatWarning&&!instance.hadErrorInTurn&&hasRuntimeReply(owner,inputs)){
    // A reply was owed but the turn ended without a chat call: nothing is
    // delivered — the debt is dismissed and the silence is made visible.
    dismissRuntimeReplies(inputs,"silent","member finished without replying");
    postMessage(chatTarget,"system",`Member "${instance.agentName}" finished without replying.`);
  }
}

let profileRevision = 0;

/** Publication after a committed DB identity update. Never resets an active handle. */
export function notifyMemberProfileChanged(member: MemberRecord): void {
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

function currentRuntimeName(memberId: string, initialName: string): string {
  if (!memberId.startsWith("mem_")) return initialName;
  const member = getMember(memberId);
  if (!member) throw new Error(`Member no longer exists: ${memberId}`);
  return member.name;
}

function refreshProfileSources(instance: AgentInstance): void {
  if (!instance.profilePromptDirty) return;
  const member = getMember(instance.memberId);
  if (!member) throw new Error(`Member no longer exists: ${instance.memberId}`);
  const ref = parseScopeId(instance.scopeId);
  const parentId = ref?.kind === "room" ? ref.roomId : undefined;
  const room = parentId ? roomStore.getRoom(parentId) : null;
  // ① batch 2: one prompt per member — the compiler takes no scope.
  const compiled = compileForMember(member.id);
  instance.agentName = member.name;
  instance.sessionSources.member.name = member.name;
  instance.sessionSources.member.title = member.title;
  instance.sessionSources.compiled = compiled;
  instance.sessionSources.roomMembers = room ? roomStore.getRoomMembers(room.id).map(m => m.name) : [member.name];
}

async function runInputBatch(instance:AgentInstance,inputs:QueuedInput[]):Promise<void>{
  if(!memberRuntimeAllowed(instance.memberId))return;
  const payloads=inputs.map(runtimeInputPayload),message=payloads.map(x=>x.prompt).join("\n\n");
  const trigger=payloads.length===1?payloads[0].trigger:"queued",token=randomUUID();
  // ① B1: this batch's chat — the instance serves it now; outbound calls follow it.
  const batchScope=inputs[0].scopeId;
  instance.activeChat.scopeId=batchScope;
  const batchTarget=chatTargetOf(batchScope);
  updateDispatchState(instance,"promptSubmitted",trigger);
  instance.promptInFlight=true;instance.hadErrorInTurn=false;instance.lastTurnError=null;instance.pendingErrorNotice=null;
  instance.lastMessageEndWasLength=false;instance.lengthContinuationPending=false;
  instance.lengthContinuationAttempted=payloads.some(payload=>payload.trigger==="length_continuation");
  let dispatched=false,outcome:"completed"|"failed"|"cancelled"="failed",failure:unknown;
  setActivationSource(batchTarget,instance.memberId,payloads[0].source);
  try{
    if(trigger!=="length_continuation")emitAgentLocalEvent(batchTarget,instance.memberId,{type:"user_prompt",text:message,trigger});
    if(instance.profilePromptDirty){
      refreshProfileSources(instance);
      if(!instance.handle.refreshPrompt)throw new Error("Runtime cannot refresh member identity without resetting the session.");
      instance.handle.refreshPrompt(instance.sessionSources.compiled);instance.profilePromptDirty=false;
    }
    await instance.handle.prompt(message,{beforeDispatch:(event:{attemptId:string;dispatchIndex:number;message:string})=>{
      if(!memberScopeAllowsExecution(batchScope,instance.memberId))throw new RuntimeScopeRevokedError();
      if(event.dispatchIndex===0){claimRuntimeInputs(inputs,event.attemptId,token);dispatched=true;}
      else{
        const continuation=acceptControlInput(batchScope,instance.memberId,{prompt:event.message,source:"system",trigger:"sdk-continuation",replySources:runtimeReplySources(inputs)},hasRuntimeReply(runtimeInputOwner(batchScope,instance.memberId),inputs)).input;
        claimRuntimeInputs([continuation],event.attemptId,token);inputs.push(continuation);
      }
    }});
    if(!dispatched)throw new Error("Runtime returned without a durable input dispatch receipt");
    outcome=instance.dispatchState==="aborting"?"cancelled":instance.hadErrorInTurn?"failed":"completed";
  }catch(error){
    if(error instanceof RuntimeScopeRevokedError){outcome="cancelled";instance.lastTurnError=null;}
    else{failure=error;outcome=instance.dispatchState==="aborting"?"cancelled":"failed";instance.hadErrorInTurn=true;instance.lastTurnError=formatRuntimeErrorMessage(error);}
  }
  instance.promptInFlight=false;
  // Provider settlement is not application publication. Publication failure cannot replay the input.
  try{finalizePromptSettlement(instance,inputs,`${trigger}_settled`,outcome!=="completed");}
  catch(error){failure=error;outcome="failed";instance.lastTurnError=formatRuntimeErrorMessage(error);updateDispatchState(instance,"idle",`${trigger}_publication_error`);}
  finally{finishRuntimeInputs(inputs,token,outcome,failure?"runtime operation or publication failed":outcome);clearActivationSource(batchTarget,instance.memberId);}
  if(failure){
    logger.error("agent","input processing failed",{memberId:instance.memberId,scopeId:batchScope,error:String(failure)});
    if(instances.get(instanceKey(instance.memberId))===instance)postMessage(batchTarget,"system",`Member "${instance.agentName}" error: ${formatRuntimeErrorMessage(failure)}`);
  }
  if(instances.get(instanceKey(instance.memberId))===instance&&!queueDepth(instance)&&!instance.compacting&&instance.status!=="idle")transition(instance,batchTarget,instance.agentName,"idle",`${trigger}_settled`);
}

function normalizeSwitchModelRef(model: string): string {
  return normalizeModelRef(model.trim());
}

/** Split "provider/model-id" — the provider segment used for the explicit
 * profile match (read-only; no export, no models.json write). */
function modelProviderOf(ref: string): string {
  return ref.includes("/") ? ref.split("/")[0] : "";
}

/** The SDK handle applies model and fixed-profile credentials together.
 * Binding validation is read-only (enabled profile + explicit provider
 * match); only after it passes do we export — the write refreshes THIS
 * instance's models.json so a newly created provider reaches the old
 * session's dir (runtime.refresh reads disk, and without this it would not
 * find the model). */
function applyModelSwitchToInstance(
  instance: AgentInstance,
  pending: { model: string; credentialId?: string },
  trigger: string,
): Promise<void> {
  if (!memberRuntimeAllowed(instance.memberId)) return Promise.resolve();
  return trackMemberOperation(instance.memberId,()=>applyModelSwitchToInstanceInternal(instance, pending, trigger));
}

async function applyModelSwitchToInstanceInternal(
  instance: AgentInstance,
  pending: { model: string; credentialId?: string },
  trigger: string,
): Promise<void> {
  const model = normalizeSwitchModelRef(pending.model);
  const profile = pending.credentialId ? getModelCredentialProfile(pending.credentialId) : null;
  if (!profile || !profile.enabled) {
    throw new Error(`No model credentials configured for ${model}`);
  }
  if (modelProviderOf(model) !== profile.providerSlug) {
    throw new Error(`Credential "${profile.name}" (${profile.providerSlug}) does not serve model ${model}`);
  }

  if (!instance.handle.setModel) throw new Error("Runtime does not support dynamic model switching");

  // Validation passed — apply-time export refreshes the instance's model
  // catalog (models.json) before setModel binds.
  const exported = exportPiConfigForMember({
    roomId: instance.roomId,
    memberName: instance.memberId,
    modelRef: model,
    credentialId: profile.id,
  });
  if (!exported) throw new Error(`No model credentials configured for ${model}`);

  await instance.handle.setModel(model, profile.id);

  if (instance.handle.runtimeParams) {
    instance.handle.runtimeParams.model = model;
    instance.handle.runtimeParams.credentialId = profile.id;
    instance.handle.runtimeParams.credentialName = profile.name;
  }
  instance.appliedModel = model;
  instance.appliedCredentialId = profile.id;
  logger.info("agent", "modelSwitchApplied", { member: instance.agentName, roomId: instance.roomId, model, trigger });
  const modelChat = chatTargetOf(instance.activeChat?.scopeId || instance.roomId);
  broadcastToRoom(modelChat, { type: "agent:status", roomId: modelChat, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: instance.status });
}

/** If the live instance drifted from the room binding, re-apply (or destroy so the next create is clean). */
function applyThinkingSwitchToInstance(instance: AgentInstance, pending: PendingThinkingSwitch, trigger: string): Promise<void> {
  if (!memberRuntimeAllowed(instance.memberId)) return Promise.resolve();
  return trackMemberOperation(instance.memberId,()=>applyThinkingSwitchToInstanceInternal(instance, pending, trigger));
}

async function applyThinkingSwitchToInstanceInternal(instance: AgentInstance, pending: PendingThinkingSwitch, trigger: string): Promise<void> {
  if (!instance.handle.setThinkingLevel) throw new Error("Runtime does not support dynamic thinking level switching");
  await instance.handle.setThinkingLevel(pending.thinkingLevel);
  if (instance.handle.runtimeParams) instance.handle.runtimeParams.thinkingLevel = pending.thinkingLevel;
  logger.info("agent", "thinkingSwitchApplied", { member: instance.agentName, roomId: instance.roomId, thinkingLevel: pending.thinkingLevel, trigger });
  const thinkingChat = chatTargetOf(instance.activeChat?.scopeId || instance.roomId);
  broadcastToRoom(thinkingChat, { type: "agent:status", roomId: thinkingChat, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: instance.status });
}

function applyPendingThinkingSwitch(instance: AgentInstance, trigger: string): void {
  const pending = instance.pendingThinkingSwitch;
  if (!pending) return;
  instance.pendingThinkingSwitch = undefined;
  applyThinkingSwitchToInstance(instance, pending, trigger).catch((err) => {
    logger.error("agent", "thinkingSwitchFailed", { member: instance.agentName, roomId: instance.roomId, error: String(err) });
    postMessage(chatTargetOf(instance.activeChat?.scopeId || instance.roomId), "system", `Failed to switch thinking level for "${instance.agentName}": ${err.message || String(err)}`);
  });
}

function instanceUsesCredentialProfile(instance: AgentInstance, profileId: string): boolean {
  return instance.appliedCredentialId === profileId;
}

function dropInstanceAfterCredentialUnavailable(instance: AgentInstance, reason: string): void {
  const key = instanceKey(instance.memberId);
  if (instances.get(key) === instance) instances.delete(key);
  contextUsageCache.delete(key);
  contextCompactionWarningCache.delete(key);
  try { instance.unsubscribe(); } catch {}
  try { instance.handle.destroy(); } catch {}
  instance.status = "inactive";
  updateDispatchState(instance, "idle", "credential_unavailable");
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: "inactive" });
  logger.warn("agent", "credentialRefreshUnavailable", { member: instance.agentName, roomId: instance.roomId, reason });
  postMessage(instance.roomId, "system", `Member "${instance.agentName}" model credential is no longer available. Update Settings → Model Credentials or choose another model before the next turn.`);
}

const CREDENTIAL_REFRESH_TIMEOUT_MS = 8_000;

function isTransientCredentialRefreshError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /timeout|timed out|network|econnrefused|enotfound|econnreset|fetch failed|aborted|socket|hang up|etimedout|ehostunreach|certificate|eai_again/.test(msg);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function applyCredentialRefreshToInstance(instance: AgentInstance, pending: PendingCredentialRefresh, trigger: string): Promise<void> {
  if (!memberRuntimeAllowed(instance.memberId)) return Promise.resolve();
  return trackMemberOperation(instance.memberId,()=>applyCredentialRefreshToInstanceInternal(instance, pending, trigger));
}

async function applyCredentialRefreshToInstanceInternal(instance: AgentInstance, pending: PendingCredentialRefresh, trigger: string): Promise<void> {
  try {
    const exported = exportPiConfigForMember({
      roomId: instance.roomId,
      memberName: instance.memberId,
      modelRef: instance.appliedModel,
      credentialId: instance.appliedCredentialId,
    });
    if (!exported) {
      dropInstanceAfterCredentialUnavailable(instance, `${pending.changeType}:${pending.profileId}:export-null`);
      return;
    }

    if (!instance.handle.refreshModelRegistry || !instance.handle.setModel) {
      dropInstanceAfterCredentialUnavailable(instance, `${pending.changeType}:${pending.profileId}:runtime-refresh-unsupported`);
      return;
    }

    await withTimeout(
      // Credential profile changed locally — reload disk registry only; never hang on network.
      Promise.resolve(instance.handle.refreshModelRegistry({ allowNetwork: false })),
      CREDENTIAL_REFRESH_TIMEOUT_MS,
      "credential registry refresh",
    );
    await instance.handle.setModel(instance.appliedModel, instance.appliedCredentialId!);
    if (instance.handle.runtimeParams) {
      instance.handle.runtimeParams.model = instance.appliedModel;
      instance.handle.runtimeParams.credentialId = exported.profile?.id || instance.appliedCredentialId;
      instance.handle.runtimeParams.credentialName = exported.profile?.name;
    }
    instance.appliedCredentialId = exported.profile?.id || instance.appliedCredentialId;
    logger.info("agent", "credentialRefreshApplied", { member: instance.agentName, roomId: instance.roomId, profileId: pending.profileId, providerSlug: pending.providerSlug, trigger });
  } catch (err) {
    // Profile gone / export empty already dropped above. Network/timeouts must NOT
    // destroy the live instance or cry "credential no longer available".
    if (pending.changeType !== "profileDeleted" && isTransientCredentialRefreshError(err)) {
      logger.warn("agent", "credentialRefreshTransient", {
        member: instance.agentName,
        roomId: instance.roomId,
        profileId: pending.profileId,
        error: err instanceof Error ? err.message : String(err),
        trigger,
      });
      return;
    }
    dropInstanceAfterCredentialUnavailable(instance, `${pending.changeType}:${pending.profileId}:${err instanceof Error ? err.message : String(err)}`);
  }
}

function applyPendingCredentialRefresh(instance: AgentInstance, trigger: string): void {
  const pending = instance.pendingCredentialRefresh;
  if (!pending) return;
  instance.pendingCredentialRefresh = undefined;
  applyCredentialRefreshToInstance(instance, pending, trigger).catch((err) => {
    logger.error("agent", "credentialRefreshFailed", { member: instance.agentName, roomId: instance.roomId, error: String(err) });
    postMessage(instance.roomId, "system", `Failed to refresh model credential for "${instance.agentName}": ${err.message || String(err)}`);
  });
}

/**
 * Disk-only model registry refresh for every live instance (catalog models-store
 * distribute path). Failures are logged per-instance and never thrown.
 */
export async function refreshAllInstanceModelRegistries(): Promise<{ refreshed: number; failed: number }> {
  let refreshed = 0;
  let failed = 0;
  await Promise.all(Array.from(instances.values()).map(async (instance) => {
    if (!instance.handle.refreshModelRegistry) return;
    try {
      await withTimeout(
        Promise.resolve(instance.handle.refreshModelRegistry({ allowNetwork: false })),
        CREDENTIAL_REFRESH_TIMEOUT_MS,
        "catalog models-store registry refresh",
      );
      refreshed += 1;
    } catch (err) {
      failed += 1;
      logger.warn("agent", "catalogRegistryRefreshFailed", {
        member: instance.agentName,
        roomId: instance.roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));
  return { refreshed, failed };
}

export async function invalidateModelCredentialProfile(profileId: string, providerSlug: string, changeType: PendingCredentialRefresh["changeType"] = "profileUpdated"): Promise<Array<{ roomId: string; memberName: string; applied: boolean; pending: boolean }>> {
  const pending = { profileId, providerSlug, changeType };
  const targets = Array.from(instances.values()).filter((instance) => instanceUsesCredentialProfile(instance, profileId));

  // profileDeleted must still be applied synchronously so callers know instances dropped.
  // profileUpdated is best-effort background refresh — Settings save must return immediately.
  if (changeType === "profileUpdated") {
    for (const instance of targets) {
      if (instance.status === "working" || instance.dispatchState !== "idle") {
        instance.pendingCredentialRefresh = pending;
        logger.info("agent", "credentialRefreshQueued", { member: instance.agentName, roomId: instance.roomId, profileId, providerSlug, status: instance.status, dispatchState: instance.dispatchState });
        continue;
      }
      // Fire-and-forget; errors handled inside applyCredentialRefreshToInstance.
      void applyCredentialRefreshToInstance(instance, pending, "credentialProfileInvalidated").catch((err) => {
        logger.error("agent", "credentialRefreshFailed", { member: instance.agentName, roomId: instance.roomId, error: String(err) });
      });
    }
    return targets.map((instance) => ({
      roomId: instance.roomId,
      memberName: instance.agentName,
      applied: false,
      pending: true,
    }));
  }

  const results: Array<{ roomId: string; memberName: string; applied: boolean; pending: boolean }> = [];
  // Concurrent refresh (no serial await chain).
  await Promise.all(targets.map(async (instance) => {
    if (instance.status === "working" || instance.dispatchState !== "idle") {
      instance.pendingCredentialRefresh = pending;
      logger.info("agent", "credentialRefreshQueued", { member: instance.agentName, roomId: instance.roomId, profileId, providerSlug, status: instance.status, dispatchState: instance.dispatchState });
      results.push({ roomId: instance.roomId, memberName: instance.agentName, applied: false, pending: true });
      return;
    }
    try {
      await applyCredentialRefreshToInstance(instance, pending, "credentialProfileInvalidated");
      results.push({ roomId: instance.roomId, memberName: instance.agentName, applied: true, pending: false });
    } catch (err: any) {
      logger.error("agent", "credentialRefreshFailed", { member: instance.agentName, roomId: instance.roomId, error: String(err) });
      postMessage(instance.roomId, "system", `Failed to refresh model credential for "${instance.agentName}": ${err.message || String(err)}`);
      results.push({ roomId: instance.roomId, memberName: instance.agentName, applied: false, pending: false });
    }
  }));
  return results;
}

// -- Format messages --

function renderMessageForAgent(roomId: string, msg: RoomMessage): RoomMessage {
  if (!msg.attachments?.length) return msg;
  const lines: string[] = [];
  for (const attachment of msg.attachments) {
    try {
      const absPath = attachmentStore.getAttachmentPath(roomId, attachment.storedFilename);
      lines.push(`Attachment: [original filename: ${attachment.originalFilename}](${absPath})`);
    } catch {
      lines.push(`Attachment: [original filename: ${attachment.originalFilename}](unavailable)`);
    }
  }
  const content = msg.content?.trim() ? `${msg.content}\n${lines.join("\n")}` : lines.join("\n");
  return { ...msg, content };
}

function formatMessagesForAgent(roomId: string, messages: RoomMessage[], receiver: string, roomName: string): string {
  if (messages.length === 0) return "";

  const items = messages.map((raw) => {
    const m = renderMessageForAgent(roomId, raw);
    return { msg: m, role: resolveSenderRole(m.sender) as SenderRole };
  });

  // Resolve replyTo targets from the full scope so quotes work even when the
  // original is outside the current activation window (plan-reply-to-v1 §3).
  let scopeById: Map<string, RoomMessage> | null = null;
  const lookup = (ref: { seq: number; messageId: string }): RoomMessage | undefined => {
    if (!scopeById) {
      try {
        const all = loadScopeMessages(roomId);
        scopeById = new Map(all.filter(m=>!isSystemNoticeHiddenFromMembers(m)).map((m) => [m.id, m]));
      } catch {
        scopeById = new Map();
      }
    }
    return scopeById.get(ref.messageId);
  };

  // Single message → single-message envelope.
  if (items.length === 1) {
    return wrapRoomContextMessage(items[0].msg, { kind: "room", id: roomId, name: roomName }, items[0].role, lookup);
  }

  // Multiple messages → shared transcript envelope (each message keeps its own
  // full sub-header with seq + timestamp so it can be referenced individually).
  return wrapRoomMessagesTranscript(
    items.map((i) => ({ msg: i.msg, role: i.role })),
    { kind: "room", id: roomId, name: roomName },
    lookup,
  );
}

// Only current member configuration selects skills, including an explicit empty list.
export function resolveSkills(member: AgentMemberConfig): string[] {
  return member.skills ?? [];
}

// -- Instance creation --

// ── Unified member session builder (batch 6 §2) ──
// Single assembly path for every member session — compiled prompt
// (scope-mirrored args), skills, extensions, MCP scoped config, cwd, model —
// consumed by all four lifecycle points: initial activation (auto-resume),
// reset (store cleared first, so fresh), reload (resume, history kept),
// post-compaction (resume from the compacted file).

export interface BuildSessionOpts {
  /** true = honor any stored session file (reload/compact paths); default auto. */
  resume?: boolean;
}

export async function buildMemberAgentSession(memberId: string, scopeId: string, _opts: BuildSessionOpts = {}): Promise<AgentInstance | null> {
  if (!memberRuntimeAllowed(memberId)) return null;
  const creationProfileRevision = profileRevision;
  const mmScope = isMmScopeId(scopeId);
  const ref = parseScopeId(scopeId);
  if (!ref && !mmScope) {
    logger.error("agent", "buildMemberAgentSession: invalid scope", { scopeId, memberId });
    return null;
  }
  const key = instanceKey(memberId);
  // §10 creation gate: an in-progress member switch must not race a fresh
  // build (stale binding the switch will never see). Wait for the switch to
  // end, then re-run the whole lookup. Never register a creation while the
  // gate is held — the switch awaits pending creations, so a registered
  // waiter would deadlock both sides. No timeout: the switch always settles.
  for (;;) {
    if (!memberScopeAllowsExecution(scopeId, memberId)) return null;
    const existing = instances.get(key);
    if (existing) return existing;
    const pending = pendingCreations.get(key);
    if (pending) {
      const retryAfterCancellation = cancelledCreations.has(key);
      const built = await pending;
      if (retryAfterCancellation) continue;
      return memberScopeAllowsExecution(scopeId, memberId) ? built : null;
    }
    const gate = memberSwitchGates.get(memberId);
    if (gate) {
      await gate;
      continue;
    }
    break;
  }

  const publicationOwner = {};
  sessionPublishOwners.set(key,publicationOwner);
  // Closing execution admission must not discard final session facts from an owned
  // run — publish as long as this build's chat access holds (① B1: the key is the
  // member, the access check stays the build chat's).
  const canPublishSession = () => sessionPublishOwners.get(key) === publicationOwner
    && memberHasScopeAccess(scopeId, memberId);
  const creation = (async (): Promise<AgentInstance | null> => {
    if (!registry) {
      logger.error("agent", "runtime registry not initialized");
      return null;
    }

    const member = memberRecordToConfig(memberId);
    if (!member) {
      logger.error("agent", "member not found", { memberId });
      return null;
    }
    if (!isMemberConfigured(member)) {
      logger.error("agent", "member unconfigured", { member: member.name, memberId });
      return null;
    }
    const runtime = registry.get(member.runtime);
    if (!runtime) {
      logger.error("agent", "runtime not found", { member: member.name, runtime: member.runtime });
      return null;
    }
    const compiled = compileForMember(memberId);
    setContractFingerprint(memberId, compiled.contractFingerprint, MEMBER_CONTRACT_VERSION);
    clearStaleMounts(memberId);
    const skills = resolveSkills(member);
    const skillPaths = resolveGlobalSkillPaths(skills);
    const cwd = activeWorkspaceRoot(memberId);
    const sessionDir = mainSessionDirectory(memberId);
    const savedSession = sessionStore.getCurrentSession(memberId);
    const resumeSession = savedSession ? { sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile } : undefined;
    const onSessionChanged = (session: { sessionId?: string; sessionFile?: string }) => {
      if (canPublishSession()) sessionStore.saveCurrentSession(memberId, { runtime: member.runtime, ...session });
    };

    // Conversation routing is turn-local; it never selects member assets or a session directory.
    const activeChat = { scopeId };
    const chatTarget = () => chatTargetOf(activeChat.scopeId);
    const memberName = () => currentRuntimeName(memberId, member.name);
    const keyRoomId = chatTargetOf(scopeId);
    const roomMembers = ref?.kind === "room" ? roomStore.getRoom(ref.roomId)?.members ?? [] : [member.name];
    const callbacks = {
      onChat: async (message: string) => {
        postMessage(chatTarget(), memberName(), message, [], { senderMemberId: memberId });
      },
      onMention: async (targetMember: string, message: string) => {
        const current = parseScopeId(activeChat.scopeId);
        const target = current?.kind === "room" ? roomStore.resolveRoomMemberRef(current.roomId, targetMember) : null;
        postMessage(chatTarget(), memberName(), message, current?.kind === "room" ? [targetMember] : [], {
          senderMemberId: memberId, ...(current?.kind === "room" ? { mentionMemberIds: target ? [target.id] : [] } : {}),
        });
      },
    };

    try {
      const handle = await runtime.createAgent({
        cwd,
        roomId: keyRoomId,
        resolveChatId: () => activeChat.scopeId,
        member,
        agentPrompt: compiled.agentPrompt,
        envPrompt: compiled.envPrompt,
        appendSystemPrompt: compiled.appendSystemPrompt,
        skillPaths,
        skillNames: skills,
        roomMembers,
        resumeSession,
        sessionDir,
        onSessionChanged,
        callbacks,
      });

      if (!canPublishSession() || !memberRuntimeAllowed(memberId)) {
        if (!handle.destroyAndWait) throw new Error("Runtime cannot confirm rejected builder cleanup");
        await handle.destroyAndWait();
        return null;
      }
      logger.info("agent", "memberAgentCreated", { member: member.name, agent: member.agent, runtime: member.runtime, scopeId });

      const instance: AgentInstance = {
        handle,
        /** ① B1: the chat whose turn is being processed right now. */
        activeChat,
        /** Build-time chat scope: source of cwd/session/roster material only.
         *  Outbound traffic reads activeChat; never route from this field. */
        scopeId,
        roomId: keyRoomId,
        memberId,
        agentName: currentRuntimeName(memberId, member.name),
        profilePromptDirty: memberId.startsWith("mem_") && creationProfileRevision !== profileRevision,
        sourceAgent: member.agent,
        status: "idle",
        dispatchState: "idle",
        promptInFlight: false,
        hadErrorInTurn: false,
        lastTurnError: null,
        pendingErrorNotice: null,
        lastMessageEndWasLength: false,
        lengthContinuationPending: false,
        lengthContinuationAttempted: false,
        compacting: false,
        turnActive: false,
        sessionSources: {
          member: { ...member },
          compiled: {
            agentPrompt: compiled.agentPrompt,
            envPrompt: compiled.envPrompt,
            appendSystemPrompt: [...compiled.appendSystemPrompt],
          },
          skills,
          skillPaths: [...skillPaths],
          cwd,
          roomMembers: [...roomMembers],
          runtimeName: member.runtime,
        },
        unsubscribe: () => {},
        eventBuffer: [],
        appliedModel: member.model ? normalizeSwitchModelRef(member.model) : "",
        appliedCredentialId: member.credentialId,
        pendingReload: null,
      };

      wireInstanceEvents(instance, key, keyRoomId, memberId);

      instances.set(key, instance);
      return instance;
    } catch (err: any) {
      logger.error("agent", "failed to create member agent", { member: member.name, agent: member.agent, runtime: member.runtime, error: formatRuntimeErrorMessage(err) });
      postMessage(keyRoomId, "system", `Failed to create member "${member.name}": ${formatRuntimeErrorMessage(err)}`);
      return null;
    }
  })();

  pendingCreations.set(key, creation);
  try {
    return await creation;
  } finally {
    if (pendingCreations.get(key) === creation) { pendingCreations.delete(key); cancelledCreations.delete(key); }
    if (!instances.has(key) && sessionPublishOwners.get(key) === publicationOwner) sessionPublishOwners.delete(key);
  }
}

/** Batch 6 §3: rebuild a live member session with fresh assets, keeping the
 * session files (conversation history). Queued until the current run settles. */
export async function reloadMemberSession(scopeId: string, memberId: string, reason: string): Promise<{ queued: boolean; rebuilt: boolean }> {
  const key = instanceKey(memberId);
  const instance = instances.get(key);
  if (!instance) {
    // Nothing live — plain activation semantics (resume if a file exists).
    const built = await buildMemberAgentSession(memberId, scopeId);
    return { queued: false, rebuilt: !!built };
  }
  if (instance.status === "working" || instance.compacting || instance.dispatchState !== "idle" || instance.promptInFlight || queueDepth(instance)>0) {
    instance.pendingReload = reason;
    logger.info("agent", "reloadQueued", { memberId, scopeId, reason });
    return { queued: true, rebuilt: false };
  }
  await rebuildLiveInstance(instance, reason);
  return { queued: false, rebuilt: true };
}

function rebuildLiveInstance(instance: AgentInstance, reason: string): Promise<AgentInstance | null> {
  if (!memberRuntimeAllowed(instance.memberId)) return Promise.resolve(null);
  return trackMemberOperation(instance.memberId,()=>rebuildLiveInstanceInternal(instance, reason));
}

async function rebuildLiveInstanceInternal(instance: AgentInstance, reason: string): Promise<AgentInstance | null> {
  const scopeId = instance.scopeId;
  const memberId = instance.memberId;
  updateDispatchState(instance,"aborting","session-reload");
  if(!instance.handle.destroyAndWait)throw new Error("Runtime cannot confirm reload teardown");
  await instance.handle.destroyAndWait();
  if(instances.get(instanceKey(memberId))!==instance||!memberRuntimeAllowed(memberId))return null;
  instance.unsubscribe();
  instances.delete(instanceKey(memberId));
  sessionPublishOwners.delete(instanceKey(memberId));
  // Session files are kept — reload means same conversation, fresh assets.
  const built = await buildMemberAgentSession(memberId, scopeId, { resume: true });
  if(built)drainQueuedInputsAsPrompt(built,"session-reloaded");
  logger.info("agent", "sessionReloaded", { memberId, scopeId, reason, rebuilt: !!built });
  return built;
}

/** Flush a reload requested mid-run once the member is fully settled and
 * nothing is queued (queued prompts are delivered first; the rebuild waits for
 * the next settlement). */
function maybeFlushPendingReload(instance: AgentInstance): void {
  if (!instance.pendingReload) return;
  if (instance.status !== "idle" || instance.compacting || instance.turnActive || instance.dispatchState !== "idle" || instance.promptInFlight) return;
  if (queueDepth(instance) > 0) return;
  const reason = instance.pendingReload;
  instance.pendingReload = null;
  const key = instanceKey(instance.memberId);
  // Escape the current event handler before destroying the instance.
  setTimeout(() => {
    if (instances.get(key) !== instance) return; // replaced/destroyed meanwhile
    void reloadMemberSession(instance.scopeId,instance.memberId,reason).catch((err) =>
      logger.error("agent", "pendingReload failed", { memberId: instance.memberId, scopeId: instance.scopeId, error: String(err) }),
    );
  }, 0);
}

async function getOrCreate(roomId: string, memberRef: string): Promise<AgentInstance | null> {
  const room = roomStore.getRoom(roomId);
  if (!room) {
    logger.error("agent", "room not found", { roomId });
    return null;
  }
  const resolved = resolveRoomMember(roomId, memberRef);
  if (!resolved) {
    logger.error("agent", "no member or agent definition found", { name: memberRef, roomId });
    return null;
  }
  return buildMemberAgentSession(resolved.id, roomScopeId(roomId));
}

// -- Activation --

type ReplyContext = { needResponse?: string[]; needResponseMemberIds?: string[]; senderName?: string; senderOrigin?: "user"|"member"|"system"|"unresolved" };

function replyObligation(memberId: string, memberName: string, ctx?: ReplyContext) {
  const isUser = ctx?.senderOrigin !== undefined ? ctx.senderOrigin === "user" : ctx?.senderName === "user";
  const listed = ctx?.needResponseMemberIds !== undefined
    ? ctx.needResponseMemberIds.includes(memberId)
    : (ctx?.needResponse || []).some(name => name === memberName || name === memberId);
  const explicitFyi = isUser && Array.isArray(ctx?.needResponse) && ctx.needResponse.length === 0;
  const replyDebt = !explicitFyi && (isUser || !ctx || listed);
  const banner = replyDebt ? (isUser || !ctx
    ? "[REPLY EXPECTED] Respond using the chat tool."
    : `[REPLY EXPECTED] ${ctx.senderName} expects your reply — respond with the chat tool.`) : undefined;
  return { replyDebt, banner };
}

const INTERRUPT_INPUT_BANNER="Your previous turn was interrupted by this message. Commands in terminals keep running. Check terminal_list for running commands and use terminal_wait to collect their results before continuing dependent work.";

function prepareScopeInput(scopeValue:string,memberId:string,ctx?:ReplyContext,capture?:CapturedMessage):{payload:PreparedRuntimeInput;replyExpected:boolean;onAccepted?:()=>void}|null{
  const scope=runtimeInputOwner(scopeValue,memberId).scopeId;
  const rec=getMember(memberId);if(!rec)throw new Error(`Member not found: ${memberId}`);
  const replyExpected=capture
    ?new ReplyObligationRepository(getDatabase()).listPending(scope,memberId).some(x=>x.messageId===capture.messageId)
    :replyObligation(memberId,rec.name,ctx).replyDebt;
  const senderName=capture?.snapshot.origin==="member"?String(capture.snapshot.message.sender):ctx?.senderName;
  const senderIsMember=capture?capture.snapshot.origin==="member":!!ctx&&ctx.senderOrigin!=="user"&&ctx.senderName!=="user";
  const banner=replyExpected?(senderIsMember&&senderName?`[REPLY EXPECTED] ${senderName} expects your reply — respond with the chat tool.`:"[REPLY EXPECTED] Respond using the chat tool."):undefined;
  const captured=capture?.snapshot.message as unknown as RoomMessage|undefined;
  if(scope.startsWith("dm:")){
    const all=readAllDmMessages(memberId).filter(m=>!isSystemNoticeHiddenFromMembers(m));
    // Private messages are delivered to this member immediately; the turn carries only the
    // target message itself. Earlier history stays available through chat_read.
    const target=captured??all.at(-1);
    // ① D1: every delivered message carries its source chat id and sender id;
    // this private chat is `dm:<memberId>`.
    const dmLabel=`dm:${memberId}`;
    const delivered=target?(target.sender==="user"?`[User] ${target.content}`:`[Member \`${target.sender}\`${target.senderMemberId?` (${target.senderMemberId})`:''}] ${target.content}`):undefined;
    let prompt:string;
    if(delivered)prompt=`You are in a private chat with the user (${dmLabel}). New message:\n\n${delivered}${replyExpected?"\n\nRespond to the latest user message with the chat tool.":""}`;
    else if(isBlankPersona(readMemberProfile(memberId)))prompt=`You are in a private chat with the user (${dmLabel}). You just came online with a blank persona (your persona.md body is empty). Your first action must be a chat call: introduce yourself by name in one short line, say you are starting from a blank slate, and ask what they want you around for. Do not call other tools first. After they answer, write what you learned in persona.md as free-form Markdown. No frontmatter or particular headings are required.`;
    else prompt=`You are in a private chat with the user (${dmLabel}). They just opened the conversation. Greet briefly with the chat tool, or wait for their request.`;
    return {payload:{prompt:[banner,prompt].filter(Boolean).join("\n\n"),source:"private_instruction",trigger:"dm-activate"},replyExpected};
  }
  if(scope.startsWith("mm:")){
    // ⑤ B: member↔member private chat — mirror the DM delivery-only path for the peer.
    const pair=parseMmScopeId(scope);
    if(!pair||!pair.includes(memberId))throw new Error(`Member chat scope does not include member ${memberId}`);
    const otherId=pair.find(id=>id!==memberId)!;
    const otherName=getMember(otherId)?.name??otherId;
    const all=loadScopeMessages(scope).filter(m=>!isSystemNoticeHiddenFromMembers(m));
    const target=captured??all.at(-1);
    const delivered=target?`[Member \`${target.sender}\`${target.senderMemberId?` (${target.senderMemberId})`:''}] ${target.content}`:undefined;
    let prompt:string;
    if(delivered)prompt=`You are in a private chat with member \`${otherName}\` (${scope}). New message:\n\n${delivered}${replyExpected?"\n\nRespond to the latest message with the chat tool.":""}`;
    else prompt=`You are in a private chat with member \`${otherName}\` (${scope}). They just opened it — reply with the chat tool, or wait for their next message.`;
    return {payload:{prompt:[banner,prompt].filter(Boolean).join("\n\n"),source:"private_instruction",trigger:"mm-activate"},replyExpected};
  }
  const parent=scope;
  const room=roomStore.getRoom(parent);if(!room)throw new Error("Room not found");
  const member=resolveRoomMember(parent,memberId);if(!member)throw new Error("Member is not in the room");
  const cursor=roomStore.getCursors(parent)[memberId];
  const all=getMessagesSince(parent,cursor??null);
  const visible=filterAgentVisibleMessages(all,rec.name);
  const index=lastMentionTriggerIndex(visible,rec.name,memberId);
  const trigger=captured??visible[index>=0?index:visible.length-1];
  if(!trigger)return null;
  let formatted=trigger?formatMessagesForAgent(scope,[trigger],rec.name,room.name):"";
  if(trigger){
    const backlog=visible.filter(m=>m.id!==trigger.id&&(m.seq??0)<(trigger.seq??Number.MAX_SAFE_INTEGER)&&!isOwnMessage(m,memberId,rec.name));
    const limit=(member as any).contextLimit||50;
    const hint=buildUnreadBacklogHint(backlog.slice(-limit),backlog.length>limit?{total:backlog.length,fromSeq:(backlog[0].seq??1)-1}:undefined);
    if(hint)formatted=`${hint}\n\n${formatted}`;
  }
  return {payload:{prompt:[banner,formatted].filter(Boolean).join("\n\n"),source:"room_mention",trigger:"activate"},replyExpected,onAccepted:()=>{
    if(trigger?.id){
      const current=roomStore.getCursors(parent)[memberId];
      const currentMessage=current?loadScopeMessages(scope).find(m=>m.id===current):undefined;
      if(!currentMessage||(currentMessage.seq??0)<=(trigger.seq??Number.MAX_SAFE_INTEGER)){
        roomStore.setCursor(parent,memberId,trigger.id);
      }
    }
  }};
}

/** Admission is synchronous. The outbox may acknowledge only after this returns. */
function admitCapturedActivation(scopeValue:string,memberId:string,ctx:MentionActivationCtx):void{
  const scope=runtimeInputOwner(scopeValue,memberId).scopeId;
  const active=instances.get(instanceKey(memberId));
  const busy=!!active&&(active.status==="working"||active.dispatchState!=="idle");
  const target=ctx.capture.snapshot.targets[ctx.deliveryKind].find(actor=>actor.actorKey===memberId);
  const scopeAllowed=memberHasScopeAccess(scope,memberId);
  const unavailable=target?.memberId!==memberId||!scopeAllowed||!memberRuntimeAllowed(memberId)||!getMember(memberId);
  // ① B3: @everyone reaches everyone — a busy member is interrupted and
  // re-delivered just like any other message, never skipped.
  const skipped=unavailable;
  let prepared:ReturnType<typeof prepareScopeInput>;
  const receipt=acceptRuntimeInput(ctx.capture,{scopeId:scope,messageId:ctx.capture.messageId,targetActorKey:memberId,deliveryKind:ctx.deliveryKind},()=>{
    if(skipped)return {prompt:"",source:"system",trigger:"not-dispatched"};
    prepared=prepareScopeInput(scope,memberId,ctx,ctx.capture);
    if(!prepared)throw new Error("Captured message has no executable input");
    const payload={...prepared.payload};
    if(busy&&!active!.compacting)payload.prompt=`${INTERRUPT_INPUT_BANNER}\n\n${payload.prompt}`;
    return payload;
  },{placement:(busy&&!active?.compacting)?"front":"tail",onAccepted:()=>prepared?.onAccepted?.(),...(skipped?{skip:{diagnosis:"member unavailable",disposition:"cancelled" as ReplyDisposition}}:{})});
  if(receipt.input.status!=="pending"){
    return;
  }
  if(receipt.accepted&&busy&&!active!.compacting){
    interruptAcceptedInput(scope,active!,"message_interrupt");
  }
  void pumpRuntimeInputs(scope,memberId).catch(error=>logger.error("router","accepted input execution failed",{scopeId:scope,memberId,error:String(error)}));
}

async function activateControl(scope:string,memberId:string,ctx?:ReplyContext):Promise<void>{
  if(!memberRuntimeAllowed(memberId))return;
  const prepared=prepareScopeInput(scope,memberId,ctx);
  if(!prepared){
    await buildMemberAgentSession(memberId,(scope.startsWith("dm:")||isMmScopeId(scope)?scope:roomScopeId(scope)) as ScopeId);
    return;
  }
  const active=instances.get(instanceKey(memberId));
  const busy=!!active&&(active.status==="working"||active.dispatchState!=="idle");
  if(busy&&!active!.compacting)prepared.payload.prompt=`${INTERRUPT_INPUT_BANNER}\n\n${prepared.payload.prompt}`;
  const {input}=acceptControlInput(scope,memberId,prepared.payload,prepared.replyExpected,busy?"front":"tail",prepared.onAccepted);
  if(busy&&!active!.compacting)interruptAcceptedInput(scope,active!,"message_interrupt");
  const running=pumpRuntimeInputs(scope,memberId);
  if(!busy&&!active?.compacting)await waitForInputSettlement(input,running);else void running.catch(error=>logger.error("agent","control input failed",{memberId,error:String(error)}));
}
export async function activateAgent(roomId:string,memberRef:string,ctx?:ReplyContext):Promise<void>{
  const member=resolveRoomMember(roomId,memberRef);if(!member)return;
  return activateControl(roomId,member.id,ctx);
}

// -- Model switching --

/**
 * Persist a model binding to the 0.20 authority — the member registry (F4,
 * 2026-08-04). Batch-5b: config is always the member's global binding
 * (unified flags retired). The pre-0.20 room.json memberOverrides write was
 * invisible to every read side (display / effective-config / activate-heal),
 * which produced "switch works once, display shows old, heal silently rolls
 * back". Legacy non-mem_ rooms still persist to memberOverrides — that is the
 * only authority their read side (name-keyed overrides) consults.
 */
export interface RoomMemberConfigPatch {
  mcpServers?: string[] | null;
  skills?: string[] | null;
}

/**
 * Persist a room-member config patch to the 0.20 authority — the member
 * registry (F4, 2026-08-04). Batch-5b: all fields write global (scope
 * overrides retired). The pre-0.20 room.json memberOverrides write is invisible to every read
 * side for mem_* members (display / effective-config / activate-heal) —
 * "applies once, display stale, heal rolls back". Legacy non-mem_ rooms
 * keep memberOverrides (the only authority their read side consults).
 */
function persistConfigPatch(roomId: string, memberId: string, patch: RoomMemberConfigPatch): void {
  if (memberId.startsWith("mem_")) {
    try {
      applyMemberConfigPatch(memberId, patch as Record<string, unknown>);
    } catch (err) {
      logger.error("agent", "persistConfigPatch: member not in registry", { memberId, roomId, error: String(err) });
    }
    return;
  }
  roomStore.updateRoomMemberOverride(roomId, memberId, patch);
}

/** Persist a config patch for a room member (resolves ref → member id, routes by authority). */
export function persistRoomMemberConfigPatch(roomId: string, memberRef: string, patch: RoomMemberConfigPatch): void {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  persistConfigPatch(roomId, memberId, patch);
}

/** Clear a member's model binding on the same authority as persistConfigPatch. */
/**
 * Scope labels for the DM Core prompt's "Scopes you exist in" line (flagship
 * ①): rooms the member belongs to + this DM. Previously the DM compile call
 * passed [scopeId] only — the line showed just the DM itself, leaving DM
 * members room-blind (fish 2026-08-05).
 */
export function buildDmScopeLabels(memberId: string, dmScopeId: string): string[] {
  return [
    ...listRoomsForMember(memberId).map((r) => `${r.name} (room:${r.id})`),
    `this DM (${dmScopeId})`,
  ];
}

/** §10: in-flight model switches per memberId — ONE map with the creation
 * gate (memberSwitchGates). Acquired synchronously before the first await; a
 * second concurrent request gets MemberModelSwitchConflictError (HTTP 409). */

/** Thrown when another switch is already running for the member — mapped to
 * HTTP 409 by the API layer. */
export class MemberModelSwitchConflictError extends Error {
  constructor(memberId: string) {
    super(`A model switch is already in progress for this member (${memberId}) — retry when it finishes.`);
    this.name = "MemberModelSwitchConflictError";
  }
}

export interface MemberModelSwitchResult {
  model: string;
  credentialId: string;
  instances: Array<{ scopeId: string; applied: boolean }>;
}

/** §10: restore every attempted instance (including the one whose setModel
 * threw — the SDK may have assigned its state.model before failing) to the
 * binding it ran before the switch. A rollback that fails stops that exact
 * scope's instance (history preserved) and reports its scopeId. */
async function rollbackSwitchedInstances(
  attempted: AgentInstance[],
  originals: Map<AgentInstance, { model?: string; credentialId?: string }>,
  trigger: string,
): Promise<string[]> {
  const failedScopes: string[] = [];
  for (const inst of attempted) {
    const original = originals.get(inst);
    if (!original) continue;
    const stillCurrent = instances.get(instanceKey(inst.memberId)) === inst;
    if (!stillCurrent) continue;
    if (!original.model || !original.credentialId) {
      destroyInstance(inst.scopeId, inst.memberId);
      failedScopes.push(inst.scopeId);
      continue;
    }
    try {
      await applyModelSwitchToInstance(inst, { model: original.model, credentialId: original.credentialId }, trigger);
    } catch (err) {
      logger.error("agent", "modelSwitchRollbackFailed", {
        member: inst.agentName,
        scopeId: inst.scopeId,
        error: String(err),
        trigger,
      });
      destroyInstance(inst.scopeId, inst.memberId);
      failedScopes.push(inst.scopeId);
    }
  }
  return failedScopes;
}

/**
 * The ONE model switch method (design-model-switch-single-path-v1 §3, §10),
 * keyed by memberId: acquire the member lock synchronously → let already-
 * pending creations finish → validate the complete target binding → apply to
 * every live instance (room + DM, idle and working) via the SDK's
 * setModel(model, credentialId) → save the global config exactly once. Any
 * failure (an instance rejecting the switch, or the config save) rolls every
 * attempted instance back through the single rollback path above; the config
 * is only written after all instances accepted the switch. New creations wait
 * at their gate for the switch to end, so there is no latecomer path.
 */
export async function switchMemberModel(memberId: string, binding: { model: string; credentialId: string }): Promise<MemberModelSwitchResult> {
  // Synchronous acquisition, before the first await (§10): two callers cannot
  // both pass the check across an await boundary. The same map entry is the
  // creation gate — it resolves only when this switch fully settles.
  if (memberSwitchGates.has(memberId)) throw new MemberModelSwitchConflictError(memberId);
  let releaseGate: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  memberSwitchGates.set(memberId, gate);
  try {
    const normalizedModel = normalizeSwitchModelRef(binding.model);
    if (!normalizedModel) throw new Error("model is required");
    assertModelAvailable(normalizedModel, "switchMemberModel");
    const { getModelCredentialProfile } = await import("../../config/models.js");
    const profile = getModelCredentialProfile(binding.credentialId);
    if (!profile || !profile.enabled) {
      throw new Error(`Credential profile not found or disabled: ${binding.credentialId}`);
    }
    // Read-only binding validation (§10): the ref's provider must explicitly
    // match the profile's providerSlug. No export probe — that would write
    // models.json and still not prove the provider match.
    if (modelProviderOf(normalizedModel) !== profile.providerSlug) {
      throw new Error(`Credential "${profile.name}" (${profile.providerSlug}) does not serve model ${normalizedModel}`);
    }

    // §10: let creations that were already in flight finish before the
    // snapshot, so the switch sees every instance that exists. No timeout —
    // a partial snapshot could miss an instance. (Creations that arrive
    // after the lock are gated above, not here.)
    const pending = pendingCreationsFor(memberId);
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    const targets = [...instances.values()].filter((inst) => inst.memberId === memberId);
    const originals = new Map(targets.map((inst) => [inst, { model: inst.appliedModel, credentialId: inst.appliedCredentialId }]));
    const attempted: AgentInstance[] = [];
    try {
      for (const inst of targets) {
        // Registered BEFORE the call: an instance whose setModel throws is
        // still attempted — the SDK may have assigned state.model already.
        attempted.push(inst);
        await applyModelSwitchToInstance(inst, { model: normalizedModel, credentialId: binding.credentialId }, "switchMemberModel");
      }
    } catch (err) {
      const failedAt = attempted[attempted.length - 1]?.scopeId ?? "unknown scope";
      const reason = String((err as Error)?.message || err);
      const failedScopes = await rollbackSwitchedInstances(attempted, originals, "switchMemberModel-rollback");
      throw new Error(failedScopes.length > 0
        ? `Model switch failed at ${failedAt} (${reason}); rollback could not restore ${failedScopes.join(", ")} — those instances were stopped, their conversation history is preserved.`
        : `Model switch failed at ${failedAt} (${reason}); every attempted instance was restored to its previous model.`);
    }

    // Commit the global config exactly once, after every instance accepted.
    try {
      const { updateMember } = await import("../../member/identity.js");
      updateMember(memberId, { global: { model: normalizedModel, credentialId: binding.credentialId } });
    } catch (saveErr) {
      const reason = String((saveErr as Error)?.message || saveErr);
      const failedScopes = await rollbackSwitchedInstances(attempted, originals, "switchMemberModel-save-rollback");
      throw new Error(failedScopes.length > 0
        ? `Config save failed (${reason}); rollback could not restore ${failedScopes.join(", ")} — those instances were stopped, their conversation history is preserved.`
        : `Config save failed (${reason}) — every live instance was restored to its previous model.`);
    }

    return {
      model: normalizedModel,
      credentialId: profile.id,
      instances: attempted.map((inst) => ({ scopeId: inst.scopeId, applied: true })),
    };
  } finally {
    memberSwitchGates.delete(memberId);
    releaseGate();
  }
}

/** Thinking level is member-global too (§6): apply to every live instance of
 * the member. Working instances queue the level for their next settlement
 * (per-instance pending switch), idle ones apply immediately. */
export async function switchMemberThinkingLevel(memberId: string, thinkingLevel: string): Promise<{ applied: string[]; pending: string[] }> {
  const targets = [...instances.values()].filter((inst) => inst.memberId === memberId);
  const applied: string[] = [];
  const pending: string[] = [];
  for (const inst of targets) {
    const p = { thinkingLevel };
    if (inst.status === "working" || inst.dispatchState !== "idle") {
      inst.pendingThinkingSwitch = p;
      pending.push(inst.scopeId);
      continue;
    }
    await applyThinkingSwitchToInstance(inst, p, "switchMemberThinkingLevel");
    applied.push(inst.scopeId);
  }
  return { applied, pending };
}



// -- Status --

/** Read-only live-instance lookup by scope (batch 6 reload surface + tests). */
export function getAgentInstanceForScope(scopeId: string, memberId: string): AgentInstance | null {
  const instance = instances.get(instanceKey(memberId)) ?? null;
  if (instance?.profilePromptDirty) refreshProfileSources(instance);
  return instance;
}

export function getAgentStatus(roomId: string, memberRef: string): AgentStatus {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const instance = instances.get(instanceKey(memberId));
  if (!instance) return "inactive";
  return instance.status;
}

export function getMemberBusyState(roomId: string, memberRef: string): { busy: boolean; reason?: string } {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const key = instanceKey(memberId);
  if (pendingCreations.has(key)) return { busy: true, reason: "pending_creation" };
  const instance = instances.get(key);
  if (!instance) return { busy: false };
  if (instance.status === "working") return { busy: true, reason: "working" };
  if (instance.dispatchState !== "idle") return { busy: true, reason: instance.dispatchState };
  if (instance.promptInFlight) return { busy: true, reason: "prompt_in_flight" };
  return { busy: false };
}

export function getRoomAgentStatuses(roomId: string): Record<string, AgentStatus> {
  const result: Record<string, AgentStatus> = {};
  for (const member of roomStore.getRoomMembers(roomId)) result[member.name] = getAgentStatus(roomId, member.id);
  return result;
}

/** Stale info for all room members (for initial GET /api/rooms/:id load). */
export function getRoomAgentStale(roomId: string): Record<string, { mounts?: { since: number; fields: string[] }; contract?: boolean }> {
  const result: Record<string, { mounts?: { since: number; fields: string[] }; contract?: boolean }> = {};
  const scopeId = `room:${roomId}`;
  for (const member of roomStore.getRoomMembers(roomId)) {
    const stale = getMemberStale(scopeId, member.id);
    if (stale) result[member.name] = stale;
  }
  return result;
}

// -- Member status report (member_info tool) --

export interface MemberStatusEntry {
  name: string;
  memberId: string;
  /** Aggregated across live instances: working > idle > inactive (no live instance). */
  status: AgentStatus;
  /** Room-instance status in this room (inactive if none). */
  room: AgentStatus;
  /** Live instances only: which scopes this member is active in, with per-scope status. */
  activeScopes: Array<{ scope: string; status: AgentStatus }>;
  /** Mount/contract stale markers for badges (auto-reload prompt). */
  stale?: { mounts?: { since: number; fields: string[] }; contract?: boolean };
}

/**
 * Live status report for room members — same source as the member panel
 * status lamp (the runtime instance registry). Read-only.
 */
export function getRoomMemberStatusReport(roomId: string, memberRef?: string): MemberStatusEntry[] | null {
  const members = memberRef
    ? (() => { const m = resolveRoomMember(roomId, memberRef); return m ? [m] : null; })()
    : roomStore.getRoomMembers(roomId);
  if (!members) return null;
  const thisRoom = roomStore.getRoom(roomId);
  if (!thisRoom) return null;
  return members.map((m) => {
    const gid = (thisRoom ? roomStore.resolveGlobalMemberId(thisRoom, m) : null) || m.id;
    const activeScopes: Array<{ scope: string; status: AgentStatus }> = [];
    let roomStatus: AgentStatus = "inactive";
    let status: AgentStatus = "inactive";
    const bump = (st: AgentStatus) => {
      if (st === "working") status = "working";
      else if (status === "inactive") status = "idle";
    };
    for (const inst of instances.values()) {
      if (inst.scopeId.startsWith("dm:")) {
        const match = inst.memberId === m.id || inst.memberId === gid || inst.scopeId === `dm:${gid}`;
        if (!match) continue;
        activeScopes.push({ scope: "dm", status: inst.status });
        bump(inst.status);
        continue;
      }
      const r = roomStore.getRoom(inst.roomId.startsWith("room:") ? inst.roomId.slice("room:".length) : inst.roomId);
      if (!r) continue;
      const local = roomStore.getRoomMembers(r.id).find((rm) => rm.id === inst.memberId || rm.name === inst.agentName);
      if (!local) continue;
      const match = roomStore.resolveGlobalMemberId(r, local) === gid || inst.memberId === m.id;
      if (!match) continue;
      activeScopes.push({ scope: r.id === roomId && thisRoom ? `room: ${thisRoom.name}` : `room: ${r.name}`, status: inst.status });
      if (r.id === roomId) roomStatus = inst.status === "working" ? "working" : (roomStatus === "working" ? "working" : inst.status);
      bump(inst.status);
    }
    return { name: m.name, memberId: m.id, status, room: roomStatus, activeScopes, stale: getMemberStale(`room:${roomId}`, m.id) ?? undefined };
  });
}

// -- Contract drift + mount stale (auto-reload prompt, fish 2026-08-07) --

export interface ContractDriftEntry {
  memberName: string;
  memberId: string;
  scopeId: string;
  scopeLabel: string;
  /** Current build's contract version. */
  currentVersion: number;
  /** True if the user already dismissed a notification for this exact version. */
  alreadyNotified: boolean;
}

/**
 * Detect contract drift for a room's members: compare the stored fingerprint
 * (from the build that last compiled each member's prompt) against the
 * *current* build's fingerprint. A mismatch means bossmode was updated (core
 * tools/prompt changed) while the member's session was running with the old
 * contract. Called at daemon boot to populate the startup drift dialog.
 */
export function computeContractDrift(_roomId: string): ContractDriftEntry[] {
  // Identity batch-2: contract drift / Reload dialog retired.
  return [];
}


/** Mount-stale info for a member in a scope (for status badges + WS).
 * Suppresses staleMounts for members with no live instance (activation = fresh mounts).
 */
export function getMemberStale(_scopeId: string, _memberId: string): { mounts?: { since: number; fields: string[] }; contract?: boolean } | null {
  // Identity batch-2: Reload/stale retired — activation recompiles; no badges.
  return null;
}


export function broadcastMemberStatus(roomId: string, memberRef: string): void {
  const member = resolveRoomMember(roomId, memberRef);
  if (!member) return;
  const key = instanceKey(member.id);
  const instance = instances.get(key);
  const status = instance?.status ?? "inactive";
  const stale = getMemberStale(`room:${roomId}`, member.id) ?? undefined;
  broadcastToRoom(roomId, {
    type: "agent:status",
    roomId,
    agent: member.name,
    ...memberIdentityMeta(member.name, member.id),
    status,
    ...(stale ? { stale } : {}),
  });
}

// -- Context usage (cache-only API + idle refresh push) --

const contextUsageCache = new Map<string, ContextUsage>();
const contextCompactionWarningCache = new Set<string>();

function isCompactUsageDrop(previous: ContextUsage | undefined, next: ContextUsage): boolean {
  if (!previous) return false;
  if (!Number.isFinite(previous.totalTokens) || !Number.isFinite(next.totalTokens)) return false;
  if (previous.totalTokens <= 0 || next.totalTokens <= 0) return false;
  const max = next.rawMaxTokens || previous.rawMaxTokens || 0;
  const wasNearOrOverLimit = max > 0 ? previous.totalTokens >= max * 0.8 : previous.percentage >= 80;
  return wasNearOrOverLimit && next.totalTokens <= previous.totalTokens * 0.25;
}

function shouldKeepCompactedMarker(previous: ContextUsage | undefined, next: ContextUsage): boolean {
  if (!previous?.compacted) return false;
  if (!Number.isFinite(previous.totalTokens) || !Number.isFinite(next.totalTokens)) return false;
  if (previous.totalTokens <= 0 || next.totalTokens <= 0) return false;
  return next.totalTokens <= previous.totalTokens * 1.25;
}

export function getAgentContextUsage(roomId: string, memberRef: string): ContextUsage | null {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const key = instanceKey(memberId);
  return contextUsageCache.get(key) ?? null;
}

/** Live tools from the running session. No session → sessionActive false, empty tools (no config projection). */
export function getMemberActiveTools(roomId: string, memberRef: string): {
  sessionActive: boolean;
  tools: Array<{ name: string; label?: string; description: string; parameters: unknown; source: string }>;
  message?: string;
} {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const key = instanceKey(memberId);
  const instance = instances.get(key);
  if (!instance?.handle.getActiveTools) {
    return {
      sessionActive: false,
      tools: [],
      message: "Start or Reload this member to see active tools.",
    };
  }
  try {
    const tools = instance.handle.getActiveTools() || [];
    return { sessionActive: true, tools };
  } catch {
    return {
      sessionActive: false,
      tools: [],
      message: "Start or Reload this member to see active tools.",
    };
  }
}

interface RefreshContextUsageOptions {
  /** Trust compacted/null-token usage as a real post-compact update instead of carrying forward the previous value. */
  acceptCompactedSnapshot?: boolean;
  /** Extra delayed refreshes for runtimes that update session stats shortly after compaction_end. */
  retries?: number;
  retryDelayMs?: number;
}

function refreshContextUsageOnce(roomId: string, memberRef: string, options: RefreshContextUsageOptions = {}): void {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const agentName = member?.name || memberRef;
  const key = instanceKey(memberId);
  const instance = instances.get(key);
  if (!instance?.handle.getContextUsage) return;

  instance.handle.getContextUsage().then((usage) => {
    if (!usage) return;
    const previous = contextUsageCache.get(key);
    if (usage.compacted && previous && !options.acceptCompactedSnapshot) usage = { ...previous, compacted: true };
    else if (isCompactUsageDrop(previous, usage) || shouldKeepCompactedMarker(previous, usage)) usage = { ...usage, compacted: true };
    if (usage.compacted && !previous && !options.acceptCompactedSnapshot) return;
    const crossedCompactionThreshold = !usage.compacted && usage.percentage >= 80 && (!previous || previous.percentage < 80);
    if (crossedCompactionThreshold && !contextCompactionWarningCache.has(key)) {
      contextCompactionWarningCache.add(key);
      logger.warn("agent", "context usage crossed compaction threshold without compacted marker", {
        roomId,
        agent: agentName,
        memberId,
        totalTokens: usage.totalTokens,
        rawMaxTokens: usage.rawMaxTokens,
        percentage: usage.percentage,
        model: usage.model,
      });
    }
    if (usage.compacted || usage.percentage < 50) contextCompactionWarningCache.delete(key);
    contextUsageCache.set(key, usage);
    broadcastToRoom(roomId, {
      type: "agent:context_usage",
      roomId,
      agent: agentName,
      ...memberIdentityMeta(agentName, memberId),
      usage,
    });
  }).catch(() => {});
}

/** Proactively refresh context usage cache (called on agent_end / compaction_end). Fire-and-forget, non-blocking. */
export function refreshContextUsage(roomId: string, memberRef: string, options: RefreshContextUsageOptions = {}): void {
  refreshContextUsageOnce(roomId, memberRef, options);
  const retries = Math.max(0, options.retries || 0);
  const delay = Math.max(0, options.retryDelayMs || 0);
  for (let i = 1; i <= retries; i += 1) {
    const timer = setTimeout(() => {
      // A retry can fire after teardown (shutdown, test isolation): drop it
      // instead of letting the storage access escape as an unhandled error.
      try { refreshContextUsageOnce(roomId, memberRef, options); }
      catch { /* runtime torn down — drop the retry */ }
    }, delay * i);
    (timer as { unref?: () => void }).unref?.();
  }
}

export const refreshContextUsageOnIdle = refreshContextUsage;

// -- Event history --

export function getAgentEventHistory(roomId: string, memberRef: string): AgentHistoryEvent[] {
  const member = resolveRoomMember(roomId, memberRef);
  return loadEventsFromDisk(roomId, member?.id || memberRef);
}

function emitAgentLocalEvent(
  roomId: string,
  memberRef: string,
  event: AgentHistoryEvent,
  identity?: { memberId: string; agentName: string },
): void {
  const scopedMember = roomId.startsWith("dm:") ? getMember(memberRef) : null;
  const member = identity ? undefined : scopedMember ?? roomStore.resolveRoomMemberRef(roomId, memberRef);
  // Prefer live instance identity, then the global member record for DM.
  const keyHint = instanceKey(member?.id || memberRef);
  const instance = instances.get(keyHint)
    || [...instances.values()].find((inst) => inst.roomId === roomId && (inst.memberId === memberRef || inst.agentName === memberRef));
  const memberId = identity?.memberId || member?.id || instance?.memberId || memberRef;
  const agentName = identity?.agentName || member?.name || instance?.agentName || memberRef;
  // Use the same authoritative, commit-safe event/outbox path as SDK events.
  // Failed persistence is not a successful activity notification.
  processEvent(roomId,agentName,keyHint,event as AgentStreamEvent,instance?.eventBuffer ?? [],memberId);

}

// -- Manual compaction (conversation action) --

/** Manual compaction as ONE explicit conversation action (steer-removal §2):
 * room and DM address the live instance by its real scopeId — no
 * more room-path shortcuts. The operation marks the lifecycle busy BEFORE the
 * first await, so ordinary messages queue (they never cancel it);
 * explicit Stop stays the one canceller, including in the window between the
 * old prompt settling and compaction actually starting. Shell processes are
 * never killed — blocking shell waits are settled so the member's turn can
 * end, but the commands keep running in the PTY. */
export async function compactMember(scopeId: string, memberId: string): Promise<{ ok: boolean; action: string }> {
  let instance: AgentInstance | undefined = instances.get(instanceKey(memberId)) ?? undefined;
  if (!instance) {
    // The room /compact command can arrive before any activation — build the
    // session (no prompt) so there is something to compact. Unresolvable or
    // unconfigured members still fail honestly.
    instance = (await buildMemberAgentSession(memberId, scopeId)) ?? undefined;
    if (!instance) throw new Error(`No active session in this scope — nothing to compact (${scopeId})`);
  }
  if (instance.compacting) throw new Error("Compaction is already in progress for this session");
  if (!instance.handle.compact) throw new Error("Runtime does not support manual compaction");

  // Busy before the next await (§3): once an instance is in hand (live or
  // freshly built — the build itself is gated), the lifecycle is marked
  // synchronously so message paths see a compacting/busy instance and queue;
  // Stop finds a busy lifecycle in every window instead of an already-idle
  // no-op. Reuses the existing compacting/dispatch fields — no second queue,
  // no timers.
  instance.compacting = true;
  updateDispatchState(instance, "running", "compact-requested");
  transition(instance, instance.roomId, instance.agentName, "working", "compact-requested");
  let started = false;
  let completed = false;
  try {
    // Settle the old turn first: shell waits return as running (commands stay
    // alive in the PTY), the SDK abort finishes the in-flight prompt.
    if (instance.turnActive || instance.promptInFlight || instance.status === "working") {
      settleMemberShellWaits(instance.memberId);
      try { instance.handle.abort(); } catch { /* already stopped */ }
      await instance.handle.waitForIdle();
      // Stop landed in the gap (old prompt finished, compact not started):
      // abortAgent marked dispatchState "aborting" — honor it, do not compact.
      if (instance.dispatchState === "aborting" || !memberRuntimeAllowed(memberId)) {
        logger.info("agent", "manualCompactStoppedBeforeStart", { member: instance.agentName, scopeId: instance.scopeId });
        return { ok: false, action: "stopped" };
      }
    }
    started = true;
    // From here the event bridge owns the lifecycle: compaction_end resets
    // compacting/status and resumes queued inputs as a fresh prompt.
    const outcome = await instance.handle.compact();
    if (outcome?.aborted) {
      logger.info("agent", "manualCompactAborted", { member: instance.agentName, scopeId: instance.scopeId });
      return { ok: false, action: "stopped" };
    }
    completed = true;
    return { ok: true, action: "compacted" };
  } catch (err) {
    const message = formatRuntimeErrorMessage(err);
    if (started) {
      // The bridge already emitted compaction_end(aborted/error) and settled.
      logger.error("agent", "manualCompactFailed", { member: instance.agentName, scopeId: instance.scopeId, error: message });
      postMessage(instance.roomId, "system", `Manual compaction failed for "${instance.agentName}": ${message}`);
    }
    throw err;
  } finally {
    if (!started) {
      // Never reached the SDK operation (stopped in the window or pre-start
      // failure): restore the lifecycle here and resume queued inputs.
      instance.compacting = false;
      updateDispatchState(instance, "idle", "compact-not-started");
      transition(instance, instance.roomId, instance.agentName, "idle", "compact-not-started");
      drainQueuedInputsAsPrompt(instance, "compact-not-started");
    }
    // A manual compact emits agent_end after compaction_end and has no input
    // pump to flush deferred reloads. Wait for the actual SDK operation first.
    if (completed && instances.get(instanceKey(memberId)) === instance
      && memberRuntimeAllowed(memberId) && !queueDepth(instance)) maybeFlushPendingReload(instance);
  }
}

// -- Abort --

export function abortAgent(roomId: string, memberRef: string): { ok: boolean; action: string } {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const memberName = member?.name || memberRef;
  const key = instanceKey(memberId);
  cancelPendingRuntimeInputs(runtimeInputOwner(roomId,memberId),"explicit stop");
  const instance = instances.get(key);
  if (!instance) return { ok: false, action: "not_found" };
  if (instance.status !== "working" && instance.dispatchState === "idle") return { ok: true, action: "already_idle" };

  // Stop is the sole abort entry.
  try { settleMemberShellWaits(memberId); } catch { /* ignore */ }

  // Abort via stdin protocol, keep instance alive. Public idle waits for runtime agent_end.
  instance.handle.abort();
  updateDispatchState(instance, "aborting", "abort");
  cancelPendingRuntimeInputs(runtimeInputOwner(instance.scopeId,instance.memberId),"explicit stop");
  logger.info("agent", "aborted", { member: memberName, memberId, roomId });
  return { ok: true, action: "aborted" };
}

// -- Instance management --

export function getMemberInstances(memberName: string): Array<{
  roomId: string;
  roomName: string;
  status: AgentStatus;
  runtime: string;
  pid?: number;
  spawnArgs?: string[];
  runtimeParams?: import("../types.js").AgentRuntimeParams;
}> {
  const result: Array<{ roomId: string; roomName: string; status: AgentStatus; runtime: string; pid?: number; spawnArgs?: string[]; runtimeParams?: import("../types.js").AgentRuntimeParams }> = [];
  for (const instance of instances.values()) {
    if (instance.agentName === memberName || instance.memberId === memberName) {
      const roomId = instance.roomId;
      const room = roomStore.getRoom(roomId);
      const handle = instance.handle as any;
      result.push({
        roomId,
        roomName: room?.name || roomId,
        status: instance.status,
        runtime: handle.runtimeName || "unknown",
        pid: handle.pid,
        spawnArgs: handle.spawnArgs,
        runtimeParams: handle.runtimeParams,
      });
    }
  }
  return result;
}

export async function reloadMemberResources(roomId: string, memberRef: string): Promise<{ ok: true; reloaded: boolean; message: string }> {
  const room = roomStore.getRoom(roomId);
  if (!room) throw new Error("Room not found");
  const member = resolveRoomMember(roomId, memberRef);
  if (!member) throw new Error(`Member not found: ${memberRef}`);
  const memberId = member.id;
  const key = instanceKey(memberId);
  const instance = instances.get(key);
  if (!instance) {
    // No running instance: reload is a no-op semantically (activation creates
    // fresh with current code/config), but we still refresh the contract
    // fingerprint+version and clear stale markers so the UI doesn't show
    // a false "needs reload" badge for a member that will auto-pick-up.
    try {
      setContractFingerprint(memberId, currentContractFingerprint(), MEMBER_CONTRACT_VERSION);
    } catch { /* compile failed — best effort */ }
    clearStaleMounts(memberId);
    return { ok: true, reloaded: false, message: "Member is not running — marked up to date; latest prompt, skills and tools apply on next activation." };
  }
  if (instance.status === "working" || instance.dispatchState !== "idle" || instance.promptInFlight) {
    throw new Error("Member is busy. Reload when the current turn is idle.");
  }
  if (!instance.handle.reloadResources) throw new Error("Runtime does not support in-place reload.");

  const compiled = compileForMember(memberId);
  const skills = resolveSkills(member);
  const skillPaths = [
    ...resolveGlobalSkillPaths(skills),
  ];

  await instance.handle.reloadResources({
    roomId,
    resolveChatId: () => instance.activeChat.scopeId,
    member,
    agentPrompt: compiled.agentPrompt,
    appendSystemPrompt: compiled.appendSystemPrompt,
    skillPaths,
    skillNames: skills,
  });
  // Reload picked up new contract + mounts: refresh fingerprint, clear stale.
  setContractFingerprint(memberId, compiled.contractFingerprint, MEMBER_CONTRACT_VERSION);
  clearStaleMounts(memberId);
  emitAgentLocalEvent(roomId, memberId, { type: "system", text: "Reloaded member resources in place." });
  logger.info("agent", "member resources reloaded", { roomId, member: member.name, memberId, skills: skills.length });
  return { ok: true, reloaded: true, message: "Reloaded latest prompt, skills and tools in place." };
}

export function resetAgentSession(roomId: string, memberRef: string): { ok: true; message: string } {
  const scopeId = roomId.startsWith("dm:") ? roomId : `room:${roomId}`;
  const ref = parseScopeId(scopeId);
  const resolved = ref?.kind === "room" ? resolveRoomMember(ref.roomId, memberRef) : undefined;
  const memberId = resolved?.id || memberRef;
  const key = instanceKey(memberId);
  const instance = instances.get(key);
  const agentName = resolved?.name || instance?.agentName || memberRecordToConfig(memberId)?.name || memberRef;

  destroyInstance(scopeId, memberId, {preservePending:true});
  clearActivationSource(scopeId, memberId);
  const message = "Session reset. Next activation will start fresh.";
  getDatabase().transaction(() => {
    cancelPendingRuntimeInputs(runtimeInputOwner(scopeId,memberId),"session reset");
    sessionStore.clearCurrentSession(memberId);
    clearRuntimeStateEntry(memberId);
    if (ref?.kind === "room") roomStore.setCursor(ref.roomId, memberId, null);
    emitAgentLocalEvent(ref?.kind === "room" ? ref.roomId : scopeId, memberId,
      {type:"system",text:message},{memberId,agentName});
  });
  if (ref) {
    const eventScope = ref.kind === "room" ? ref.roomId : scopeId;
    const statusEvent = { type: "agent:status" as const, roomId: eventScope, agent: agentName, ...memberIdentityMeta(agentName, memberId), status: "inactive" as const };
    if (ref.kind === "dm") broadcastToAgentSubscribers(eventScope, agentName, statusEvent);
    else broadcastToRoom(eventScope, statusEvent);
  }
  return { ok: true, message };
}

// -- Member-level operations (① B5) --
// Stop / compact / reset / restart target the member directly — one runtime
// per member means no chat scope belongs in the interface.

/** Every scope this member can hold queued work in. */
function memberScopesFor(memberId: string): string[] {
  return [
    ...listRoomsForMember(memberId).map((r) => `room:${r.id}`),
    ...roomStore.listMmScopesForMember(memberId),
    scopeIdOf({ kind: "dm", memberId }),
  ];
}

/** Drop the member's live runtime (teardown only; no SQL side effects). */
function teardownMemberInstance(memberId: string): void {
  const key = instanceKey(memberId);
  const instance = instances.get(key);
  if (!instance) return;
  invalidateInputScope(key);
  sessionPublishOwners.delete(key);
  requestInstanceStop(instance, true);
  instance.handle.destroy();
  instance.unsubscribe();
  if (instances.get(key) === instance) instances.delete(key);
  contextUsageCache.delete(key);
  contextCompactionWarningCache.delete(key);
}

/** Stop the member's current work; queued work in every chat is cancelled. */
export function abortMember(memberId: string): { ok: boolean; action: string } {
  for (const scope of memberScopesFor(memberId)) cancelPendingRuntimeInputs(runtimeInputOwner(scope, memberId), "explicit stop");
  const instance = instances.get(instanceKey(memberId));
  if (!instance) return { ok: false, action: "not_found" };
  if (instance.status !== "working" && instance.dispatchState === "idle") return { ok: true, action: "already_idle" };
  try { settleMemberShellWaits(memberId); } catch { /* ignore */ }
  instance.handle.abort();
  updateDispatchState(instance, "aborting", "member stop");
  logger.info("agent", "memberAborted", { memberId, member: instance.agentName });
  return { ok: true, action: "aborted" };
}

/** Compact the member's session: the chat being served, else the member DM. */
export async function compactMemberById(memberId: string): Promise<{ ok: boolean; action: string }> {
  const instance = instances.get(instanceKey(memberId));
  const scope = instance?.activeChat?.scopeId || scopeIdOf({ kind: "dm", memberId });
  return compactMember(scope, memberId);
}

/** Reset the member's session from any interface. */
export function resetMemberSession(memberId: string): { ok: true; message: string } {
  const instance = instances.get(instanceKey(memberId));
  const agentName = instance?.agentName || memberRecordToConfig(memberId)?.name || memberId;
  const scopes = memberScopesFor(memberId);
  const message = "Session reset. Next activation will start fresh.";
  getDatabase().transaction(() => {
    for (const scope of scopes) cancelPendingRuntimeInputs(runtimeInputOwner(scope, memberId), "session reset");
    sessionStore.clearCurrentSession(memberId);
  });
  teardownMemberInstance(memberId);
  for (const scope of scopes) {
    clearActivationSource(scope, memberId);
    clearRuntimeStateEntry(memberId);
    const target = chatTargetOf(scope);
    const statusEvent = { type: "agent:status" as const, roomId: target, agent: agentName, ...memberIdentityMeta(agentName, memberId), status: "inactive" as const };
    if (scope.startsWith("dm:")) broadcastToAgentSubscribers(target, agentName, statusEvent);
    else broadcastToRoom(target, statusEvent);
  }
  emitAgentLocalEvent(scopeIdOf({ kind: "dm", memberId }), memberId, { type: "system", text: message }, { memberId, agentName });
  logger.info("agent", "memberSessionReset", { memberId, member: agentName });
  return { ok: true, message };
}

/** Restart the member's runtime: drop it; the next activation rebuilds. */
export function restartMember(memberId: string): { ok: true; message: string } {
  for (const scope of memberScopesFor(memberId)) cancelPendingRuntimeInputs(runtimeInputOwner(scope, memberId), "member restart");
  teardownMemberInstance(memberId);
  logger.info("agent", "memberRestarted", { memberId });
  return { ok: true, message: "Member restarted. Next activation will start a fresh runtime." };
}

export function destroyInstance(roomId: string, memberRef: string,options:{preservePending?:boolean}={}): void {
  const resolved = resolveRoomMember(roomId, memberRef);
  const memberId = resolved?.id || memberRef;
  const memberName = resolved?.name || memberRef;
  const key = instanceKey(memberId);
  if(!options.preservePending)cancelPendingRuntimeInputs(runtimeInputOwner(roomId,memberId),"instance removed");
  invalidateInputScope(key);
  sessionPublishOwners.delete(key);
  if (pendingCreations.has(key)) cancelledCreations.add(key);
  const instance = instances.get(key);
  if (instance) {
    requestInstanceStop(instance,options.preservePending);
    instance.handle.destroy();
    instance.unsubscribe();
    instances.delete(key);
    contextUsageCache.delete(key);
    contextCompactionWarningCache.delete(key);
    clearActivationSource(roomId, memberId);
    logger.info("agent", "instance destroyed", { member: memberName, memberId, roomId });
  }
}

export function getActiveInstanceCount(): number {
  return instances.size;
}

// -- DM activation (0.20, no @ required) -------------------------------------

export function memberRecordToConfig(memberId: string): AgentMemberConfig | null {
  const rec = getMember(memberId);
  if (!rec) return null;
  const scopeId = scopeIdOf({ kind: "dm", memberId });
  const eff = getMemberConfiguration(memberId);
  return {
    id: rec.id,
    name: rec.name,
    type: "agent",
    agent: rec.agentTemplate,
    runtime: "pi-cli",
    model: eff.model || undefined,
    credentialId: eff.credentialId || undefined,
    thinkingLevel: (eff.thinkingLevel as string) || "off",
    skills: eff.skills || [],
    mcpServers: eff.mcpServers || [],
  };
}

// -- Instance event wiring (single implementation for room and DM scopes) --

/**
 * THE one instance event subscription. Room and DM instances share this wiring;
 * the only scope difference is the notification address: `roomId` is the bare
 * room id for room scope and "dm:<memberId>" for DM scope, and postMessage
 * routes by that prefix (room store vs member-owned DM store). Failure notices
 * therefore reach the user in both UIs (G1), and lifecycle handling (length
 * continuation, compaction, unexpected exit, queued-input draining) cannot
 * drift between scopes.
 */
function wireInstanceEvents(
  instance: AgentInstance,
  key: string,
  builtRoomId: string,
  memberId: string,
): void {
  const unsubscribe = instance.handle.subscribe((event: AgentStreamEvent) => {
    const memberName = instance.agentName;
    // ① B1: persisted/streamed facts belong to the chat being served right
    // now; event scopes keep the historical form (bare room id | dm:<id>).
    const roomId = chatTargetOf(instance.activeChat?.scopeId || builtRoomId);
    const newStatus = processEvent(roomId, memberName, key, event, instance.eventBuffer, memberId, instance.appliedModel);
    if (event.type === "agent_start") {
      instance.turnActive = true;
      if (instance.lengthContinuationPending) instance.lengthContinuationPending = false;
      if(instance.dispatchState!=="aborting")updateDispatchState(instance, "running", event.type);
    } else if (event.type === "agent_end") {
      // pi session-level retry: willRetry agent_end is not a real turn end — keep
      // turnActive/dispatch/queue as-is so public status stays working and wait
      // does not wake on the retry gap (fish 2026-08-09 experiment).
      if (event.willRetry) {
        instance.pendingErrorNotice = null; // suppress mid-retry error system messages
        logger.info("agent", "agent_end_willRetry", { member: memberName, roomId, memberId });
      } else {
        // Final agent_end for this attempt budget — settle deferred error notice once.
        if (instance.pendingErrorNotice) {
          postMessage(roomId, "system", instance.pendingErrorNotice);
          instance.pendingErrorNotice = null;
        }
        // Public status may become idle here, but the SDK run can still be finalizing.
        // Keep dispatch busy until handle.prompt() settles to avoid a second prompt().
        instance.turnActive = false;
        if (!instance.promptInFlight) {
          updateDispatchState(instance, "idle", event.type);
          applyPendingAfterPromptSettlement(instance, event.type);
          // Queue non-empty → continue without public idle flash (wait stays asleep).
          if (drainQueuedInputsAsPrompt(instance, event.type)) {
            (event as any)._skipIdleTransition = true;
          }
        } else {
          // prompt() still settling — if more work is queued, skip idle now; finalize
          // will drain after prompt resolves (same "queue empty" idle rule).
          if (queueDepth(instance) > 0) {
            (event as any)._skipIdleTransition = true;
          }
          if (instance.dispatchState === "idle") {
            applyPendingAfterPromptSettlement(instance, event.type);
          }
        }
      }
    } else if (event.type === "compaction_start") {
      instance.compacting = true;
      transition(instance, roomId, memberName, "working", event.type);
    } else if (event.type === "compaction_end") {
      instance.compacting = false;
      if (!instance.turnActive) {
        transition(instance, roomId, memberName, "idle", event.type);
        drainQueuedInputsAsPrompt(instance, event.type);
        maybeFlushPendingReload(instance);
        // Batch 6 §3: after compaction the session is rebuilt with fresh
        // assets, resuming from the compacted file (member-invisible). If
        // anything is still settling, defer via the pendingReload flag.
        const settled = instance.status === "idle" && !instance.compacting && !instance.turnActive
          && instance.dispatchState === "idle" && !instance.promptInFlight && queueDepth(instance) === 0;
        if (settled) {
          const compactionScopeId = instance.activeChat?.scopeId || instance.scopeId;
          const compactionMemberId = instance.memberId;
          const compactionKey = instanceKey(compactionMemberId);
          setTimeout(() => {
            if (instances.get(compactionKey) !== instance) return; // replaced meanwhile
            void reloadMemberSession(compactionScopeId, compactionMemberId, "compaction").catch((err) =>
              logger.error("agent", "post-compaction reload failed", { memberId: compactionMemberId, scopeId: compactionScopeId, error: String(err) }),
            );
          }, 0);
        } else {
          instance.pendingReload = instance.pendingReload || "compaction";
        }
      }
    } else if (event.type === "runtime_exit" && event.unexpected) {
      updateDispatchState(instance, "idle", event.type);
      // Pending SQL inputs survive a runtime exit; uncertain dispatched work is never replayed.
    }
    if (newStatus) {
      if (newStatus === "idle" && event.type === "agent_end" && (event as any)._skipIdleTransition) {
        // drained next prompt — stay working publicly
      } else {
        transition(instance, roomId, memberName, newStatus, event.type);
      }
    }

    if (event.type === "message_end") {
      instance.lastMessageEndWasLength = isLengthStopReason(event.stopReason);
      if (instance.lastMessageEndWasLength) {
        instance.lengthContinuationPending = true;
        logger.warn("agent", "lengthContinuationPending", { member: memberName, roomId, memberId, stopReason: event.stopReason });
      }
    }

    if (event.type === "message_end" && event.stopReason === "error") {
      instance.hadErrorInTurn = true;
      const formattedError = typeof event.errorMessage === "string" ? formatRuntimeErrorMessage(event.errorMessage).trim() : "";
      instance.lastTurnError = formattedError || "unrecoverable provider error";
      const detail = formattedError
        ? ` Error: ${formattedError}`
        : " An unrecoverable provider error occurred.";
      logger.error("agent", "member request failed", { roomId, member: memberName, memberId, error: formattedError || "unrecoverable provider error" });
      // Defer system notice until final agent_end — willRetry attempts stay silent
      // so a retry storm posts one death notice, not one per attempt (fish 2026-08-09).
      instance.pendingErrorNotice = `Member "${memberName}" request failed.${detail}`;
    }

    // Unexpected runtime exit: notify the conversation and drop the dead
    // instance so the next activation respawns it.
    if (event.type === "runtime_exit" && event.unexpected) {
      const codeStr = event.code !== null ? `exit ${event.code}` : (event.signal ? `signal ${event.signal}` : "terminated");
      const detail = event.stderrTail ? `\n${event.stderrTail}` : "";
      instance.hadErrorInTurn = true;
      instance.lastTurnError = `runtime ended unexpectedly (${codeStr})`;
      // Wake the runtime teardown path (processEvent does not idle this path).
      if (instance.status !== "idle") {
        transition(instance, roomId, memberName, "idle", event.type);
      }
      postMessage(roomId, "system", `Member "${memberName}" runtime ended unexpectedly (${codeStr}).${detail}`);
      logger.warn("agent", "instance removed after unexpected exit", {
        member: memberName, roomId, code: event.code, signal: event.signal,
      });
      if (instances.get(key) === instance) instances.delete(key);
      try { instance.unsubscribe(); } catch {}
      try { instance.handle.destroy(); } catch {}
    }
  });
  instance.unsubscribe = unsubscribe;
}

async function getOrCreateDm(memberId: string): Promise<AgentInstance | null> {
  return buildMemberAgentSession(memberId, scopeIdOf({ kind: "dm", memberId }));
}

/**
 * Activate a member in their DM scope (user message path — no @ required).
 * Builds context from recent DM messages and prompts the runtime.
 */
export async function activateDmMember(memberId:string,ctx?:ReplyContext):Promise<void>{return activateControl(`dm:${memberId}`,memberId,ctx);}

function interruptAcceptedInput(scopeId:string,instance:AgentInstance,trigger:string):void{
  try{settleMemberShellWaits(instance.memberId);}catch{}
  // ① B1: one runtime serves every chat, so an interrupt can arrive while the
  // member is between turns. Only a real in-flight turn becomes "aborting" —
  // marking a quiet instance aborting would wedge its input pump (nothing
  // would fire the agent_end that settles it).
  const inFlightTurn=instance.promptInFlight||instance.turnActive;
  instance.handle.abort({preserveCompaction:true});
  if(inFlightTurn)updateDispatchState(instance,"aborting",trigger);
}


/** Single mention-router wiring for production server + acceptance tests (canonical room:/dm: scopes only). */
export function wireMentionRouter():()=>void{
  return initRouter({mention:admitCapturedActivation});
}


function requestInstanceStop(instance: AgentInstance,preservePending=false): void {
  const failures: unknown[] = [];
  if(!runtimeIsStopping()&&!preservePending)cancelPendingRuntimeInputs(runtimeInputOwner(instance.scopeId,instance.memberId),"member quiescence");
  for (const stop of [
    () => settleMemberShellWaits(instance.memberId),
    () => updateDispatchState(instance,"aborting","quiescence"),
    () => instance.handle.abort(),
  ]) { try { stop(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures,"Member stop request incomplete");
}

/** Called only after durable member admission has closed. */
export async function quiesceMember(memberId: string): Promise<void> {
  if (memberRuntimeAllowed(memberId)) throw new Error("member_admission_must_close_before_quiescence");
  const errors: unknown[] = [];
  for(const row of getDatabase().all<{scope:string}>("SELECT DISTINCT scope_id scope FROM queued_inputs WHERE target_actor_key=? AND status='pending'",memberId))cancelPendingRuntimeInputs(runtimeInputOwner(row.scope,memberId),"member archived");
  settleMemberShellWaits(memberId);
  const {dropSftpConnectionsForMember}=await import("../tools/file-tools.js");
  try {await dropSftpConnectionsForMember(memberId);}catch(error){errors.push(error);}
  for (const instance of instances.values()) if (instance.memberId===memberId) {
    try {requestInstanceStop(instance);} catch(error){errors.push(error);}
  }
  await Promise.allSettled([...pendingCreationsFor(memberId), ...(memberSwitchGates.has(memberId) ? [memberSwitchGates.get(memberId)!] : [])]);
  const {closeAllShellsForMember}=await import("../terminal/shell-manager.js");
  const resources = await Promise.allSettled([closeAllShellsForMember(memberId)]);
  for (const result of resources) if (result.status === "rejected") errors.push(result.reason);
  for (const [key,instance] of [...instances]) if(instance.memberId===memberId) {
    try {
      requestInstanceStop(instance);
      if (!instance.handle.destroyAndWait) throw new Error("Runtime cannot confirm member teardown");
      await instance.handle.destroyAndWait();instance.unsubscribe();instances.delete(key);sessionPublishOwners.delete(key);
      contextUsageCache.delete(key);contextCompactionWarningCache.delete(key);clearActivationSource(instance.roomId,memberId);
    }catch(error){errors.push(error);}
  }
  if (registry) for (const runtime of registry.getAll()) {
    try { await runtime.shutdownMember(memberId); } catch (error) { errors.push(error); }
  }
  await settleMemberOperations(memberId);
  if(errors.length)throw new AggregateError(errors,"Member quiescence incomplete");
}

// -- Shutdown --

export async function shutdownAll(): Promise<void> {
  if (shutdownSettlement) return shutdownSettlement;
  closeRuntimeAdmission(); shutdownRunning = true;
  shutdownSettlement = (async () => {
    const failures: unknown[] = [];
    const {dropSftpConnectionsForMember}=await import("../tools/file-tools.js");
    try {await dropSftpConnectionsForMember();}catch(error){failures.push(error);}
    for (const instance of instances.values()) {
      try { requestInstanceStop(instance); } catch (error) { failures.push(error); }
    }
    for (const pending of await Promise.allSettled([...pendingCreations.values(), ...memberSwitchGates.values()])) {
      if (pending.status === "rejected") failures.push(pending.reason);
    }
    const {closeAllShellsForMember}=await import("../terminal/shell-manager.js");
    const resources = await Promise.allSettled([closeAllShellsForMember()]);
    for (const result of resources) if (result.status === "rejected") failures.push(result.reason);
    if (registry) for (const rt of registry.getAll()) {
      try { await rt.shutdownAll(); } catch (error) { failures.push(error); }
    }
    await settleMemberOperations();
    for (const instance of instances.values()) {try {instance.unsubscribe();}catch(error){failures.push(error);}}
    instances.clear(); pendingCreations.clear(); sessionPublishOwners.clear();
    contextUsageCache.clear(); contextCompactionWarningCache.clear(); clearAllActivationSources();
    if (failures.length) throw new AggregateError(failures, "Runtime shutdown incomplete");
  })().finally(() => { shutdownRunning = false; });
  return shutdownSettlement;
}
