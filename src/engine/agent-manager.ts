// Agent Manager — agent lifecycle management (slimmed down)
// Prompt assembly → engine/prompt-assembler.ts
// Event handling → engine/event-handler.ts
// Tool callbacks → engine/tools.ts

import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { resolveGlobalSkillPaths } from "../workforce/skill-store.js";
import { activeWorkspaceRoot } from "../workspace/workspace-registry.js";
import { getMemberByName } from "../workforce/member-store.js";
import { resolveRoomMember } from "../workforce/room-member-resolver.js";
import { getBossmodeDir, readConfig } from "../shared/config.js";
import { isSystemNoticeHiddenFromMembers } from "../shared/runtime-error-limit.js";
import * as roomStore from "../workspace/room-store.js";
import * as sessionStore from "../workspace/session-store.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import { postMessage, getMessagesSince, getLatestMessageId } from "../communication/message-bus.js";
import { parseMentions, parseUrgentMentions, initRouter } from "../communication/router.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../communication/ws.js";
import { compileMemberPrompt, compileMemberPromptForScope } from "./prompt-compiler.js";
import { instanceKey as scopeInstanceKey, scopeIdOf, parseScopeId, type ScopeId } from "../shared/conversation-ref.js";
import { listRoomsForMember } from "../workspace/scope-access.js";
import { getMember, getEffectiveConfig, applyMemberConfigPatch } from "../workspace/member-registry.js";
import { readAllDmMessages } from "../workspace/dm-message-store.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk, appendEventToDisk } from "./event-handler.js";
import { deliverMemberMessage, loadScopeMessages } from "./tools.js";
import { MEMBER_CONTRACT_VERSION } from "../shared/contract-version.js";
import { setContractFingerprint, clearStaleMounts, clearRuntimeStateEntry, getRuntimeStateEntry, readRuntimeState } from "../workspace/runtime-state.js";
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
import { exportPiConfigForMember, normalizeModelRef, assertModelAvailable, getModelCredentialProfile } from "./model-credentials.js";
import { notifyMemberIdle, settleWaitOnAbort } from "./wait-wait.js";
import { settleMemberShellWaits } from "./shell-manager.js";
import { settleBackgroundWaits } from "./background-task-store.js";
import { resolveTopicRoomId, getTopic } from "../workspace/topic-store.js";
import type { AgentStatus, RoomMessage, ContextUsage, Room } from "../shared/types.js";

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

/** Last visible message that mentions this member (the @/! that fired the
 * activation); -1 when nothing mentions (steer/system activations). */
function lastMentionTriggerIndex(messages: RoomMessage[], memberName: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const mentions = (m as { mentions?: string[] }).mentions ?? [];
    const urgent = (m as { urgentMentions?: string[] }).urgentMentions ?? [];
    if (mentions.includes(memberName) || urgent.includes(memberName)) return i;
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
  return `[Earlier in this room ${range}: ${senders}${eventClause}. Read them with query_room_messages (from_seq ${fromSeq}); reading marks them seen.]`;
}

interface PendingThinkingSwitch {
  thinkingLevel: string;
}

interface PendingCredentialRefresh {
  profileId: string;
  providerSlug: string;
  changeType: "profileUpdated" | "profileDeleted";
}

