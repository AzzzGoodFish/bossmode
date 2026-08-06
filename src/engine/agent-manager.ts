// Agent Manager — agent lifecycle management (slimmed down)
// Prompt assembly → engine/prompt-assembler.ts
// Event handling → engine/event-handler.ts
// Tool callbacks → engine/tools.ts

import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { resolveGlobalSkillPaths } from "../workforce/skill-store.js";
import { resolveMemberExtensionSkillPaths } from "../workspace/extension-store.js";
import { getMemberByName } from "../workforce/member-store.js";
import { resolveRoomMember } from "../workforce/room-member-resolver.js";
import { getBossmodeDir, readConfig } from "../shared/config.js";
import { isSystemNoticeHiddenFromMembers } from "../shared/runtime-error-limit.js";
import * as roomStore from "../workspace/room-store.js";
import * as sessionStore from "../workspace/session-store.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import { postMessage, getMessagesSince, getLatestMessageId } from "../communication/message-bus.js";
import { parseMentions, parseUrgentMentions } from "../communication/router.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../communication/ws.js";
import { compileMemberPrompt, compileMemberPromptForScope } from "./prompt-compiler.js";
import { instanceKey as scopeInstanceKey, scopeIdOf, parseScopeId, type ScopeId } from "../shared/conversation-ref.js";
import { listRoomsForMember } from "../workspace/scope-access.js";
import { getMember, getEffectiveConfig, applyMemberConfigPatch } from "../workspace/member-registry.js";
import { readAllDmMessages } from "../workspace/dm-message-store.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk, appendEventToDisk } from "./event-handler.js";
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
import type { AgentHistoryEvent } from "./event-handler.js";
import type { RuntimeRegistry } from "./runtime/registry.js";
import type { AgentHandle, AgentStreamEvent, AgentMemberConfig } from "./runtime/types.js";
import { exportPiConfigForMember, normalizeModelRef, assertModelAvailable, setMemberActiveCredentialOverride, getMemberActiveCredentialOverride } from "./model-credentials.js";
import { notifyMemberIdle, settleWaitOnAbort } from "./wait-wait.js";
import type { AgentStatus, RoomMessage, ContextUsage } from "../shared/types.js";

// -- Registry injection --

let registry: RuntimeRegistry | null = null;