/** Start-time sources a background child inherits from a live instance. */
export interface BackgroundSessionSources {
  /** Member config as applied at instance build (model/credential/thinking of that moment). */
  member: AgentMemberConfig;
  compiled: { agentPrompt: string; envPrompt: string; appendSystemPrompt: string[] };
  skills: string[];
  skillPaths: string[];
  cwd: string;
  roomMembers: string[];
  /** Scope id the child's tool callbacks bind to (room:…/dm:…/topic:…). */
  toolScopeId: string;
  runtimeName: string;
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
  /** Last turn failure text for wait() error-idle wake. Cleared at next runPrompt start. */
  lastTurnError: string | null;
  /** Defer system error notice until final agent_end (suppress during willRetry). */
  pendingErrorNotice: string | null;
  lastMessageEndWasLength: boolean;
  lengthContinuationPending: boolean;
  lengthContinuationAttempted: boolean;
  /** Final-text fallback: per-turn completed text segments. `turnSegmentSeq`
   * increments per completed message_end; `lastCompletedFinalText`/Seq hold the
   * last completed segment — the fallback candidate when a debt turn ends
   * without a chat call. Both reset on agent_start. */
  turnSegmentSeq: number;
  lastCompletedFinalText: string;
  lastCompletedFinalSeq: number;
  /** True while an SDK-driven compaction is running between turns (no active prompt/turn). */
  compacting: boolean;
  /** True from agent_start until agent_end — an SDK turn is actively in flight (distinct from dispatchState, which stays busy past agent_end until prompt() settles). */
  turnActive: boolean;
  /** Start-time session sources (background fork snapshot): exactly what this
   *  instance was built from — member config, compiled prompts, skills, cwd,
   *  roomMembers, tool-scope id, runtime name. Background children inherit
   *  these instead of re-resolving config (single assembly path). */
  sessionSources: BackgroundSessionSources;
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

const instances = new Map<string, AgentInstance>();
const pendingCreations = new Map<string, Promise<AgentInstance | null>>();

/** §10 interlock, ONE map: presence = a member model switch is in progress.
 * The promise resolves when that switch finishes (commit or rollback). It is
 * both the switch lock (synchronous has/set at switchMemberModel entry) and
 * the creation gate (creations wait for it to end before building). */
const memberSwitchGates = new Map<string, Promise<void>>();

/** §10: creations of this member already in flight (registered in
 * pendingCreations, whose keys end with `:${memberId}`) — the switch awaits
 * them so its instance snapshot is complete. */
function pendingCreationsFor(memberId: string): Array<Promise<AgentInstance | null>> {
  const suffix = `:${memberId}`;
  const out: Array<Promise<AgentInstance | null>> = [];
  for (const [key, promise] of pendingCreations) {
    if (key.endsWith(suffix)) out.push(promise);
  }
  return out;
}

/**
 * Resolve instance map key from a roomId-or-scopeId + memberId.
 * - room uuid → room:<uuid>:<memberId>
 * - already "dm:…" / "room:…" scopeId → scopeId:memberId
 * Contract §5.
 */
function instanceKey(roomIdOrScope: string, memberId: string): string {
  if (
    typeof roomIdOrScope === "string"
    && (roomIdOrScope.startsWith("dm:") || roomIdOrScope.startsWith("room:") || roomIdOrScope.startsWith("topic:"))
  ) {
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
  if (ref.kind === "topic") {
    // Topic instances live under topic:<id>:<memberId>, not the parent room.
    const want = `topic:${ref.topicId}`;
    let sawInstance = false;
    for (const inst of instances.values()) {
      if (inst.scopeId !== want) continue;
      sawInstance = true;
      if (inst.status === "working") return "working";
    }
    return sawInstance ? "idle" : "inactive";
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
  // If the turn just failed, pass lastTurnError so wait settles with reason "error".
  if (newStatus === "idle") {
    const error = instance.lastTurnError || undefined;
    try { notifyMemberIdle(roomId, instance.memberId, error ? { error } : undefined); } catch { /* ignore */ }
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

const LENGTH_CONTINUATION_PROMPT = "⚠ Your previous response was cut off due to output length. Continue from where you stopped and deliver the result — respond with the `chat` tool.";
const LENGTH_CONTINUATION_FAILED_WARNING = "Member was cut off due to output length again after one automatic continuation. Automatic continuation stopped to avoid a loop; please send a new instruction if you want them to continue.";

function isLengthStopReason(stopReason: unknown): boolean {
  if (typeof stopReason !== "string") return false;
  const normalized = stopReason.toLowerCase();
  return normalized === "length" || normalized.includes("max_tokens") || normalized.includes("max_output");
}

/** Drain queued mid-turn inputs into a fresh prompt. Returns true if a new prompt was started. */
function drainQueuedInputsAsPrompt(instance: AgentInstance, trigger: string): boolean {
  if (instance.queuedInputs.length === 0) return false;
  // After agent_end, turnActive is false while public status may still read "working"
  // until transition — gate on turn/dispatch, not public status (fish 2026-08-09).
  if (instance.turnActive || instance.promptInFlight || instance.dispatchState !== "idle") return false;
  // Never drain into a prompt while compaction is running or requested —
  // queued inputs resume once the operation settles (steer-removal §3).
  if (instance.compacting) return false;
  const queued = instance.queuedInputs.splice(0);
  const message = queued.join("\n\n");
  logger.info("agent", "drainQueuedInputsAsPrompt", { member: instance.agentName, count: queued.length, trigger });
  void runPrompt(instance, message, "queued", (err) => {
    logger.error("agent", "queued prompt error", { member: instance.agentName, error: formatRuntimeErrorMessage(err) });
    postMessage(instance.roomId, "system", `Member "${instance.agentName}" error: ${formatRuntimeErrorMessage(err)}`);
  });
  return true;
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
    // Continue the pipeline without leaving a durable public idle (wait consumer).
    if (drainQueuedInputsAsPrompt(instance, trigger)) {
      if (instance.status === "idle") {
        transition(instance, instance.roomId, instance.agentName, "working", `${trigger}_drain`);
      }
    }
    return;
  }
  maybeFlushPendingReload(instance);
  if (await maybeRunLengthContinuation(instance, trigger, opts)) return;
  // Final-text fallback (fish 2026-08-07): a turn that owed a reply and never
  // called chat posts its last *completed* text segment verbatim, marked
  // autoDelivered. Abort/error turns never fall back (skipChatWarning=true on
  // abort; hadErrorInTurn on error). Length-truncated segments are not
  // candidates (the continuation path above runs first; the continuation's
  // completed segment is). The fallback clears the debt, so the silence
  // warning below only fires when there was no text at all.
  if (!opts.skipChatWarning && !instance.hadErrorInTurn && instance.pendingChatReply) {
    const seg = instance.lastCompletedFinalText;
    if (seg) {
      deliverMemberMessage(instance.roomId, instance.agentName, seg, { autoDelivered: true });
      clearPendingChatReply(instance, "final_text_fallback");
    }
  }
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
  instance.lastTurnError = null;
  instance.pendingErrorNotice = null;
  instance.lastMessageEndWasLength = false;
  instance.lengthContinuationPending = false;
  if (trigger !== "length_continuation") instance.lengthContinuationAttempted = false;
  // Activity panel: emit the full composed prompt for user-facing activations
  // (activate / dm-activate / queued). Steer has its own user_steer event;
  // length_continuation is a system prompt, not a user message.
  if (trigger === "activate" || trigger === "dm-activate" || trigger === "queued") {
    emitAgentLocalEvent(instance.roomId, instance.memberId, {
      type: "user_prompt",
      text: message,
      trigger,
    });
  }
  try {
    await instance.handle.prompt(message);
    instance.promptInFlight = false;
    await finalizePromptSettlement(instance, `${trigger}_prompt_resolved`, { skipChatWarning: instance.dispatchState === "aborting" });
  } catch (err: any) {
    instance.promptInFlight = false;
    const formatted = formatRuntimeErrorMessage(err).trim() || "prompt failed";
    instance.hadErrorInTurn = true;
    instance.lastTurnError = formatted;
    onError(err);
    updateDispatchState(instance, "idle", `${trigger}_prompt_error`);
    instance.queuedInputs = [];
    // Ensure public status goes idle so wait listeners wake with the error mark.
    if (instance.status !== "idle") {
      transition(instance, instance.roomId, instance.agentName, "idle", `${trigger}_prompt_error`);
    } else {
      try { notifyMemberIdle(instance.roomId, instance.memberId, { error: formatted }); } catch { /* ignore */ }
    }
  }
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
async function applyModelSwitchToInstance(
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
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: instance.status });
}

/** If the live instance drifted from the room binding, re-apply (or destroy so the next create is clean). */
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
        scopeById = new Map(all.map((m) => [m.id, m]));
      } catch {
        scopeById = new Map();
      }
    }
    return scopeById.get(ref.messageId);
  };

  // Single message → single-message envelope.
  if (items.length === 1) {
    return wrapRoomContextMessage(items[0].msg, roomName, items[0].role, lookup);
  }

  // Multiple messages → shared transcript envelope (each message keeps its own
  // full sub-header with seq + timestamp so it can be referenced individually).
  return wrapRoomMessagesTranscript(
    items.map((i) => ({ msg: i.msg, role: i.role })),
    roomName,
    lookup,
  );
}