export function initAgentManager(reg: RuntimeRegistry): void {
  registry = reg;
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

interface PendingThinkingSwitch {
  thinkingLevel: string;
}

interface PendingCredentialRefresh {
  profileId: string;
  providerSlug: string;
  changeType: "profileUpdated" | "profileDeleted";
}

interface AgentInstance {
  handle: AgentHandle;
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
  queuedInputs: string[];
  pendingThinkingSwitch?: PendingThinkingSwitch;
  pendingCredentialRefresh?: PendingCredentialRefresh;
  pendingChatReply: boolean;
  hadErrorInTurn: boolean;
  lastMessageEndWasLength: boolean;
  lengthContinuationPending: boolean;
  lengthContinuationAttempted: boolean;
  /** True while an SDK-driven compaction is running between turns (no active prompt/turn). */
  compacting: boolean;
  /** True from agent_start until agent_end — an SDK turn is actively in flight (distinct from dispatchState, which stays busy past agent_end until prompt() settles). */
  turnActive: boolean;
  unsubscribe: () => void;
  eventBuffer: AgentHistoryEvent[];
  appliedModel: string;
  appliedCredentialId?: string;
}

const instances = new Map<string, AgentInstance>();
const pendingCreations = new Map<string, Promise<AgentInstance | null>>();

/**
 * Resolve instance map key from a roomId-or-scopeId + memberId.
 * - room uuid → room:<uuid>:<memberId>
 * - already "dm:…" / "room:…" scopeId → scopeId:memberId
 * Contract §5.
 */
function instanceKey(roomIdOrScope: string, memberId: string): string {
  if (typeof roomIdOrScope === "string" && (roomIdOrScope.startsWith("dm:") || roomIdOrScope.startsWith("room:"))) {
    return scopeInstanceKey(roomIdOrScope, memberId);
  }
  return scopeInstanceKey(scopeIdOf({ kind: "room", roomId: roomIdOrScope }), memberId);
}

function dmInstanceKey(memberId: string): string {
  return scopeInstanceKey(scopeIdOf({ kind: "dm", memberId }), memberId);
}

function roomScopeId(roomId: string): ScopeId {
  return scopeIdOf({ kind: "room", roomId });
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

/** Working-set for contacts: which scopes a global member is currently active in. */
export function getMemberActiveScopes(globalMemberId: string): ScopeId[] {
  const out: ScopeId[] = [];
  for (const inst of instances.values()) {
    if (inst.status !== "working" && inst.dispatchState === "idle") continue;
    // Match by global id (DM) or by sourceMemberId / name for room locals
    if (inst.scopeId.startsWith("dm:")) {
      if (inst.memberId === globalMemberId || inst.scopeId === `dm:${globalMemberId}`) {
        out.push(inst.scopeId);
      }
      continue;
    }
    const roomUuid = inst.roomId.startsWith("room:") ? inst.roomId.slice("room:".length) : inst.roomId;
    const r = roomStore.getRoom(roomUuid);
    if (!r) continue;
    const local = roomStore.getRoomMembers(r.id).find((m) => m.id === inst.memberId || m.name === inst.agentName);
    if (!local) continue;
    const gid = roomStore.resolveGlobalMemberId(r, local);
    if (gid === globalMemberId) out.push(scopeIdOf({ kind: "room", roomId: r.id }));
  }
  return Array.from(new Set(out));
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
  logger.info("agent", "stateTransition", { member: memberName, from: prev, to: newStatus, trigger });
  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: memberName, ...memberIdentityMeta(memberName, instance.memberId), status: newStatus });
  // Notify blocking wait() callers when a member becomes idle.
  if (newStatus === "idle") {
    try { notifyMemberIdle(roomId, instance.memberId); } catch { /* ignore */ }
  }
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

function flushQueuedInputs(instance: AgentInstance, trigger: string): void {
  if (instance.queuedInputs.length === 0) return;
  const queued = instance.queuedInputs.splice(0);
  logger.info("agent", "flushQueuedInputs", { member: instance.agentName, count: queued.length, trigger });
  for (const input of queued) instance.handle.steer(input);
}

function queueInput(instance: AgentInstance, input: string, trigger: string): void {
  instance.queuedInputs.push(input);
  logger.info("agent", "queueInput", { member: instance.agentName, count: instance.queuedInputs.length, trigger });
}

function applyPendingAfterPromptSettlement(instance: AgentInstance, trigger: string): void {
  applyPendingCredentialRefresh(instance, trigger);
  // Model/credential switches apply immediately (live credential store + setModel);
  // only thinking-level switches still settle at end of turn.
  applyPendingThinkingSwitch(instance, trigger);
}

function markPendingChatReply(instance: AgentInstance, trigger: string): void {
  if (!instance.pendingChatReply) logger.info("agent", "pendingChatReplySet", { member: instance.agentName, roomId: instance.roomId, trigger });
  instance.pendingChatReply = true;
}

function clearPendingChatReply(instance: AgentInstance, trigger: string): void {
  if (!instance.pendingChatReply) return;
  instance.pendingChatReply = false;
  logger.info("agent", "pendingChatReplyCleared", { member: instance.agentName, roomId: instance.roomId, trigger });
}

const LENGTH_CONTINUATION_PROMPT = "⚠ Your previous response was cut off due to output length. Continue from where you stopped and deliver the result with a `response` call.";
const LENGTH_CONTINUATION_FAILED_WARNING = "Member was cut off due to output length again after one automatic continuation. Automatic continuation stopped to avoid a loop; please send a new instruction if you want them to continue.";

function isLengthStopReason(stopReason: unknown): boolean {
  if (typeof stopReason !== "string") return false;
  const normalized = stopReason.toLowerCase();
  return normalized === "length" || normalized.includes("max_tokens") || normalized.includes("max_output");
}

const ROOM_MARKER = "[room]";

/**
 * Extract the room-bound portion of an assistant text per the [room] marker rule.
 * Scans backwards for the LAST *legal* marker — `[room]` immediately followed by a
 * newline — and returns the trimmed content after it. Occurrences of `[room]` with
 * no following newline (bare/inline mentions) are not markers and are skipped, so
 * talking about the feature inside a message cannot swallow the real one.
 * Content before the marker never reaches the room.
 */
export function extractRoomMarkerText(text: string): string | null {
  if (!text) return null;
  let searchFrom = text.length;
  while (searchFrom > 0) {
    const idx = text.lastIndexOf(ROOM_MARKER, searchFrom - 1);
    if (idx === -1) return null;
    const after = text.slice(idx + ROOM_MARKER.length);
    if (after.startsWith("\n") || after.startsWith("\r\n")) {
      const body = after.replace(/^\r?\n/, "").trim();
      return body.length > 0 ? body : null;
    }
    // Not a legal marker (no newline right after) — keep scanning earlier occurrences.
    searchFrom = idx;
  }
  return null;
}

function drainQueuedInputsAsPrompt(instance: AgentInstance, trigger: string): void {
  if (instance.queuedInputs.length === 0) return;
  if (instance.status === "working" || instance.dispatchState !== "idle") return;
  const queued = instance.queuedInputs.splice(0);
  const message = queued.join("\n\n");
  logger.info("agent", "drainQueuedInputsAsPrompt", { member: instance.agentName, count: queued.length, trigger });
  void runPrompt(instance, message, "queued", (err) => {
    logger.error("agent", "queued prompt error", { member: instance.agentName, error: formatRuntimeErrorMessage(err) });
    postMessage(instance.roomId, "system", `Member "${instance.agentName}" error: ${formatRuntimeErrorMessage(err)}`);
  });
}

async function maybeRunLengthContinuation(instance: AgentInstance, trigger: string, opts: { skipChatWarning?: boolean } = {}): Promise<boolean> {
  if (!instance.lengthContinuationPending || opts.skipChatWarning) return false;
  instance.lengthContinuationPending = false;
  if (instance.lengthContinuationAttempted) {
    instance.lastMessageEndWasLength = false;
    clearPendingChatReply(instance, "length_continuation_loop_guard");
    logger.warn("agent", "lengthContinuationLoopGuard", { member: instance.agentName, roomId: instance.roomId, trigger });
    postMessage(instance.roomId, "system", `Member "${instance.agentName}" ${LENGTH_CONTINUATION_FAILED_WARNING}`);
    return true;
  }
  instance.lengthContinuationAttempted = true;
  instance.lastMessageEndWasLength = false;
  markPendingChatReply(instance, "length_continuation");
  logger.warn("agent", "lengthContinuationPrompt", { member: instance.agentName, roomId: instance.roomId, trigger });
  await runPrompt(instance, LENGTH_CONTINUATION_PROMPT, "length_continuation", (err) => {
    logger.error("agent", "length continuation prompt error", { member: instance.agentName, error: formatRuntimeErrorMessage(err) });
  });
  return true;
}

async function finalizePromptSettlement(instance: AgentInstance, trigger: string, opts: { skipChatWarning?: boolean } = {}): Promise<void> {
  updateDispatchState(instance, "idle", trigger);
  applyPendingAfterPromptSettlement(instance, trigger);
  if (instance.queuedInputs.length > 0) {
    drainQueuedInputsAsPrompt(instance, trigger);
    return;
  }
  if (await maybeRunLengthContinuation(instance, trigger, opts)) return;
  if (instance.pendingChatReply && !opts.skipChatWarning && !instance.hadErrorInTurn) {
    // Silence-visible: a turn ended without a chat reply. Do NOT run a hidden
    // follow-up prompt (that masked real failures and swallowed their events).
    // Post an honest system note so the user sees the silence and decides.
    clearPendingChatReply(instance, "silence_visible");
    logger.warn("agent", "memberSilent", { member: instance.agentName, roomId: instance.roomId, trigger });
    postMessage(instance.roomId, "system", `Member "${instance.agentName}" finished without replying.`);
  }
}

async function runPrompt(
  instance: AgentInstance,
  message: string,
  trigger: string,
  onError: (err: unknown) => void,
): Promise<void> {
  updateDispatchState(instance, "promptSubmitted", trigger);
  instance.promptInFlight = true;
  instance.hadErrorInTurn = false;
  instance.lastMessageEndWasLength = false;
  instance.lengthContinuationPending = false;
  if (trigger !== "length_continuation") instance.lengthContinuationAttempted = false;
  try {
    await instance.handle.prompt(message);
    instance.promptInFlight = false;
    await finalizePromptSettlement(instance, `${trigger}_prompt_resolved`, { skipChatWarning: instance.dispatchState === "aborting" });
  } catch (err: any) {
    instance.promptInFlight = false;
    onError(err);
    updateDispatchState(instance, "idle", `${trigger}_prompt_error`);
    instance.queuedInputs = [];
  }
}

function normalizeSwitchModelRef(model: string): string {
  return normalizeModelRef(model.trim());
}

/** Apply model/credential switch immediately via setModel + models.json refresh.
 * Credentials are live-read per request (MemberCredentialStore), so no session
 * recreate and no end-of-turn queue — next model call uses the new binding.
 *
 * Cross-provider: setModel auth-checks the *new* provider before room.json is
 * updated, so we install an instance-level credential override first. On failure
 * the override is rolled back and the room binding is never touched. */
async function applyModelSwitchToInstance(
  instance: AgentInstance,
  pending: { model: string; credentialId?: string },
  trigger: string,
): Promise<void> {
  const model = normalizeSwitchModelRef(pending.model);
  const credentialId = pending.credentialId;
  const exported = exportPiConfigForMember({
    roomId: instance.roomId,
    memberName: instance.memberId,
    modelRef: model,
    credentialId,
  });
  if (!exported) throw new Error(`No model credentials configured for ${model}`);
  const resolvedCredentialId = exported.profile?.id || credentialId;
  if (!resolvedCredentialId) throw new Error(`No model credentials configured for ${model}`);

  if (!instance.handle.setModel) throw new Error("Runtime does not support dynamic model switching");

  // Pin the target credential so setModel's checkAuth(newProvider) resolves
  // before room.json commits the binding (2026-07-30 QA cross-provider block).
  const previousOverride = getMemberActiveCredentialOverride(instance.roomId, instance.memberId);
  setMemberActiveCredentialOverride(instance.roomId, instance.memberId, resolvedCredentialId);
  try {
    if (instance.handle.refreshModelRegistry) {
      // models.json was just rewritten locally — reload disk only, never hang on network.
      // Timeout is a hard backstop if the SDK availability pass stalls.
      try {
        await withTimeout(
          Promise.resolve(instance.handle.refreshModelRegistry({ allowNetwork: false })),
          CREDENTIAL_REFRESH_TIMEOUT_MS,
          "model registry refresh",
        );
      } catch (refreshErr) {
        logger.warn("agent", "modelSwitchRegistryRefreshDegraded", {
          member: instance.agentName,
          roomId: instance.roomId,
          model,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
          trigger,
        });
        // Continue to setModel — the model may already be in the in-memory registry
        // (export writes all enabled providers). If not, setModel will throw clearly.
      }
    }
    await instance.handle.setModel(model);
  } catch (err) {
    setMemberActiveCredentialOverride(instance.roomId, instance.memberId, previousOverride ?? null);
    throw err;
  }

  if (instance.handle.runtimeParams) {
    instance.handle.runtimeParams.model = model;
    instance.handle.runtimeParams.credentialId = resolvedCredentialId;
    instance.handle.runtimeParams.credentialName = exported.profile?.name;
  }
  instance.appliedModel = model;
  instance.appliedCredentialId = resolvedCredentialId;
  logger.info("agent", "modelSwitchApplied", { member: instance.agentName, roomId: instance.roomId, model, trigger });
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: instance.status });
}

/** If the live instance drifted from the room binding, re-apply (or destroy so the next create is clean). */
async function ensureInstanceMatchesBinding(instance: AgentInstance, member: { model?: string; credentialId?: string } | null, trigger: string): Promise<AgentInstance | null> {
  if (!member?.model) return instance;
  const desiredModel = normalizeSwitchModelRef(member.model);
  const desiredCred = member.credentialId || undefined;
  const appliedModel = instance.appliedModel ? normalizeSwitchModelRef(instance.appliedModel) : "";
  const modelMismatch = appliedModel !== desiredModel;
  const credMismatch = (instance.appliedCredentialId || undefined) !== desiredCred;
  if (!modelMismatch && !credMismatch) return instance;
  if (!instance.handle.setModel) {
    // Runtime cannot hot-switch — rebuild from the binding.
    destroyInstance(instance.roomId, instance.memberId);
    return null;
  }
  try {
    await applyModelSwitchToInstance(instance, { model: desiredModel, credentialId: desiredCred }, trigger);
    return instance;
  } catch (err) {
    logger.warn("agent", "bindingHealFailed", {
      member: instance.agentName,
      roomId: instance.roomId,
      appliedModel: instance.appliedModel,
      desiredModel,
      error: String(err),
      trigger,
    });
    destroyInstance(instance.roomId, instance.memberId);
    return null;
  }
}

async function applyThinkingSwitchToInstance(instance: AgentInstance, pending: PendingThinkingSwitch, trigger: string): Promise<void> {
  if (!instance.handle.setThinkingLevel) throw new Error("Runtime does not support dynamic thinking level switching");
  await instance.handle.setThinkingLevel(pending.thinkingLevel);
  if (instance.handle.runtimeParams) instance.handle.runtimeParams.thinkingLevel = pending.thinkingLevel;
  logger.info("agent", "thinkingSwitchApplied", { member: instance.agentName, roomId: instance.roomId, thinkingLevel: pending.thinkingLevel, trigger });
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: instance.status });
}

function applyPendingThinkingSwitch(instance: AgentInstance, trigger: string): void {
  const pending = instance.pendingThinkingSwitch;
  if (!pending) return;
  instance.pendingThinkingSwitch = undefined;
  applyThinkingSwitchToInstance(instance, pending, trigger).catch((err) => {
    logger.error("agent", "thinkingSwitchFailed", { member: instance.agentName, roomId: instance.roomId, error: String(err) });
    postMessage(instance.roomId, "system", `Failed to switch thinking level for "${instance.agentName}": ${err.message || String(err)}`);
  });
}

function instanceUsesCredentialProfile(instance: AgentInstance, profileId: string): boolean {
  return instance.appliedCredentialId === profileId;
}