// Resolve skills: member config > agent definition > empty
export function resolveSkills(member: AgentMemberConfig, agentDef: { skills?: string[] }): string[] {
  return member.skills ?? agentDef.skills ?? [];
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
  const ref = parseScopeId(scopeId);
  if (!ref) {
    logger.error("agent", "buildMemberAgentSession: invalid scope", { scopeId, memberId });
    return null;
  }
  const key = instanceKey(scopeId, memberId);
  // §10 creation gate: an in-progress member switch must not race a fresh
  // build (stale binding the switch will never see). Wait for the switch to
  // end, then re-run the whole lookup. Never register a creation while the
  // gate is held — the switch awaits pending creations, so a registered
  // waiter would deadlock both sides. No timeout: the switch always settles.
  for (;;) {
    const existing = instances.get(key);
    if (existing) return existing;
    const pending = pendingCreations.get(key);
    if (pending) return pending;
    const gate = memberSwitchGates.get(memberId);
    if (gate) {
      await gate;
      continue;
    }
    break;
  }

  const creation = (async (): Promise<AgentInstance | null> => {
    if (!registry) {
      logger.error("agent", "runtime registry not initialized");
      return null;
    }

    let member: AgentMemberConfig;
    let room: Room | null;
    let cwd = "";
    let roomMembers: string[];
    let keyRoomId: string;          // instance key room part + error-post target
    let logLabel: string;
    let errLabel: string;
    let compiled: { agentPrompt: string; envPrompt: string; appendSystemPrompt: string[]; contractFingerprint: string };
    let skills: string[];
    let skillPaths: string[] = [];
    let resumeSession: { sessionId?: string; sessionFile?: string } | undefined;
    let onSessionChanged: ((session: { sessionId?: string; sessionFile?: string }) => void) | undefined;
    let callbacks: Parameters<typeof runtime.createAgent>[0]["callbacks"];

    const docsRootPath = join(getBossmodeDir(), "memory", "projects");

    if (ref.kind === "dm") {
      // ── DM scope: global member config, daemon cwd, roster-labeled activeScopes ──
      const m = memberRecordToConfig(memberId);
      if (!m) {
        logger.error("agent", "dm member not found", { memberId });
        return null;
      }
      member = m;
      room = null;
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
      const runtime0 = registry.get(member.runtime);
      if (!runtime0) {
        logger.error("agent", "runtime not found", { member: member.name, runtime: member.runtime });
        return null;
      }
      const dmScopeId = scopeId;
      compiled = compileMemberPromptForScope({
        scopeId: dmScopeId,
        memberId,
        memberName: member.name,
        agentDef,
        room: null,
        docsRoot: docsRootPath,
        activeScopes: buildDmScopeLabels(memberId, dmScopeId),
      });
      setContractFingerprint(dmScopeId, memberId, compiled.contractFingerprint, MEMBER_CONTRACT_VERSION);
      clearStaleMounts(dmScopeId, memberId);
      skills = resolveSkills(member, agentDef);
      cwd = activeWorkspaceRoot(memberId);
      roomMembers = [member.name];
      keyRoomId = dmScopeId; // "dm:<memberId>" — tools/chat branch on this prefix
      logLabel = "dmAgentCreated";
      errLabel = "dm";
      const dmKey = key;
      const dmMemberName = member.name;
      callbacks = {
        onChat: async (message: string) => {
          // Single egress: scope-routed postMessage writes the member-owned DM
          // store, broadcasts to dm:<id> subscribers, and notifies listeners.
          postMessage(dmScopeId, dmMemberName, message);
          const active = instances.get(dmKey);
          if (active) clearPendingChatReply(active, "callback:chat-dm");
        },
        onMention: async (_target: string, message: string) => {
          // DM has no @ routing — treat as normal chat.
          postMessage(dmScopeId, dmMemberName, message);
          const active = instances.get(dmKey);
          if (active) clearPendingChatReply(active, "callback:mention-dm");
        },
      };
      var runtime = runtime0;
    } else if (ref.kind === "room") {
      // ── Room scope: roster member + global effective-config overlay ──
      const r = roomStore.getRoom(ref.roomId);
      if (!r) {
        logger.error("agent", "room not found", { roomId: ref.roomId });
        return null;
      }
      room = r;
      let m = resolveRoomMember(ref.roomId, memberId);
      if (!m) {
        logger.error("agent", "no member or agent definition found", { memberId, roomId: ref.roomId });
        return null;
      }
      // 0.20 G3 cutover: overlay global effective-config via ID link.
      try {
        const globalId = roomStore.resolveGlobalMemberId(r, m);
        if (globalId) {
          const eff = getEffectiveConfig(globalId, roomScopeId(ref.roomId));
          m = {
            ...m,
            model: eff.model || m.model,
            credentialId: eff.credentialId || m.credentialId,
            thinkingLevel: (eff.thinkingLevel as string) || m.thinkingLevel,
            skills: eff.skills?.length ? eff.skills : m.skills,
            mcpServers: eff.mcpServers?.length ? eff.mcpServers : m.mcpServers,
          };
        }
      } catch (err) {
        logger.warn("agent", "effective-config overlay skipped", { member: m.name, error: String(err) });
      }
      member = m;
      if (!isMemberConfigured(member)) {
        logger.error("agent", "member unconfigured", { member: member.name, memberId });
        return null;
      }
      logger.info("agent", "loadMember", { member: member.name, memberId, source: "room-effective", agent: member.agent, runtime: member.runtime, model: member.model, thinkingLevel: member.thinkingLevel });
      const agentDef = loadAgentDefinition(member.agent);
      if (!agentDef) {
        logger.error("agent", "agent definition not found", { member: member.name, agent: member.agent, roomId: ref.roomId });
        return null;
      }
      var runtime1 = registry.get(member.runtime);
      if (!runtime1) {
        logger.error("agent", "runtime not found", { member: member.name, runtime: member.runtime });
        return null;
      }
      compiled = compileMemberPrompt({ room: r, member, agentDef, docsRoot: docsRootPath });
      setContractFingerprint(`room:${ref.roomId}`, memberId, compiled.contractFingerprint, MEMBER_CONTRACT_VERSION);
      clearStaleMounts(`room:${ref.roomId}`, memberId);
      skills = resolveSkills(member, agentDef);
      skillPaths = [
        ...resolveGlobalSkillPaths(skills),
      ];
      // Session resume (global toggle; default true)
      let sessionResumeEnabled = true;
      try {
        const config = readConfig();
        sessionResumeEnabled = (config.runtime?.sessionResume ?? (config as any).sessionResume) !== false;
      } catch {
        sessionResumeEnabled = true;
      }
      const sessions = sessionStore.getSessions(ref.roomId);
      const savedSession = sessions[memberId];
      resumeSession = (sessionResumeEnabled && savedSession)
        ? { sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile }
        : undefined;
      if (resumeSession) {
        logger.info("agent", "resumeSession", { member: member.name, runtime: member.runtime, sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile });
      }
      cwd = activeWorkspaceRoot(memberId);
      roomMembers = r.members;
      keyRoomId = ref.roomId;
      logLabel = "agentCreated";
      errLabel = "room";
      const roomKey = key;
      const roomMemberName = member.name;
      onSessionChanged = (session) => {
        sessionStore.saveSession(ref.roomId, memberId, {
          runtime: member.runtime,
          sessionId: session.sessionId,
          sessionFile: session.sessionFile,
        });
        logger.info("agent", "sessionSaved", { member: roomMemberName, memberId, sessionId: session.sessionId, sessionFile: session.sessionFile });
      };
      callbacks = {
        onChat: async (message: string) => {
          postMessage(ref.roomId, roomMemberName, message, [], { senderMemberId: memberId });
          const active = instances.get(roomKey);
          if (active) clearPendingChatReply(active, "callback:chat");
        },
        onMention: async (targetMember: string, message: string) => {
          // Mention activation is handled by router listener via message-bus.
          const target = roomStore.resolveRoomMemberRef(ref.roomId, targetMember);
          postMessage(ref.roomId, roomMemberName, message, [targetMember], { senderMemberId: memberId, mentionMemberIds: target ? [target.id] : [] });
          const active = instances.get(roomKey);
          if (active) clearPendingChatReply(active, "callback:mention");
        },
      };
      var runtime = runtime1;
    } else {
      // ── Topic scope: parent-room roster (global fallback), topic title, seed/fork ──
      // Topic scope ids carry no roomId — the parent comes from topic-store.
      const { getTopic, saveTopic, resolveOwningRoomId } = await import("../workspace/topic-store.js");
      const topicId = ref.topicId;
      const parentRoomId = resolveOwningRoomId(scopeId);
      const r = parentRoomId ? roomStore.getRoom(parentRoomId) : null;
      if (!r) {
        logger.error("agent", "topic parent room not found", { parentRoomId, topicId });
        return null;
      }
      room = r;
      let m = resolveRoomMember(parentRoomId, memberId);
      if (!m) {
        const cfg = memberRecordToConfig(memberId);
        if (!cfg) {
          logger.error("agent", "topic member not found", { memberId, topicId });
          return null;
        }
        m = cfg;
      }
      member = m;
      if (!isMemberConfigured(member)) {
        logger.error("agent", "topic member unconfigured", { member: member.name, memberId, topicId });
        return null;
      }
      const agentDef = loadAgentDefinition(member.agent) || {
        name: member.agent,
        description: member.agent,
        systemPrompt: `You are ${member.name}.`,
        tags: [],
        skills: [],
      };
      var runtime2 = registry.get(member.runtime);
      if (!runtime2) {
        logger.error("agent", "runtime not found", { member: member.name, runtime: member.runtime });
        return null;
      }
      const topicRec = getTopic(parentRoomId, topicId);
      // Member+Communication byte-identical to room; Environment first line is topic-scoped.
      compiled = compileMemberPromptForScope({
        scopeId,
        memberId,
        memberName: member.name,
        agentDef,
        room: r,
        docsRoot: docsRootPath,
        topicTitle: topicRec?.title ?? null,
      });
      setContractFingerprint(scopeId, memberId, compiled.contractFingerprint, MEMBER_CONTRACT_VERSION);
      clearStaleMounts(scopeId, memberId);
      skills = resolveSkills(member, agentDef);
      cwd = activeWorkspaceRoot(memberId);
      roomMembers = r.members;
      keyRoomId = scopeId; // "topic:<id>" — postMessage routes to topic-store
      logLabel = "topicAgentCreated";
      errLabel = "topic";
      const topicKey = key;
      const topicMemberName = member.name;
      const topicScopeId = scopeId;

      // Batch 2: prefix-fork the room session when seedMode=fork (degrades to fresh).
      const { forkRoomSessionPrefix, getTopicSession } = await import("./topic-session-fork.js");
      const existingTopicSession = getTopicSession(parentRoomId, topicId, memberId);
      resumeSession = existingTopicSession?.sessionFile
        ? { sessionId: existingTopicSession.sessionId, sessionFile: existingTopicSession.sessionFile }
        : undefined;
      if (!resumeSession && topicRec?.seedMode === "fork") {
        const fork = forkRoomSessionPrefix({
          parentRoomId,
          topicId,
          memberId,
          cwd: r.cwd || process.cwd(),
          seedMode: "fork",
          // Must be the stored anchor excerpt — never the guide text (fish/architect 2026-08-18).
          anchorExcerpt: topicRec.anchorExcerpt,
        });
        if (fork.mode === "fork" && fork.sessionFile) {
          resumeSession = { sessionId: fork.sessionId, sessionFile: fork.sessionFile };
          if (fork.prefixSummary && topicRec && !topicRec.guideText?.includes(fork.prefixSummary.slice(0, 40))) {
            const { buildTopicGuideText } = await import("../workspace/topic-store.js");
            topicRec.guideText = buildTopicGuideText({
              title: topicRec.title,
              roomName: r.name,
              roomId: parentRoomId,
              anchorExcerpt: "",
              seedMode: "fork",
              prefixSummary: fork.prefixSummary,
            });
            saveTopic(topicRec);
          }
        }
      }
      onSessionChanged = (session) => {
        void import("./topic-session-fork.js").then(({ saveTopicSession }) => {
          saveTopicSession(parentRoomId, topicId, memberId, {
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
          });
        });
      };
      callbacks = {
        onChat: async (message: string) => {
          postMessage(topicScopeId, topicMemberName, message);
          const active = instances.get(topicKey);
          if (active) clearPendingChatReply(active, "callback:chat-topic");
        },
        onMention: async (target: string, message: string) => {
          // Mentions inside a topic stay in the topic scope.
          postMessage(topicScopeId, topicMemberName, message, [target]);
          const active = instances.get(topicKey);
          if (active) clearPendingChatReply(active, "callback:mention-topic");
        },
      };
      var runtime = runtime2;
    }

    try {
      const handle = await runtime.createAgent({
        cwd,
        roomId: keyRoomId,
        member,
        agentPrompt: compiled.agentPrompt,
        envPrompt: compiled.envPrompt,
        appendSystemPrompt: compiled.appendSystemPrompt,
        skillPaths,
        skillNames: skills,
        roomMembers,
        resumeSession,
        onSessionChanged,
        callbacks,
      });

      logger.info("agent", logLabel, { member: member.name, agent: member.agent, runtime: member.runtime, scopeId });

      const instance: AgentInstance = {
        handle,
        scopeId: scopeId.startsWith("room:") ? scopeId : scopeId,
        roomId: keyRoomId,
        memberId,
        agentName: member.name,
        sourceAgent: member.agent,
        status: "idle",
        dispatchState: "idle",
        promptInFlight: false,
        queuedInputs: [],
        pendingChatReply: false,
        hadErrorInTurn: false,
        lastTurnError: null,
        pendingErrorNotice: null,
        lastMessageEndWasLength: false,
        lengthContinuationPending: false,
        lengthContinuationAttempted: false,
        turnSegmentSeq: 0,
        lastCompletedFinalText: "",
        lastCompletedFinalSeq: 0,
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
          // EXACTLY the id createAgent binds tools with (bare room id for rooms;
          // full scope id for dm/topic) — background children must receive the
          // same binding format the live parent used, or scope-keyed tool
          // callbacks (create_task, queries…) misresolve.
          toolScopeId: keyRoomId,
          runtimeName: member.runtime,
        },
        unsubscribe: () => {},
        eventBuffer: [],
        appliedModel: member.model ? normalizeSwitchModelRef(member.model) : "",
        appliedCredentialId: member.credentialId,
        pendingReload: null,
      };

      wireInstanceEvents(instance, key, keyRoomId, member.name, memberId);

      instances.set(key, instance);
      return instance;
    } catch (err: any) {
      logger.error("agent", `failed to create ${errLabel} agent`, { member: member.name, agent: member.agent, runtime: member.runtime, error: formatRuntimeErrorMessage(err) });
      postMessage(keyRoomId, "system", `Failed to create member "${member.name}": ${formatRuntimeErrorMessage(err)}`);
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

/** Batch 6 §3: rebuild a live member session with fresh assets, keeping the
 * session files (conversation history). Queued until the current run settles. */
export async function reloadMemberSession(scopeId: string, memberId: string, reason: string): Promise<{ queued: boolean; rebuilt: boolean }> {
  const key = instanceKey(scopeId, memberId);
  const instance = instances.get(key);
  if (!instance) {
    // Nothing live — plain activation semantics (resume if a file exists).
    const built = await buildMemberAgentSession(memberId, scopeId);
    return { queued: false, rebuilt: !!built };
  }
  if (instance.status === "working" || instance.compacting || instance.dispatchState !== "idle" || instance.promptInFlight) {
    instance.pendingReload = reason;
    logger.info("agent", "reloadQueued", { memberId, scopeId, reason });
    return { queued: true, rebuilt: false };
  }
  await rebuildLiveInstance(instance, reason);
  return { queued: false, rebuilt: true };
}

async function rebuildLiveInstance(instance: AgentInstance, reason: string): Promise<AgentInstance | null> {
  const scopeId = instance.scopeId;
  const memberId = instance.memberId;
  const carriedInputs = instance.queuedInputs.slice();
  try { instance.handle.abort(); } catch { /* already stopped */ }
  try { instance.handle.destroy(); } catch { /* already stopped */ }
  try { instance.unsubscribe(); } catch { /* already stopped */ }
  instances.delete(instanceKey(scopeId, memberId));
  // Session files are kept — reload means same conversation, fresh assets.
  const built = await buildMemberAgentSession(memberId, scopeId, { resume: true });
  if (built && carriedInputs.length > 0) built.queuedInputs.push(...carriedInputs);
  logger.info("agent", "sessionReloaded", { memberId, scopeId, reason, rebuilt: !!built });
  return built;
}

/** Flush a reload requested mid-run once the member is fully settled and
 * nothing is queued (queued prompts are delivered first; the rebuild waits for
 * the next settlement). */
function maybeFlushPendingReload(instance: AgentInstance): void {
  if (!instance.pendingReload) return;
  if (instance.status !== "idle" || instance.compacting || instance.turnActive || instance.dispatchState !== "idle" || instance.promptInFlight) return;
  if (instance.queuedInputs.length > 0) return;
  const reason = instance.pendingReload;
  instance.pendingReload = null;
  const key = instanceKey(instance.scopeId, instance.memberId);
  // Escape the current event handler before destroying the instance.
  setTimeout(() => {
    if (instances.get(key) !== instance) return; // replaced/destroyed meanwhile
    void rebuildLiveInstance(instance, reason).catch((err) =>
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

export async function activateAgent(roomId: string, memberRef: string, ctx?: { needResponse?: string[]; senderName?: string }): Promise<void> {
  // Reply-debt semantics (fish 2026-08-10):
  // - user @ always owes a reply (mapped as all mentioned internally)
  // - member @ owes only when this member's name is in need_response string[]
  // - omit need_response = FYI (activated, no debt, no fallback)
  // - system/absent ctx keeps debt on activation
  const isUser = ctx?.senderName === "user";
  const member = resolveRoomMember(roomId, memberRef);
  const memberName = member?.name || memberRef;
  const memberId = member?.id || memberRef;
  const list = Array.isArray(ctx?.needResponse) ? ctx!.needResponse! : [];
  const listed = list.some((n) => n === memberName || n === memberId || n === memberRef);
  // Explicit empty need_response on a user message = FYI (topic-close notice).
  const explicitFyi = isUser && !!ctx && Array.isArray(ctx.needResponse) && ctx.needResponse.length === 0;
  const replyDebt = explicitFyi ? false : (isUser || !ctx ? true : listed);
  const banner = ctx && replyDebt
    ? isUser
      ? "[REPLY EXPECTED] Respond using the chat tool."
      : `[REPLY EXPECTED] ${ctx.senderName} expects your reply — respond with the chat tool.`
    : undefined;
  return activateAgentInternal(roomId, memberRef, { source: "room_mention", replyDebt, trigger: "activate", banner });
}

async function activateAgentInternal(
  roomId: string,
  memberRef: string,
  opts: { source: "room_mention" | "private_instruction" | "system"; replyDebt: boolean; trigger: string; banner?: string; urgent?: boolean },
): Promise<void> {
  if (typeof roomId === "string" && roomId.startsWith("topic:")) {
    logger.warn("agent", "activateAgentInternal refused topic scope — use activateTopicMember", { roomId, memberRef, trigger: opts.trigger });
    return;
  }
  const member = resolveRoomMember(roomId, memberRef);
  const memberName = member?.name || memberRef;
  const memberId = member?.id || memberRef;
  logger.info("agent", "activateAgent", { roomId, member: memberName, memberId });

  if (member && !isMemberConfigured(member)) {
    postMessage(roomId, "system", memberUnconfiguredMessage(memberName));
    return;
  }

  const instance = await getOrCreate(roomId, memberId);
  if (!instance) {
    // getOrCreate posted its own failure detail on the create path.
    postMessage(roomId, "system", `Failed to activate member "${memberName}": not found or runtime unavailable.`);
    return;
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
  if (allNewMessages.length === 0) return;

  // Context limit
  const contextLimit = (member as any)?.contextLimit || 50;
  const visibleMessages = filterAgentVisibleMessages(allNewMessages, memberName);
  if (visibleMessages.length === 0) {
    // Nothing member-visible; keep the cursor advancing (avoid re-filtering
    // the same system notices on every activation).
    const latestId = getLatestMessageId(roomId);
    if (latestId) roomStore.setCursor(roomId, memberId, latestId);
    return;
  }

  // Hybrid injection (fish-approved spec msg:#14818): the trigger message
  // (last one mentioning this member, else the newest) is injected in full;
  // everything between the delivery cursor and the trigger compresses into a
  // one-line unread hint the member may read via query_room_messages.
  const triggerIdx = lastMentionTriggerIndex(visibleMessages, memberName);
  const triggerIndex = triggerIdx >= 0 ? triggerIdx : visibleMessages.length - 1;
  const trigger = visibleMessages[triggerIndex];
  // A member's own messages are never unread to itself (QA 2026-08-06): exclude
  // them from the backlog so the hint does not ring forever with self-replies.
  const backlog = visibleMessages.slice(0, triggerIndex).filter((m) => m.sender !== memberName);
  const truncated = backlog.length > contextLimit;
  const backlogLimited = truncated ? backlog.slice(-contextLimit) : backlog;
  const unreadHint = buildUnreadBacklogHint(backlogLimited, truncated
    ? { total: backlog.length, fromSeq: (backlog[0] as { seq?: number }).seq! - 1 }
    : undefined);
  const formattedTrigger = formatMessagesForAgent(roomId, [trigger], memberName, roomStore.getRoom(roomId)?.name || roomId);
  const payload = opts.banner
    ? `${opts.banner}\n\n${unreadHint ? `${unreadHint}\n\n` : ""}${formattedTrigger}`
    : unreadHint ? `${unreadHint}\n\n${formattedTrigger}` : formattedTrigger;

  // Cursor advances only to the trigger — the backlog stays unread until the
  // member reads it (query_room_messages advances the cursor). Own replies
  // are skipped too (they are not unread to their author), but NEVER at the
  // cost of regressing below the trigger: a self message that precedes the
  // trigger belongs to an earlier turn the cursor already passed. The cursor
  // target is the later of (trigger, last own message after it) — closed
  // interval: the trigger itself is consumed (QA 2026-08-06 phantom unread).
  let cursorTarget: RoomMessage = trigger;
  let lastSelfIdx = -1;
  for (let i = allNewMessages.length - 1; i >= 0; i--) {
    if (allNewMessages[i].sender === memberName) {
      lastSelfIdx = i;
      break;
    }
  }
  const triggerIdxInBatch = allNewMessages.findIndex((m) => m.id === trigger.id);
  if (lastSelfIdx > triggerIdxInBatch) cursorTarget = allNewMessages[lastSelfIdx];
  if (cursorTarget.id) roomStore.setCursor(roomId, memberId, cursorTarget.id);

  logger.info("agent", "incrementalMessages", { member: memberName, count: backlogLimited.length + 1, total: allNewMessages.length, filtered: allNewMessages.length - visibleMessages.length, cursorFrom: lastCursor, hybrid: true });

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
    // Interrupt-on-message (design-interrupt-on-message-v1, fish 2026-09-04):
    // a mid-turn mention now aborts the run and processes immediately —
    // steer (queue-behind-the-turn) is retired for message delivery. Shell
    // commands keep running; blocking tools return their actual running result.
    // The SDK owns session history, including interrupted tool calls.
    // Activity: NO event here — the drained queue emits exactly one user_prompt
    // (banner + message) when the abort settles (fish 2026-09-05: this path
    // used to also emit user_steer up front, so one message produced two
    // activity cards).
    interruptWorkingInstance(roomId, instance, payload,
      "Your previous turn was interrupted by this message. Shell commands keep running. Check shell_list for running commands and use shell_wait to collect their results before continuing dependent work.",
      "message_interrupt");
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

export async function activateAll(roomId: string, ctx?: { needResponse?: string[]; senderName?: string }): Promise<void> {
  const room = roomStore.getRoom(roomId);
  if (!room) return;
  const activations = roomStore.getRoomMembers(roomId).map((member) => {
    const key = instanceKey(roomId, member.id);
    const instance = instances.get(key);
    if (instance && (instance.status === "working" || instance.dispatchState !== "idle")) return Promise.resolve();
    return activateAgent(roomId, member.id, ctx);
  });
  await Promise.allSettled(activations);
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
    const stillCurrent = instances.get(instanceKey(inst.scopeId, inst.memberId)) === inst;
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
 * every live instance (room + DM + topic, idle and working) via the SDK's
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
    const { getModelCredentialProfile } = await import("./model-credentials.js");
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
      const { updateMember } = await import("../workspace/member-registry.js");
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
  return instances.get(instanceKey(scopeId, memberId)) ?? null;
}

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

// -- Member status report (member_status tool) --

export interface MemberStatusTopicSlice {
  topicId: string;
  title: string;
  status: AgentStatus;
  lastActivity?: number;
}

export interface MemberStatusEntry {
  name: string;
  memberId: string;
  /** Aggregated across live instances: working > idle > inactive (no live instance). */
  status: AgentStatus;
  /** Room-instance status in this room (inactive if none). */
  room: AgentStatus;
  /** Live topic instances for this member whose parent is this room. */
  topics: MemberStatusTopicSlice[];
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
    const topics: MemberStatusTopicSlice[] = [];
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
      if (inst.scopeId.startsWith("topic:")) {
        const topicId = inst.scopeId.slice("topic:".length);
        const parent = resolveTopicRoomId(topicId);
        if (parent !== roomId) continue;
        const match = inst.memberId === m.id || inst.memberId === gid || inst.agentName === m.name;
        if (!match) continue;
        const rec = getTopic(parent, topicId);
        topics.push({ topicId, title: rec?.title || topicId, status: inst.status });
        activeScopes.push({ scope: `topic: ${rec?.title || topicId}`, status: inst.status });
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
    return { name: m.name, memberId: m.id, status, room: roomStatus, topics, activeScopes, stale: getMemberStale(`room:${roomId}`, m.id) ?? undefined };
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
  const key = instanceKey(roomId, member.id);
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
  const member = roomId.startsWith("dm:") ? null : resolveRoomMember(roomId, memberRef);
  // Prefer live instance identity (covers dm: scope where room lookup fails).
  const keyHint = instanceKey(roomId, member?.id || memberRef);
  const instance = instances.get(keyHint)
    || [...instances.values()].find((inst) => inst.roomId === roomId && (inst.memberId === memberRef || inst.agentName === memberRef));
  const memberId = member?.id || instance?.memberId || memberRef;
  const agentName = member?.name || instance?.agentName || memberRef;
  // Stamp once so disk + WS share identity (same rule as event-handler, rc.4).
  const stamped = typeof (event as { ts?: number }).ts === "number" ? event : { ...event, ts: Date.now() };
  if (instance) instance.eventBuffer.push(stamped);
  try { appendEventToDisk(roomId, memberId, stamped); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, memberId, error: String(err) }); }
  broadcastToAgentSubscribers(roomId, agentName, {
    type: "agent:event",
    roomId,
    agent: agentName,
    memberId,
    event: stamped,
  });
}

// -- Manual compaction (conversation action) --

/** Manual compaction as ONE explicit conversation action (steer-removal §2):
 * room, DM and topic all address the live instance by its real scopeId — no
 * more room-path shortcuts. The operation marks the lifecycle busy BEFORE the
 * first await, so ordinary and urgent messages queue (they never cancel it);
 * explicit Stop stays the one canceller, including in the window between the
 * old prompt settling and compaction actually starting. Shell processes are
 * never killed — blocking shell waits are settled so the member's turn can
 * end, but the commands keep running in the PTY. */
export async function compactMember(scopeId: string, memberId: string): Promise<{ ok: boolean; action: string }> {
  let instance: AgentInstance | undefined = instances.get(instanceKey(scopeId, memberId)) ?? undefined;
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
  try {
    // Settle the old turn first: shell waits return as running (commands stay
    // alive in the PTY), the SDK abort finishes the in-flight prompt.
    if (instance.turnActive || instance.promptInFlight || instance.status === "working") {
      settleMemberShellWaits(instance.memberId);
      try { instance.handle.abort(); } catch { /* already stopped */ }
      await instance.handle.waitForIdle();
      // Stop landed in the gap (old prompt finished, compact not started):
      // abortAgent marked dispatchState "aborting" — honor it, do not compact.
      if (instance.dispatchState === "aborting") {
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
  }
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
  try { settleMemberShellWaits(memberId); } catch { /* ignore */ }
  try { settleBackgroundWaits(memberId); } catch { /* ignore */ }

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
  if (typeof roomId === "string" && roomId.startsWith("topic:")) {
    const topicId = roomId.slice("topic:".length);
    const parent = resolveTopicRoomId(topicId);
    if (!parent) return { ok: false, action: "not_in_topic" };
    return interruptTopicMember(parent, topicId, memberRef, urgentByName);
  }
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const memberName = member?.name || memberRef;
  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);

  if (!instance || (instance.status !== "working" && instance.dispatchState === "idle")) {
    await activateAgentInternal(roomId, memberId, { source: "room_mention", replyDebt: true, trigger: "urgent_interrupt" });
    return { ok: true, action: "activated" };
  }

  if (instance.status === "working" && !instance.compacting) {
    const banner = `[INTERRUPTED] Your previous turn was aborted by an urgent message (!${memberName}) from ${urgentByName}. That turn may have left partial work — verify its state before building on it.`;
    try { settleWaitOnAbort(roomId, memberId); } catch { /* ignore */ }
    try { settleMemberShellWaits(memberId); } catch { /* ignore */ }
    try { settleBackgroundWaits(memberId); } catch { /* ignore */ }
    instance.handle.abort({ preserveCompaction: true });
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
    // No running instance: reload is a no-op semantically (activation creates
    // fresh with current code/config), but we still refresh the contract
    // fingerprint+version and clear stale markers so the UI doesn't show
    // a false "needs reload" badge for a member that will auto-pick-up.
    try {
      const agentDef2 = loadAgentDefinition(member.agent);
      if (agentDef2) {
        const docsRoot2 = join(getBossmodeDir(), "memory", "projects");
        const compiled2 = compileMemberPrompt({ room, member, agentDef: agentDef2, docsRoot: docsRoot2 });
        setContractFingerprint(`room:${roomId}`, memberId, compiled2.contractFingerprint, MEMBER_CONTRACT_VERSION);
      }
    } catch { /* compile failed — best effort */ }
    clearStaleMounts(`room:${roomId}`, memberId);
    return { ok: true, reloaded: false, message: "Member is not running — marked up to date; latest prompt, skills and tools apply on next activation." };
  }
  if (instance.status === "working" || instance.dispatchState !== "idle" || instance.promptInFlight) {
    throw new Error("Member is busy. Reload when the current turn is idle.");
  }
  if (!instance.handle.reloadResources) throw new Error("Runtime does not support in-place reload.");

  const agentDef = loadAgentDefinition(member.agent);
  if (!agentDef) throw new Error(`Agent definition not found: ${member.agent}`);
  const docsRootPath = join(getBossmodeDir(), "memory", "projects");
  const compiled = compileMemberPrompt({ room, member, agentDef, docsRoot: docsRootPath });
  const skills = resolveSkills(member, agentDef);
  const skillPaths = [
    ...resolveGlobalSkillPaths(skills),
  ];

  await instance.handle.reloadResources({
    roomId,
    member,
    agentPrompt: compiled.agentPrompt,
    appendSystemPrompt: compiled.appendSystemPrompt,
    skillPaths,
    skillNames: skills,
  });
  // Reload picked up new contract + mounts: refresh fingerprint, clear stale.
  setContractFingerprint(`room:${roomId}`, memberId, compiled.contractFingerprint, MEMBER_CONTRACT_VERSION);
  clearStaleMounts(`room:${roomId}`, memberId);
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
  clearRuntimeStateEntry(`room:${roomId}`, memberId);
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

/** Tear down every live instance for a topic after End topic (plan §2.1). */
export function destroyTopicInstances(topicId: string): number {
  const prefix = `topic:${topicId}:`;
  let n = 0;
  for (const [key, instance] of [...instances.entries()]) {
    if (!key.startsWith(prefix) && instance.scopeId !== `topic:${topicId}`) continue;
    try { instance.handle.abort(); } catch { /* ignore */ }
    try { instance.handle.destroy(); } catch { /* ignore */ }
    try { instance.unsubscribe(); } catch { /* ignore */ }
    instances.delete(key);
    contextUsageCache.delete(key);
    contextCompactionWarningCache.delete(key);
    n += 1;
  }
  logger.info("agent", "topic instances destroyed", { topicId, count: n });
  return n;
}

// -- DM activation (0.20, no @ required) -------------------------------------

export function memberRecordToConfig(memberId: string): AgentMemberConfig | null {
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
    // A successful chat call settles the reply debt — the fallback only fires
    // when the debt is still pending at settlement (no chat was called).
    if (event.type === "tool_end" && event.toolName === "chat" && !(event as any).isError) {
      clearPendingChatReply(instance, `tool:${event.toolName}`);
    }
    if (event.type === "agent_start") {
      // Fresh turn: reset final-text segment tracking so each turn is numbered independently.
      // Note: pi session retries also emit agent_start; segment reset is intentional per attempt.
      instance.turnSegmentSeq = 0;
      instance.lastCompletedFinalText = "";
      instance.lastCompletedFinalSeq = 0;
      instance.turnActive = true;
      if (instance.lengthContinuationPending) instance.lengthContinuationPending = false;
      updateDispatchState(instance, "running", event.type);
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
          if (instance.queuedInputs.length > 0) {
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
          && instance.dispatchState === "idle" && !instance.promptInFlight && instance.queuedInputs.length === 0;
        if (settled) {
          const compactionScopeId = instance.scopeId;
          const compactionMemberId = instance.memberId;
          const compactionKey = instanceKey(compactionScopeId, compactionMemberId);
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
      instance.queuedInputs = [];
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
      // Final-text capture: only *completed* segments are fallback candidates —
      // length truncation, provider errors and aborts never are (their text is
      // a broken fragment, not a reply). The final settlement posts the last
      // completed segment only when the reply debt is still pending.
      const aborted = event.stopReason === "aborted" || event.stopReason === "error" || Boolean((event as any).errorMessage);
      if (!instance.lastMessageEndWasLength && !aborted) {
        const text = (event.text || "").trim();
        if (text) {
          instance.turnSegmentSeq += 1;
          instance.lastCompletedFinalText = text;
          instance.lastCompletedFinalSeq = instance.turnSegmentSeq;
        }
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
      // Wake waiters with error before tearing down (processEvent does not idle this path).
      if (instance.status !== "idle") {
        transition(instance, roomId, memberName, "idle", event.type);
      } else {
        try { notifyMemberIdle(roomId, instance.memberId, { error: instance.lastTurnError }); } catch { /* ignore */ }
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

  const instance = await getOrCreateDm(memberId);
  // §10: no activate-heal — a live instance's binding can only change through
  // switchMemberModel (it applies to every instance atomically), so there is
  // no drift to heal here. Creation failure already posted a user-visible
  // notice inside getOrCreateDm; unconfigured is handled above.
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

    // Birth icebreaker (identity batch 1): empty persona → ask user to initialize.
    let birthBlank = false;
    try {
      const { readMemberProfile, isBlankPersona } = await import("../workspace/member-profile.js");
      birthBlank = isBlankPersona(readMemberProfile(memberId, rec.name));
    } catch { /* profile module optional in tests */ }

    let prompt: string;
    if (transcript) {
      prompt = `You are in a private chat with the user. Recent messages:\n\n${transcript}\n\nRespond to the latest user message with the chat tool.`;
    } else if (birthBlank) {
      prompt = `You are in a private chat with the user. You just came online with a blank persona (your member.md body is empty). Your first action must be a chat call: introduce yourself by name in one short line, say you are starting from a blank slate, and ask what they want you around for. Do not call other tools first. After they answer, use the edit tool on your member.md body (the ## Persona section — create it if missing) to record what you learned.`;
    } else {
      prompt = `You are in a private chat with the user. They just opened the conversation. Greet briefly with the chat tool, or wait for their request.`;
    }

    if (instance.compacting) {
      queueInput(instance, prompt, "message-during-compaction");
      return;
    }
    if (instance.status === "working") {
      // Interrupt-on-message (design v1.1): DM messages interrupt a working run.
      interruptWorkingInstance(scopeId, instance, prompt,
        "Your previous turn was interrupted by this message. Shell commands keep running. Check shell_list for running commands and use shell_wait to collect their results before continuing dependent work.",
        "dm-message-interrupt");
      return;
    }
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

// -- Topic activation (plan-topic-threads-v1 batch 1, fresh seed) -------------

/** Interrupt a working member so a new message is processed immediately
 * (design-interrupt-on-message-v1). Shared by room, DM and topic activation:
 * abort the run (shell commands keep running and tool waits return normally), then park
 * the banner-wrapped prompt at the FRONT of the queue so it runs the moment
 * the abort settles. */
function interruptWorkingInstance(scopeId: string, instance: AgentInstance, prompt: string, banner: string, trigger: string): void {
  if (instance.compacting) {
    queueInput(instance, prompt, trigger);
    return;
  }
  try { settleWaitOnAbort(scopeId, instance.memberId); } catch { /* ignore */ }
  // Blocking shell_exec waits end now (running + exec id) so the gentle abort
  // is not held hostage by a blockUntilMs wait (qa rc.22 note ①).
  try { settleMemberShellWaits(instance.memberId); } catch { /* ignore */ }
  // Background waits end the same way: the tool returns the task's real
  // current status; the task itself keeps running (independent controller).
  try { settleBackgroundWaits(instance.memberId); } catch { /* ignore */ }
  instance.handle.abort({ preserveCompaction: true });
  updateDispatchState(instance, "aborting", trigger);
  instance.queuedInputs.unshift(`${banner}\n\n${prompt}`);
  logger.info("agent", "messageInterrupt", { member: instance.agentName, memberId: instance.memberId, roomId: scopeId, trigger, queueDepth: instance.queuedInputs.length });
}

function topicInstanceKey(topicId: string, memberId: string): string {
  return scopeInstanceKey(scopeIdOf({ kind: "topic", topicId, roomId: "" }), memberId);
}

async function getOrCreateTopic(parentRoomId: string, topicId: string, memberId: string): Promise<AgentInstance | null> {
  const room = roomStore.getRoom(parentRoomId);
  if (!room) {
    logger.error("agent", "topic parent room not found", { parentRoomId, topicId });
    return null;
  }
  return buildMemberAgentSession(memberId, scopeIdOf({ kind: "topic", topicId, roomId: parentRoomId }));
}

/**
 * Activate a room member inside a topic (batch 1: fresh seed + guide message).
 * Does not touch the parent room instance.
 */
export async function activateTopicMember(parentRoomId: string, topicId: string, memberRef: string): Promise<void> {
  const {
    getTopic,
    addTopicParticipant,
    buildTopicGuideText,
    getTopicCursors,
    setTopicCursor,
    getTopicMessagesSince,
    getLatestTopicMessageId,
  } = await import("../workspace/topic-store.js");
  const topic = getTopic(parentRoomId, topicId);
  if (!topic || topic.status !== "active") {
    logger.warn("agent", "activateTopicMember: topic missing or closed", { parentRoomId, topicId });
    return;
  }
  const roomMember = resolveRoomMember(parentRoomId, memberRef);
  const memberId = roomMember?.id || memberRef;
  const memberName = roomMember?.name || memberRef;

  const instance = await getOrCreateTopic(parentRoomId, topicId, memberId);
  if (!instance) return;

  addTopicParticipant(parentRoomId, topicId, memberId);

  const scopeId = instance.scopeId;
  const roomName = roomStore.getRoom(parentRoomId)?.name || parentRoomId;
  const cursors = getTopicCursors(parentRoomId, topicId);
  const lastCursor = cursors[memberId] ?? cursors[memberName] ?? null;
  const allNew = getTopicMessagesSince(parentRoomId, topicId, lastCursor);
  const visible = filterAgentVisibleMessages(allNew, memberName);

  let formattedTrigger = "";
  if (visible.length > 0) {
    const triggerIdx = lastMentionTriggerIndex(visible, memberName);
    const trigger = visible[triggerIdx >= 0 ? triggerIdx : visible.length - 1];
    formattedTrigger = formatMessagesForAgent(scopeId, [trigger], memberName, roomName);
    setTopicCursor(parentRoomId, topicId, memberId, trigger.id);
  } else {
    const latest = getLatestTopicMessageId(parentRoomId, topicId);
    if (latest) setTopicCursor(parentRoomId, topicId, memberId, latest);
  }

  setActivationSource(scopeId, memberName, "room_mention");
  try {
    const guide =
      topic.guideText
      || buildTopicGuideText({
        title: topic.title,
        roomName,
        roomId: parentRoomId,
        anchorExcerpt: "",
        seedMode: topic.seedMode,
      });

    const prompt = [
      guide,
      formattedTrigger,
      `[REPLY EXPECTED] You were mentioned in this topic. Respond with the chat tool in this topic scope.`,
    ].filter(Boolean).join("\n\n");

    if (instance.compacting) {
      queueInput(instance, prompt, "message-during-compaction");
      return;
    }
    if (instance.status === "working") {
      // Interrupt-on-message (design v1.1): topic mentions interrupt a working run.
      interruptWorkingInstance(scopeId, instance, prompt,
        "Your previous turn was interrupted by this message. Shell commands keep running. Check shell_list for running commands and use shell_wait to collect their results before continuing dependent work.",
        "topic-message-interrupt");
      return;
    }
    if (instance.dispatchState !== "idle" || instance.promptInFlight) {
      queueInput(instance, prompt, "topic-activate");
      return;
    }
    markPendingChatReply(instance, "topic-activate");
    await runPrompt(instance, prompt, "activate", (err) => {
      logger.error("agent", "topic prompt failed", {
        memberId,
        topicId,
        error: formatRuntimeErrorMessage(err),
      });
    });
  } finally {
    clearActivationSource(scopeId, memberName);
  }
}

/** Abort a live topic instance only. No topic instance → error, never touch the room instance. */
async function interruptTopicMember(parentRoomId: string, topicId: string, memberRef: string, urgentByName: string): Promise<{ ok: boolean; action: string }> {
  const roomMember = resolveRoomMember(parentRoomId, memberRef);
  const memberId = roomMember?.id || memberRef;
  const memberName = roomMember?.name || memberRef;
  const key = topicInstanceKey(topicId, memberId);
  const instance = instances.get(key);
  if (!instance) {
    postMessage(`topic:${topicId}`, "system", `Member "${memberName}" is not in this topic.`);
    logger.info("agent", "urgentInterruptNotInTopic", { member: memberName, memberId, topicId, urgentBy: urgentByName });
    return { ok: false, action: "not_in_topic" };
  }
  if (instance.compacting) {
    await activateTopicMember(parentRoomId, topicId, memberRef);
    return { ok: true, action: "queued" };
  }
  if (instance.status === "working") {
    try { settleWaitOnAbort(`topic:${topicId}`, memberId); } catch { /* ignore */ }
    try { settleMemberShellWaits(memberId); } catch { /* ignore */ }
    try { settleBackgroundWaits(memberId); } catch { /* ignore */ }
    try { instance.handle.abort({ preserveCompaction: true }); } catch { /* ignore */ }
    updateDispatchState(instance, "aborting", "urgent_interrupt");
    postMessage(`topic:${topicId}`, "system", `Member "${memberName}"'s current turn was aborted by an urgent message from ${urgentByName}.`);
    logger.info("agent", "urgentInterruptAbort", { member: memberName, memberId, roomId: `topic:${topicId}`, urgentBy: urgentByName });
  }
  await activateTopicMember(parentRoomId, topicId, memberRef);
  return { ok: true, action: instance.status === "working" ? "interrupted" : "activated" };
}

async function activateAllTopicMembers(parentRoomId: string, topicId: string): Promise<void> {
  for (const m of roomStore.getRoomMembers(parentRoomId)) {
    await activateTopicMember(parentRoomId, topicId, m.id);
  }
}

/** Single mention-router wiring for production server + acceptance tests (no topic: leak into room getOrCreate). */
export function wireMentionRouter(): () => void {
  return initRouter(
    (scopeId, memberRef, ctx) => {
      if (scopeId.startsWith("topic:")) {
        const topicId = scopeId.slice("topic:".length);
        const parent = resolveTopicParent(topicId);
        if (!parent) return;
        activateTopicMember(parent, topicId, memberRef).catch((err) => {
          logger.error("router", "topic activate failed", { topicId, member: memberRef, error: String(err) });
        });
        return;
      }
      activateAgent(scopeId, memberRef, ctx).catch((err) => {
        logger.error("router", "activate failed", { roomId: scopeId, member: memberRef, error: String(err) });
      });
    },
    (scopeId, ctx) => {
      if (scopeId.startsWith("topic:")) {
        const topicId = scopeId.slice("topic:".length);
        const parent = resolveTopicParent(topicId);
        if (!parent) return;
        activateAllTopicMembers(parent, topicId).catch((err) => {
          logger.error("router", "topic activateAll failed", { topicId, error: String(err) });
        });
        return;
      }
      activateAll(scopeId, ctx).catch((err) => {
        logger.error("router", "activateAll failed", { roomId: scopeId, error: String(err) });
      });
    },
    (scopeId, memberRef, urgentByName) => {
      if (scopeId.startsWith("topic:")) {
        const topicId = scopeId.slice("topic:".length);
        const parent = resolveTopicParent(topicId);
        if (!parent) return;
        interruptTopicMember(parent, topicId, memberRef, urgentByName).catch((err) => {
          logger.error("router", "topic urgent interrupt failed", { topicId, member: memberRef, error: String(err) });
        });
        return;
      }
      interruptAgent(scopeId, memberRef, urgentByName).catch((err) => {
        logger.error("router", "urgent interrupt failed", { roomId: scopeId, member: memberRef, error: String(err) });
      });
    },
  );
}

function resolveTopicParent(topicId: string): string | null {
  const parent = resolveTopicRoomId(topicId);
  if (!parent) logger.error("router", "topic parent room not found", { topicId });
  return parent;
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