function dropInstanceAfterCredentialUnavailable(instance: AgentInstance, reason: string): void {
  const key = instanceKey(instance.roomId, instance.memberId);
  if (instances.get(key) === instance) instances.delete(key);
  contextUsageCache.delete(key);
  contextCompactionWarningCache.delete(key);
  setMemberActiveCredentialOverride(instance.roomId, instance.memberId, null);
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

async function applyCredentialRefreshToInstance(instance: AgentInstance, pending: PendingCredentialRefresh, trigger: string): Promise<void> {
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
    await instance.handle.setModel(instance.appliedModel);
    if (instance.handle.runtimeParams) {
      instance.handle.runtimeParams.model = instance.appliedModel;
      instance.handle.runtimeParams.credentialId = exported.profile?.id || instance.appliedCredentialId;
      instance.handle.runtimeParams.credentialName = exported.profile?.name;
    }
    instance.appliedCredentialId = exported.profile?.id || instance.appliedCredentialId;
    if (instance.appliedCredentialId) {
      setMemberActiveCredentialOverride(instance.roomId, instance.memberId, instance.appliedCredentialId);
    }
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

  // Single message → single-message envelope.
  if (items.length === 1) {
    return wrapRoomContextMessage(items[0].msg, roomName, items[0].role);
  }

  // Multiple messages → shared transcript envelope (each message keeps its own
  // full sub-header with seq + timestamp so it can be referenced individually).
  return wrapRoomMessagesTranscript(
    items.map((i) => ({ msg: i.msg, role: i.role })),
    roomName,
  );
}

// Resolve skills: member config > agent definition > empty
function resolveSkills(member: AgentMemberConfig, agentDef: { skills?: string[] }): string[] {
  return member.skills ?? agentDef.skills ?? [];
}

// -- Instance creation --

async function getOrCreate(roomId: string, memberRef: string): Promise<AgentInstance | null> {
  const room = roomStore.getRoom(roomId);
  if (!room) {
    logger.error("agent", "room not found", { roomId });
    return null;
  }

  let member = resolveRoomMember(roomId, memberRef);
  if (!member) {
    logger.error("agent", "no member or agent definition found", { name: memberRef });
    return null;
  }
  // 0.20 G3 cutover: overlay global effective-config via ID link (sourceMemberId / globalMemberIds),
  // never free find-by-name (rename-safe). Unified switches + scope overrides live on the registry.
  try {
    const globalId = roomStore.resolveGlobalMemberId(room, member);
    if (globalId) {
      const eff = getEffectiveConfig(globalId, roomScopeId(roomId));
      member = {
        ...member,
        model: eff.model || member.model,
        credentialId: eff.credentialId || member.credentialId,
        thinkingLevel: (eff.thinkingLevel as string) || member.thinkingLevel,
        skills: eff.skills?.length ? eff.skills : member.skills,
        extensions: eff.extensions?.length ? eff.extensions : member.extensions,
        mcpServers: eff.mcpServers?.length ? eff.mcpServers : member.mcpServers,
      };
    }
  } catch (err) {
    logger.warn("agent", "effective-config overlay skipped", { member: member.name, error: String(err) });
  }
  if (!isMemberConfigured(member)) {
    logger.error("agent", "member unconfigured", { member: member.name, memberId: member.id });
    return null;
  }
  const memberId = member.id;
  const memberName = member.name;
  const key = instanceKey(roomId, memberId);
  const existing = instances.get(key);
  if (existing) return existing;

  const pending = pendingCreations.get(key);
  if (pending) return pending;

  const creation = (async (): Promise<AgentInstance | null> => {
    if (!registry) {
      logger.error("agent", "runtime registry not initialized");
      return null;
    }

    logger.info("agent", "getOrCreate", { member: memberName, memberId, roomId, found: false });
    logger.info("agent", "loadMember", { member: memberName, memberId, source: "room-effective", agent: member.agent, runtime: member.runtime, model: member.model, thinkingLevel: member.thinkingLevel });

    // 0.20: agent definition from global pool (templates/agents + ~/.bossmode/agents), live read.
    const agentDef = loadAgentDefinition(member.agent);
    if (!agentDef) {
      logger.error("agent", "agent definition not found", { member: memberName, agent: member.agent, roomId });
      return null;
    }

    const runtime = registry.get(member.runtime);
    if (!runtime) {
      logger.error("agent", "runtime not found", { member: memberName, runtime: member.runtime });
      return null;
    }

    const docsRootPath = join(getBossmodeDir(), "knowledge", "docs");
    const compiled = compileMemberPrompt({ room, member, agentDef, docsRoot: docsRootPath });

    // Resolve skills: member config takes precedence over agent definition; global skills pool only.
    const skills = resolveSkills(member, agentDef);
    const skillPaths = [
      ...resolveGlobalSkillPaths(skills),
      ...resolveMemberExtensionSkillPaths(member.extensions),
    ];

    // Session resume (global toggle; default true for backward compatibility)
    let sessionResumeEnabled = true;
    try {
      const config = readConfig();
      sessionResumeEnabled = (config.runtime?.sessionResume ?? (config as any).sessionResume) !== false;
    } catch {
      sessionResumeEnabled = true;
    }

    const sessions = sessionStore.getSessions(roomId);
    const savedSession = sessions[memberId];
    const resumeSession = (sessionResumeEnabled && savedSession)
      ? { sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile }
      : undefined;
    if (resumeSession) {
      logger.info("agent", "resumeSession", { member: memberName, runtime: member.runtime, sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile });
    }

    try {
      const handle = await runtime.createAgent({
        cwd: room.cwd,
        roomId,
        member,
        agentPrompt: compiled.agentPrompt,
        envPrompt: compiled.envPrompt,
        appendSystemPrompt: compiled.appendSystemPrompt,
        skillPaths,
        skillNames: skills,
        roomMembers: room.members,
        resumeSession,
        onSessionChanged: (session) => {
          sessionStore.saveSession(roomId, memberId, {
            runtime: member.runtime,
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
          });
          logger.info("agent", "sessionSaved", { member: memberName, memberId, sessionId: session.sessionId, sessionFile: session.sessionFile });
        },
        callbacks: {
          onChat: async (message: string) => {
            postMessage(roomId, memberName, message, [], { senderMemberId: memberId });
            const active = instances.get(key);
            if (active) clearPendingChatReply(active, "callback:response");
          },
          onMention: async (targetMember: string, message: string) => {
            // Mention activation is handled by router listener via message-bus.
            const target = roomStore.resolveRoomMemberRef(roomId, targetMember);
            postMessage(roomId, memberName, message, [targetMember], { senderMemberId: memberId, mentionMemberIds: target ? [target.id] : [] });
            const active = instances.get(key);
            if (active) clearPendingChatReply(active, "callback:mention");
          },
        },
      });

      logger.info("agent", "agentCreated", { member: memberName, agent: member.agent, runtime: member.runtime, roomId });

      const instance: AgentInstance = {
        handle,
        scopeId: roomScopeId(roomId),
        roomId,
        memberId,
        agentName: memberName,
        sourceAgent: member.agent,
        status: "idle",
        dispatchState: "idle",
        promptInFlight: false,
        queuedInputs: [],
        pendingChatReply: false,
        hadErrorInTurn: false,
        lastMessageEndWasLength: false,
        lengthContinuationPending: false,
        lengthContinuationAttempted: false,
        compacting: false,
        turnActive: false,
        unsubscribe: () => {},
        eventBuffer: [],
        appliedModel: member.model ? normalizeSwitchModelRef(member.model) : "",
        appliedCredentialId: member.credentialId,
      };

      wireInstanceEvents(instance, key, roomId, memberName, memberId);

      instances.set(key, instance);
      return instance;
    } catch (err: any) {
      logger.error("agent", `failed to create agent`, { member: memberName, agent: member.agent, runtime: member.runtime, error: formatRuntimeErrorMessage(err) });
      postMessage(roomId, "system", `Failed to create member "${memberName}": ${formatRuntimeErrorMessage(err)}`);
      return null;
    }
  })();

  pendingCreations.set(key, creation);
  try {
    return await creation;
  } finally {
    if (pendingCreations.get(key) === creation) pendingCreations.delete(key);
  }
}

// -- Activation --

export async function activateAgent(roomId: string, memberRef: string): Promise<void> {
  return activateAgentInternal(roomId, memberRef, { source: "room_mention", replyDebt: true, trigger: "activate" });
}

async function activateAgentInternal(
  roomId: string,
  memberRef: string,
  opts: { source: "room_mention" | "private_instruction" | "system"; replyDebt: boolean; trigger: string; banner?: string; urgent?: boolean },
): Promise<void> {
  const member = resolveRoomMember(roomId, memberRef);
  const memberName = member?.name || memberRef;
  const memberId = member?.id || memberRef;
  logger.info("agent", "activateAgent", { roomId, member: memberName, memberId });

  if (member && !isMemberConfigured(member)) {
    postMessage(roomId, "system", memberUnconfiguredMessage(memberName));
    return;
  }

  const instanceRaw = await getOrCreate(roomId, memberId);
  const instance = instanceRaw
    ? await ensureInstanceMatchesBinding(instanceRaw, member, "activate-heal")
    : null;
  if (!instance) {
    // Heal may have destroyed a desynced instance — try one clean create.
    const recreated = await getOrCreate(roomId, memberId);
    if (!recreated) {
      postMessage(roomId, "system", `Failed to activate member "${memberName}": not found or runtime unavailable.`);
      return;
    }
    // Fresh create is built from the binding; no second heal needed.
    return activateAgentInternalContinue(roomId, memberName, memberId, member, recreated, opts);
  }

  return activateAgentInternalContinue(roomId, memberName, memberId, member, instance, opts);
}

async function activateAgentInternalContinue(
  roomId: string,
  memberName: string,
  memberId: string,
  member: ReturnType<typeof resolveRoomMember>,
  instance: AgentInstance,
  opts: { source: "room_mention" | "private_instruction" | "system"; replyDebt: boolean; trigger: string; banner?: string; urgent?: boolean },
): Promise<void> {
  const cursors = roomStore.getCursors(roomId);
  const lastCursor = cursors[memberId] ?? cursors[memberName] ?? null;
  const allNewMessages = getMessagesSince(roomId, lastCursor);
  const latestId = getLatestMessageId(roomId);
  if (latestId) roomStore.setCursor(roomId, memberId, latestId);
  if (allNewMessages.length === 0) return;

  // Context limit
  const contextLimit = (member as any)?.contextLimit || 50;
  const visibleMessages = filterAgentVisibleMessages(allNewMessages, memberName);
  if (visibleMessages.length === 0) return;
  const newMessages = visibleMessages.length > contextLimit
    ? visibleMessages.slice(-contextLimit)
    : visibleMessages;

  logger.info("agent", "incrementalMessages", { member: memberName, count: newMessages.length, total: allNewMessages.length, filtered: allNewMessages.length - visibleMessages.length, cursorFrom: lastCursor });

  const formattedMessages = formatMessagesForAgent(roomId, newMessages, memberName, roomStore.getRoom(roomId)?.name || roomId);
  const payload = opts.banner ? `${opts.banner}\n\n${formattedMessages}` : formattedMessages;

  setActivationSource(roomId, memberId, opts.source);
  if (opts.replyDebt) markPendingChatReply(instance, opts.trigger);

  // Urgent interrupt: never steer (that would queue behind the turn we just
  // aborted) — park at the FRONT of the queue so the payload runs the moment
  // the current dispatch settles (abort landing / compaction finishing).
  if (opts.urgent && (instance.compacting || instance.status === "working" || instance.dispatchState !== "idle")) {
    instance.queuedInputs.unshift(payload);
    logger.info("agent", "urgentQueuedFront", { member: memberName, memberId, roomId, trigger: opts.trigger, queueDepth: instance.queuedInputs.length });
    return;
  }

  if (instance.compacting) {
    queueInput(instance, payload, opts.trigger);
    return;
  }

  if (instance.status === "working") {
    instance.handle.steer(payload);
    return;
  }

  if (instance.dispatchState !== "idle") {
    queueInput(instance, payload, opts.trigger);
    return;
  }

  logger.info("agent", "prompt", { member: memberName, messageLength: payload.length, trigger: opts.trigger });
  await runPrompt(instance, payload, opts.trigger, (err) => {
    logger.error("agent", `prompt error`, { member: memberName, error: formatRuntimeErrorMessage(err) });
    postMessage(roomId, "system", `Member "${memberName}" error: ${formatRuntimeErrorMessage(err)}`);
  });
}

// -- @all broadcast --

export async function activateAll(roomId: string): Promise<void> {
  const room = roomStore.getRoom(roomId);
  if (!room) return;
  const activations = roomStore.getRoomMembers(roomId).map((member) => {
    const key = instanceKey(roomId, member.id);
    const instance = instances.get(key);
    if (instance && (instance.status === "working" || instance.dispatchState !== "idle")) return Promise.resolve();
    return activateAgent(roomId, member.id);
  });
  await Promise.allSettled(activations);
}

// -- Model switching --

/**
 * Persist a model binding to the 0.20 authority — the member registry (F4,
 * 2026-08-04). unifiedModel=true → the member's global binding; false → this
 * room's scope override. The pre-0.20 room.json memberOverrides write was
 * invisible to every read side (display / effective-config / activate-heal),
 * which produced "switch works once, display shows old, heal silently rolls
 * back". Legacy non-mem_ rooms still persist to memberOverrides — that is the
 * only authority their read side (name-keyed overrides) consults.
 */
export interface RoomMemberConfigPatch {
  model?: string | null;
  credentialId?: string | null;
  thinkingLevel?: string | null;
  mcpServers?: string[] | null;
  extensions?: string[] | null;
  skills?: string[] | null;
}

/** Split a config patch by the member's unified flags (same grouping as
 * getEffectiveConfig): model/credentialId/thinkingLevel ← unifiedModel;
 * skills/extensions/mcpServers ← unifiedExtensions. Mixed members split
 * across both writes. */
function splitPatchByUnifiedFlags(rec: { unifiedModel: boolean; unifiedExtensions: boolean }, patch: RoomMemberConfigPatch): { globalPatch: Record<string, unknown>; scopePatch: Record<string, unknown> } {
  const globalPatch: Record<string, unknown> = {};
  const scopePatch: Record<string, unknown> = {};
  for (const key of ["model", "credentialId", "thinkingLevel"] as const) {
    if (key in patch) (rec.unifiedModel ? globalPatch : scopePatch)[key] = patch[key];
  }
  for (const key of ["mcpServers", "extensions", "skills"] as const) {
    if (key in patch) (rec.unifiedExtensions ? globalPatch : scopePatch)[key] = patch[key];
  }
  return { globalPatch, scopePatch };
}

/**
 * Persist a room-member config patch to the 0.20 authority — the member
 * registry (F4, 2026-08-04). Routing follows the member's unified flags.
 * The pre-0.20 room.json memberOverrides write is invisible to every read
 * side for mem_* members (display / effective-config / activate-heal) —
 * "applies once, display stale, heal rolls back". Legacy non-mem_ rooms
 * keep memberOverrides (the only authority their read side consults).
 */
function persistConfigPatch(roomId: string, memberId: string, patch: RoomMemberConfigPatch): void {
  if (memberId.startsWith("mem_")) {
    try {
      applyMemberConfigPatch(memberId, scopeIdOf({ kind: "room", roomId }), patch as Record<string, unknown>);
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
export function clearMemberModelBinding(roomId: string, memberRef: string): void {
  persistRoomMemberConfigPatch(roomId, memberRef, { model: null, credentialId: null });
}

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

export async function switchMemberModel(roomId: string, memberRef: string, model: string, credentialId?: string | null, persistRoomOverride = true): Promise<{ applied: boolean; pending: boolean; active: boolean; model: string }> {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const normalizedModel = normalizeSwitchModelRef(model);
  assertModelAvailable(normalizedModel, "switchMemberModel");

  // Pre-validate the target binding can export (writes models.json for the member runtime dir).
  // Do NOT touch room.json yet — binding commits only after the live instance accepts the switch.
  const exported = exportPiConfigForMember({
    roomId,
    memberName: memberId,
    modelRef: normalizedModel,
    credentialId: credentialId || undefined,
  });
  if (!exported) throw new Error(`No model credentials configured for ${normalizedModel}`);

  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);

  if (instance) {
    // Apply first (refresh registry + setModel). On failure the room binding stays unchanged.
    await applyModelSwitchToInstance(instance, { model: normalizedModel, credentialId: credentialId || undefined }, "switchMemberModel");
  }

  // Commit binding only after a successful apply (or when no live instance needs applying).
  if (persistRoomOverride) {
    persistConfigPatch(roomId, memberId, { model: normalizedModel, credentialId: credentialId || null });
  }

  return { applied: Boolean(instance), pending: false, active: Boolean(instance), model: normalizedModel };
}

export async function switchMemberThinkingLevel(roomId: string, memberRef: string, thinkingLevel: string): Promise<{ applied: boolean; pending: boolean; active: boolean; thinkingLevel: string }> {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const memberName = member?.name || memberRef;
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);
  if (!instance) return { applied: false, pending: false, active: false, thinkingLevel };

  const pending = { thinkingLevel };
  if (instance.status === "working" || instance.dispatchState !== "idle") {
    instance.pendingThinkingSwitch = pending;
    logger.info("agent", "thinkingSwitchQueued", { member: memberName, memberId, roomId, thinkingLevel, status: instance.status, dispatchState: instance.dispatchState });
    return { applied: false, pending: true, active: true, thinkingLevel };
  }

  await applyThinkingSwitchToInstance(instance, pending, "switchMemberThinkingLevel");
  return { applied: true, pending: false, active: true, thinkingLevel };
}

export async function switchMemberModelInActiveRooms(memberName: string, model: string, credentialId?: string | null): Promise<Array<{ roomId: string; applied: boolean; pending: boolean; active: boolean; model: string }>> {
  const rooms = Array.from(instances.values())
    .filter((instance) => instance.agentName === memberName && !roomStore.hasRoomMemberModelOverride(instance.roomId, memberName))
    .map((instance) => instance.roomId);
  if (rooms.length === 0) return [];
  const results = [];
  for (const roomId of rooms) results.push({ roomId, ...(await switchMemberModel(roomId, memberName, model, credentialId, false)) });
  return results;
}

// -- Status --

export function getAgentStatus(roomId: string, memberRef: string): AgentStatus {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const instance = instances.get(instanceKey(roomId, memberId));
  if (!instance) return "inactive";
  return instance.status;
}

export function getMemberBusyState(roomId: string, memberRef: string): { busy: boolean; reason?: string } {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const key = instanceKey(roomId, memberId);
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

// -- Member status report (member_status tool) --

export interface MemberStatusEntry {
  name: string;
  memberId: string;
  /** Aggregated across live instances: working > idle > inactive (no live instance). */
  status: AgentStatus;
  /** Live instances only: which scopes this member is active in, with per-scope status. */
  activeScopes: Array<{ scope: string; status: AgentStatus }>;
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
    let status: AgentStatus = "inactive";
    for (const inst of instances.values()) {
      // Match by global id (DM scopes) or by room-local id/name (room scopes)
      let match = false;
      let scopeLabel: string;
      if (inst.scopeId.startsWith("dm:")) {
        match = inst.memberId === m.id || inst.memberId === gid || inst.scopeId === `dm:${gid}`;
        scopeLabel = "dm";
      } else {
        const r = roomStore.getRoom(inst.roomId);
        if (!r) continue;
        const local = roomStore.getRoomMembers(r.id).find((rm) => rm.id === inst.memberId || rm.name === inst.agentName);
        if (!local) continue;
        match = roomStore.resolveGlobalMemberId(r, local) === gid || inst.memberId === m.id;
        scopeLabel = r.id === roomId && thisRoom ? `room: ${thisRoom.name}` : `room: ${r.name}`;
      }
      if (!match) continue;
      activeScopes.push({ scope: scopeLabel, status: inst.status });
      if (inst.status === "working") status = "working";
      else if (status === "inactive") status = "idle";
    }
    return { name: m.name, memberId: m.id, status, activeScopes };
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
  const key = instanceKey(roomId, memberId);
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
  const key = instanceKey(roomId, memberId);
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
  const key = instanceKey(roomId, memberId);
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
    setTimeout(() => refreshContextUsageOnce(roomId, memberRef, options), delay * i);
  }
}

export const refreshContextUsageOnIdle = refreshContextUsage;

// -- Event history --

export function getAgentEventHistory(roomId: string, memberRef: string): AgentHistoryEvent[] {
  const member = resolveRoomMember(roomId, memberRef);
  return loadEventsFromDisk(roomId, member?.id || memberRef);
}

function emitAgentLocalEvent(roomId: string, memberRef: string, event: AgentHistoryEvent): void {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const agentName = member?.name || memberRef;
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);
  if (instance) instance.eventBuffer.push(event);
  try { appendEventToDisk(roomId, memberId, event); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, memberId, error: String(err) }); }
  broadcastToAgentSubscribers(roomId, agentName, {
    type: "agent:event",
    roomId,
    agent: agentName,
    memberId,
    event,
  });
}

// -- Steer --

export async function steerAgent(roomId: string, memberRef: string, instruction: string): Promise<void> {
  const preResolved = resolveRoomMember(roomId, memberRef);
  if (preResolved && !isMemberConfigured(preResolved)) {
    throw new Error(memberUnconfiguredMessage(preResolved.name));
  }
  const instance = await getOrCreate(roomId, memberRef);
  const agentName = instance?.agentName || memberRef;
  if (!instance) throw new Error(`Cannot steer agent "${agentName}": not found`);

  const steerEvent: AgentHistoryEvent = { type: "user_steer", text: instruction };
  instance.eventBuffer.push(steerEvent);
  try { appendEventToDisk(roomId, instance.memberId, steerEvent); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, memberId: instance.memberId, error: String(err) }); }

  // Slash commands (e.g. /compact, /model) are transparently forwarded to the runtime.
  // Plain instructions are sent as-is — the private-message envelope and reply footer
  // were removed along with private chat (stream 1 envelope normalization).
  const isSlashCommand = instruction.startsWith('/');
  const userMessage = instruction;

  setActivationSource(roomId, instance.memberId, isSlashCommand ? "system" : "private_instruction");

  if (instance.compacting) {
    queueInput(instance, userMessage, "steer");
    return;
  }

  if (instance.status === "working") {
    instance.handle.steer(userMessage);
    return;
  }

  if (instance.dispatchState !== "idle") {
    queueInput(instance, userMessage, "steer");
    return;
  }

  await runPrompt(instance, userMessage, "steer", (err) => {
    logger.error("agent", "steer error", { agent: agentName, error: formatRuntimeErrorMessage(err) });
  });
}

// -- Abort --

export function abortAgent(roomId: string, memberRef: string): { ok: boolean; action: string } {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const memberName = member?.name || memberRef;
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);
  if (!instance) return { ok: false, action: "not_found" };
  if (instance.status !== "working" && instance.dispatchState === "idle") return { ok: true, action: "already_idle" };

  // Stop is the sole abort entry. If blocked in wait(), settle it SYNCHRONOUSLY first
  // so the tool call can return mention_interrupt before the turn is torn down.
  try { settleWaitOnAbort(roomId, memberId); } catch { /* ignore */ }

  // Abort via stdin protocol, keep instance alive. Public idle waits for runtime agent_end.
  instance.handle.abort();
  updateDispatchState(instance, "aborting", "abort");
  instance.queuedInputs = [];
  logger.info("agent", "aborted", { member: memberName, memberId, roomId });
  return { ok: true, action: "aborted" };
}

/**
 * Urgent `!name` gesture (fish 2026-08-04): interrupt the target and deliver
 * the message immediately as a new turn.
 * - no live instance / fully idle → same straight-through as @ (nothing to
 *   abort, no banner)
 * - working → abort with Stop's primitive, but KEEP queued steered inputs
 *   (interruption, not a full stop); the urgent payload goes to the FRONT of
 *   the queue so it becomes the new turn the moment the aborted turn settles;
 *   payload carries the interrupt banner so the member knows its turn was cut
 *   (activation-source transparency — no illusion of continuing)
 * - compacting / dispatch-busy → not safely abortable; queue front, no banner,
 *   compaction is never hard-killed
 * A sender=system room notice records every interrupt (user-visible; members
 * never see system notices per the rc.5 filter).
 */
export async function interruptAgent(roomId: string, memberRef: string, urgentByName: string): Promise<{ ok: boolean; action: string }> {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const memberName = member?.name || memberRef;
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);

  if (!instance || (instance.status !== "working" && instance.dispatchState === "idle")) {
    await activateAgentInternal(roomId, memberId, { source: "room_mention", replyDebt: true, trigger: "urgent_interrupt" });
    return { ok: true, action: "activated" };
  }

  if (instance.status === "working") {
    const banner = `[INTERRUPTED] Your previous turn was aborted by an urgent message (!${memberName}) from ${urgentByName}. That turn may have left partial work — verify its state before building on it.`;
    try { settleWaitOnAbort(roomId, memberId); } catch { /* ignore */ }
    instance.handle.abort();
    updateDispatchState(instance, "aborting", "urgent_interrupt");
    postMessage(roomId, "system", `Member "${memberName}"'s current turn was aborted by an urgent message from ${urgentByName}.`);
    logger.info("agent", "urgentInterruptAbort", { member: memberName, memberId, roomId, urgentBy: urgentByName });
    await activateAgentInternal(roomId, memberId, { source: "room_mention", replyDebt: true, trigger: "urgent_interrupt", banner, urgent: true });
    return { ok: true, action: "interrupted" };
  }

  // Compacting or dispatch-busy (e.g. prompt settling): queue front, no abort.
  await activateAgentInternal(roomId, memberId, { source: "room_mention", replyDebt: true, trigger: "urgent_interrupt", urgent: true });
  return { ok: true, action: "queued_front" };
}

// -- Instance management --

export function getMemberInstances(memberName: string): Array<{
  roomId: string;
  roomName: string;
  status: AgentStatus;
  runtime: string;
  pid?: number;
  spawnArgs?: string[];
  runtimeParams?: import("./runtime/types.js").AgentRuntimeParams;
}> {
  const result: Array<{ roomId: string; roomName: string; status: AgentStatus; runtime: string; pid?: number; spawnArgs?: string[]; runtimeParams?: import("./runtime/types.js").AgentRuntimeParams }> = [];
  for (const [key, instance] of instances) {
    if (instance.agentName === memberName || instance.memberId === memberName) {
      const roomId = key.split(":")[0];
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
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);
  if (!instance) {
    return { ok: true, reloaded: false, message: "Member is not running. Latest configuration will apply on next activation." };
  }
  if (instance.status === "working" || instance.dispatchState !== "idle" || instance.promptInFlight) {
    throw new Error("Member is busy. Reload when the current turn is idle.");
  }
  if (!instance.handle.reloadResources) throw new Error("Runtime does not support in-place reload.");

  const agentDef = loadAgentDefinition(member.agent);
  if (!agentDef) throw new Error(`Agent definition not found: ${member.agent}`);
  const docsRootPath = join(getBossmodeDir(), "knowledge", "docs");
  const compiled = compileMemberPrompt({ room, member, agentDef, docsRoot: docsRootPath });
  const skills = resolveSkills(member, agentDef);
  const skillPaths = [
    ...resolveGlobalSkillPaths(skills),
    ...resolveMemberExtensionSkillPaths(member.extensions),
  ];

  await instance.handle.reloadResources({
    roomId,
    member,
    agentPrompt: compiled.agentPrompt,
    appendSystemPrompt: compiled.appendSystemPrompt,
    skillPaths,
    skillNames: skills,
  });
  emitAgentLocalEvent(roomId, memberId, { type: "system", text: "Reloaded member resources in place." });
  logger.info("agent", "member resources reloaded", { roomId, member: member.name, memberId, skills: skills.length });
  return { ok: true, reloaded: true, message: "Reloaded latest prompt, skills and tools in place." };
}

export function resetAgentSession(roomId: string, memberRef: string): { ok: true; message: string } {
  const resolved = resolveRoomMember(roomId, memberRef);
  const memberId = resolved?.id || memberRef;
  const agentName = resolved?.name || memberRef;
  const sessions = sessionStore.getSessions(roomId);
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);
  const runtime = sessions[memberId]?.runtime || instance?.handle.runtimeName || "pi-cli";

  destroyInstance(roomId, memberId);
  clearActivationSource(roomId, memberId);
  sessionStore.clearSession(roomId, memberId, runtime);
  roomStore.setCursor(roomId, memberId, null);
  if (memberId !== agentName) {
    sessionStore.deleteSessionEntry(roomId, agentName);
    roomStore.deleteCursor(roomId, agentName);
  }

  const message = "Session reset. Next activation will start fresh.";
  emitAgentLocalEvent(roomId, memberId, { type: "system", text: message });
  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: agentName, ...memberIdentityMeta(agentName, memberId), status: "inactive" });
  return { ok: true, message };
}

export function destroyInstance(roomId: string, memberRef: string): void {
  const resolved = resolveRoomMember(roomId, memberRef);
  const memberId = resolved?.id || memberRef;
  const memberName = resolved?.name || memberRef;
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);
  // Drop any live credential override so a recreated instance starts from room binding.
  setMemberActiveCredentialOverride(roomId, memberId, null);
  if (instance) {
    instance.handle.abort();
    instance.handle.destroy();
    instance.unsubscribe();
    instances.delete(key);
    contextUsageCache.delete(key);
    contextCompactionWarningCache.delete(key);
    clearActivationSource(roomId, memberId);
    logger.info("agent", "instance destroyed", { member: memberName, memberId, roomId });
  }
  pendingCreations.delete(key);
}

export function getActiveInstanceCount(): number {
  return instances.size;
}

// -- DM activation (0.20, no @ required) -------------------------------------

function memberRecordToConfig(memberId: string): AgentMemberConfig | null {
  const rec = getMember(memberId);
  if (!rec) return null;
  const scopeId = scopeIdOf({ kind: "dm", memberId });
  const eff = getEffectiveConfig(memberId, scopeId);
  return {
    id: rec.id,
    name: rec.name,
    type: "agent",
    agent: rec.agentTemplate || "general",
    runtime: "pi-cli",
    model: eff.model || undefined,
    credentialId: eff.credentialId || undefined,
    thinkingLevel: (eff.thinkingLevel as string) || "off",
    skills: eff.skills || [],
    extensions: eff.extensions || [],
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
  roomId: string,
  memberName: string,
  memberId: string,
): void {
  const unsubscribe = instance.handle.subscribe((event: AgentStreamEvent) => {
    const newStatus = processEvent(roomId, memberName, key, event, instance.eventBuffer, memberId, instance.appliedModel);
    if (event.type === "tool_end" && event.toolName === "response" && !(event as any).isError) {
      clearPendingChatReply(instance, `tool:${event.toolName}`);
    }
    if (event.type === "agent_start") {
      instance.turnActive = true;
      if (instance.lengthContinuationPending) instance.lengthContinuationPending = false;
      updateDispatchState(instance, "running", event.type);
      flushQueuedInputs(instance, event.type);
    } else if (event.type === "agent_end") {
      // Public status may become idle here, but the SDK run can still be finalizing.
      // Keep dispatch busy until handle.prompt() settles to avoid a second prompt().
      instance.turnActive = false;
      if (!instance.promptInFlight) {
        updateDispatchState(instance, "idle", event.type);
        applyPendingAfterPromptSettlement(instance, event.type);
        drainQueuedInputsAsPrompt(instance, event.type);
      } else if (instance.dispatchState === "idle") {
        applyPendingAfterPromptSettlement(instance, event.type);
      }
    } else if (event.type === "compaction_start") {
      instance.compacting = true;
      transition(instance, roomId, memberName, "working", event.type);
    } else if (event.type === "compaction_end") {
      instance.compacting = false;
      if (!instance.turnActive) {
        transition(instance, roomId, memberName, "idle", event.type);
        drainQueuedInputsAsPrompt(instance, event.type);
      }
    } else if (event.type === "runtime_exit" && event.unexpected) {
      updateDispatchState(instance, "idle", event.type);
      instance.queuedInputs = [];
    }
    if (newStatus) transition(instance, roomId, memberName, newStatus, event.type);

    if (event.type === "message_end") {
      instance.lastMessageEndWasLength = isLengthStopReason(event.stopReason);
      if (instance.lastMessageEndWasLength) {
        instance.lengthContinuationPending = true;
        logger.warn("agent", "lengthContinuationPending", { member: memberName, roomId, memberId, stopReason: event.stopReason });
      }
      // [room] marker speech: if this message's text contains `[room]` followed by
      // a newline, post the content after the last marker to the conversation.
      // Checked on every message_end so members can speak while working, not just
      // at turn end. Skipped on error turns and on length-truncated intermediate
      // messages (the final settled message is the one that counts).
      // In DM scope there are no room members to mention; the text lands in the
      // member-owned DM store via the same scope-routed postMessage.
      if (event.stopReason !== "error" && !instance.lastMessageEndWasLength) {
        const roomText = extractRoomMarkerText(event.text || "");
        if (roomText !== null) {
          const members = roomStore.getRoomMembers(roomId);
          const memberNames = members.map((m: any) => m.name);
          const urgentMentions = parseUrgentMentions(roomText, memberNames);
          const mentions = [...new Set([...parseMentions(roomText, memberNames), ...urgentMentions])];
          const mentionMemberIds = mentions
            .map((name) => roomStore.resolveRoomMemberRef(roomId, name)?.id)
            .filter((id): id is string => Boolean(id));
          const urgentMentionMemberIds = urgentMentions
            .map((name) => roomStore.resolveRoomMemberRef(roomId, name)?.id)
            .filter((id): id is string => Boolean(id));
          postMessage(roomId, memberName, roomText, mentions, {
            senderMemberId: memberId,
            mentionMemberIds,
            ...(urgentMentions.length > 0 ? { urgentMentions, urgentMentionMemberIds } : {}),
          });
          clearPendingChatReply(instance, "room_marker");
          logger.info("agent", "roomMarkerPosted", { member: memberName, roomId, memberId });
        }
      }
    }

    if (event.type === "message_end" && event.stopReason === "error") {
      instance.hadErrorInTurn = true;
      const formattedError = typeof event.errorMessage === "string" ? formatRuntimeErrorMessage(event.errorMessage).trim() : "";
      const detail = formattedError
        ? ` Error: ${formattedError}`
        : " An unrecoverable provider error occurred.";
      logger.error("agent", "member request failed", { roomId, member: memberName, memberId, error: formattedError || "unrecoverable provider error" });
      postMessage(roomId, "system", `Member "${memberName}" request failed.${detail}`);
    }

    // Unexpected runtime exit: notify the conversation and drop the dead
    // instance so the next activation respawns it.
    if (event.type === "runtime_exit" && event.unexpected) {
      const codeStr = event.code !== null ? `exit ${event.code}` : (event.signal ? `signal ${event.signal}` : "terminated");
      const detail = event.stderrTail ? `\n${event.stderrTail}` : "";
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
  const scopeId = scopeIdOf({ kind: "dm", memberId });
  const key = dmInstanceKey(memberId);
  const existing = instances.get(key);
  if (existing) return existing;

  const pending = pendingCreations.get(key);
  if (pending) return pending;

  const creation = (async (): Promise<AgentInstance | null> => {
    if (!registry) {
      logger.error("agent", "runtime registry not initialized");
      return null;
    }
    const member = memberRecordToConfig(memberId);
    if (!member) {
      logger.error("agent", "dm member not found", { memberId });
      return null;
    }
    if (!isMemberConfigured(member)) {
      logger.error("agent", "dm member unconfigured", { member: member.name, memberId });
      return null;
    }

    const agentDef = loadAgentDefinition(member.agent) || {
      name: member.agent,
      description: member.agent,
      systemPrompt: `You are ${member.name}.`,
      tags: [],
      skills: [],
    };

    const runtime = registry.get(member.runtime);
    if (!runtime) {
      logger.error("agent", "runtime not found", { member: member.name, runtime: member.runtime });
      return null;
    }

    const docsRootPath = join(getBossmodeDir(), "knowledge", "docs");
    const compiled = compileMemberPromptForScope({
      scopeId,
      memberId,
      memberName: member.name,
      agentDef,
      room: null,
      docsRoot: docsRootPath,
      activeScopes: buildDmScopeLabels(memberId, scopeId),
    });

    const skills = resolveSkills(member, agentDef);
    const skillPaths = resolveMemberExtensionSkillPaths(member.extensions);

    const syntheticRoomId = scopeId; // "dm:<memberId>" — tools/response branch on this prefix

    try {
      const handle = await runtime.createAgent({
        cwd: process.cwd(),
        roomId: syntheticRoomId,
        member,
        agentPrompt: compiled.agentPrompt,
        envPrompt: compiled.envPrompt,
        appendSystemPrompt: compiled.appendSystemPrompt,
        skillPaths,
        skillNames: skills,
        roomMembers: [member.name],
        callbacks: {
          onChat: async (message: string) => {
            // Single egress: scope-routed postMessage writes the member-owned DM
            // store, broadcasts to dm:<id> subscribers, and notifies listeners.
            postMessage(syntheticRoomId, member.name, message);
            const active = instances.get(key);
            if (active) clearPendingChatReply(active, "callback:response-dm");
          },
          onMention: async (_target: string, message: string) => {
            // DM has no @ routing — treat as normal chat.
            postMessage(syntheticRoomId, member.name, message);
            const active = instances.get(key);
            if (active) clearPendingChatReply(active, "callback:mention-dm");
          },
        },
      });

      const instance: AgentInstance = {
        handle,
        scopeId,
        roomId: syntheticRoomId,
        memberId,
        agentName: member.name,
        sourceAgent: member.agent,
        status: "idle",
        dispatchState: "idle",
        promptInFlight: false,
        queuedInputs: [],
        pendingChatReply: false,
        hadErrorInTurn: false,
        lastMessageEndWasLength: false,
        lengthContinuationPending: false,
        lengthContinuationAttempted: false,
        compacting: false,
        turnActive: false,
        unsubscribe: () => {},
        eventBuffer: [],
        appliedModel: member.model || "",
        appliedCredentialId: member.credentialId,
      };

      wireInstanceEvents(instance, key, syntheticRoomId, member.name, memberId);

      instances.set(key, instance);
      logger.info("agent", "dmAgentCreated", { member: member.name, memberId, scopeId });
      return instance;
    } catch (err: any) {
      logger.error("agent", "failed to create dm agent", {
        member: member.name,
        memberId,
        error: formatRuntimeErrorMessage(err),
      });
      // User-visible in the DM UI (G1); rooms post the same class of notice.
      postMessage(syntheticRoomId, "system", `Failed to create member "${member.name}": ${formatRuntimeErrorMessage(err)}`);
      return null;
    }
  })();

  pendingCreations.set(key, creation);
  try {
    return await creation;
  } finally {
    if (pendingCreations.get(key) === creation) pendingCreations.delete(key);
  }
}

/**
 * Activate a member in their DM scope (user message path — no @ required).
 * Builds context from recent DM messages and prompts the runtime.
 */
export async function activateDmMember(memberId: string): Promise<void> {
  const rec = getMember(memberId);
  if (!rec) {
    logger.error("agent", "activateDmMember: not found", { memberId });
    return;
  }
  const member = memberRecordToConfig(memberId);
  if (!member || !isMemberConfigured(member)) {
    logger.warn("agent", "activateDmMember: unconfigured", { memberId, name: rec.name });
    // User-visible, same as the room mention path (G1: no silent DM failures).
    postMessage(scopeIdOf({ kind: "dm", memberId }), "system", memberUnconfiguredMessage(rec.name));
    return;
  }

  const instanceRaw = await getOrCreateDm(memberId);
  // F3: heal a live DM instance whose binding drifted (config changed while
  // alive) — same semantics as the room activate path. A destroyed instance
  // is recreated once from the current binding. Null already produced a
  // user-visible notice on every path that matters (creation failure posted
  // inside getOrCreateDm; unconfigured handled above).
  const healed = instanceRaw
    ? await ensureInstanceMatchesBinding(instanceRaw, { model: member.model, credentialId: member.credentialId }, "dm-activate-heal")
    : null;
  const instance = healed ?? (instanceRaw ? await getOrCreateDm(memberId) : null);
  if (!instance) return;

  const scopeId = instance.scopeId;
  setActivationSource(scopeId, member.name, "private_instruction");

  try {
    const recent = readAllDmMessages(memberId).filter((m) => !isSystemNoticeHiddenFromMembers(m)).slice(-40);
    const transcript = recent
      .map((m) => {
        const who = m.sender === "user" ? "User" : m.sender;
        return `[${who}] ${m.content}`;
      })
      .join("\n\n");

    const prompt = transcript
      ? `You are in a private chat with the user. Recent messages:\n\n${transcript}\n\nRespond to the latest user message via the response tool.`
      : `You are in a private chat with the user. They just opened the conversation. Greet briefly via the response tool if appropriate, or wait for their request.`;

    if (instance.dispatchState !== "idle" || instance.promptInFlight) {
      queueInput(instance, prompt, "dm-activate");
      return;
    }

    markPendingChatReply(instance, "dm-activate");
    await runPrompt(instance, prompt, "dm-activate", (err) => {
      logger.error("agent", "dm prompt failed", {
        memberId,
        error: formatRuntimeErrorMessage(err),
      });
    });
  } finally {
    clearActivationSource(scopeId, member.name);
  }
}

// -- Shutdown --

export async function shutdownAll(): Promise<void> {
  for (const [, instance] of instances) instance.unsubscribe();
  instances.clear();
  pendingCreations.clear();
  contextUsageCache.clear();
  contextCompactionWarningCache.clear();
  clearAllActivationSources();
  if (registry) {
    for (const rt of registry.getAll()) {
      await rt.shutdownAll().catch((err) => {
        logger.error("agent", "runtime shutdown error", { runtime: rt.name, error: String(err) });
      });
    }
  }
}
