// Agent Manager — agent lifecycle management (slimmed down)
// Prompt assembly → engine/prompt-assembler.ts
// Event handling → engine/event-handler.ts
// Tool callbacks → engine/tools.ts

import { join } from "node:path";
import { logger } from "../foundation/logger.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { getMemberByName } from "../workforce/member-store.js";
import { resolveRoomMember } from "../workforce/room-member-resolver.js";
import { getBossmodeDir, readConfig } from "../shared/config.js";
import { isRuntimeFailureRoomMessage } from "../shared/runtime-error-limit.js";
import * as roomStore from "../workspace/room-store.js";
import * as sessionStore from "../workspace/session-store.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import { postMessage, getMessagesSince, getLatestMessageId } from "../communication/message-bus.js";
import { parseMentions } from "../communication/router.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../communication/ws.js";
import { compileMemberPrompt } from "./prompt-compiler.js";
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
import { exportPiConfigForMember, listAvailableModels, normalizeModelRef } from "./model-credentials.js";
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
  return message;
}

function isMemberRuntimeFailureMessage(message: RoomMessage): boolean {
  return isRuntimeFailureRoomMessage(message);
}

function isMemberConfigured(member: AgentMemberConfig): boolean {
  return Boolean(member.model && member.credentialId);
}

function memberUnconfiguredMessage(memberName: string): string {
  return `Member "${memberName}" hasn't selected a model yet. Open the member card to choose a model and credential, then try again.`;
}

function filterAgentVisibleMessages(messages: RoomMessage[], _memberName: string): RoomMessage[] {
  return messages.filter((message) => !isMemberRuntimeFailureMessage(message));
}

interface PendingModelSwitch {
  model: string;
  credentialId?: string;
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
  roomId: string;
  memberId: string;
  agentName: string; // current member name snapshot for display/mentions
  sourceAgent: string;
  status: AgentStatus;
  dispatchState: DispatchState;
  promptInFlight: boolean;
  queuedInputs: string[];
  pendingModelSwitch?: PendingModelSwitch;
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

function instanceKey(roomId: string, memberId: string): string {
  return `${roomId}:${memberId}`;
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
  applyPendingModelSwitch(instance, trigger);
  applyPendingThinkingSwitch(instance, trigger);
}

function isSummarizerInstance(instance: AgentInstance): boolean {
  return instance.sourceAgent === "summarizer";
}

function markPendingChatReply(instance: AgentInstance, trigger: string): void {
  if (isSummarizerInstance(instance)) return;
  if (!instance.pendingChatReply) logger.info("agent", "pendingChatReplySet", { member: instance.agentName, roomId: instance.roomId, trigger });
  instance.pendingChatReply = true;
}

function clearPendingChatReply(instance: AgentInstance, trigger: string): void {
  if (!instance.pendingChatReply) return;
  instance.pendingChatReply = false;
  logger.info("agent", "pendingChatReplyCleared", { member: instance.agentName, roomId: instance.roomId, trigger });
}

const LENGTH_CONTINUATION_PROMPT = "⚠ Your previous response was cut off due to output length. Continue from where you stopped and deliver the result with a `chat` call.";
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
  if (!instance.lengthContinuationPending || opts.skipChatWarning || isSummarizerInstance(instance)) return false;
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
  if (instance.pendingChatReply && !opts.skipChatWarning && !instance.hadErrorInTurn && !isSummarizerInstance(instance)) {
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

function shouldRecreateForModelSwitch(instance: AgentInstance, credentialId?: string): boolean {
  return instance.appliedCredentialId !== credentialId;
}

async function recreateInstanceForModelSwitch(instance: AgentInstance, model: string, credentialId: string | undefined, trigger: string): Promise<void> {
  const key = instanceKey(instance.roomId, instance.memberId);
  const queuedInputs = instance.queuedInputs.splice(0);
  try { await instance.handle.waitForIdle?.(); } catch {}
  try { instance.unsubscribe(); } catch {}
  try { instance.handle.destroy(); } catch {}
  if (instances.get(key) === instance) instances.delete(key);
  contextUsageCache.delete(key);
  contextCompactionWarningCache.delete(key);

  const next = await getOrCreate(instance.roomId, instance.memberId);
  if (!next) throw new Error(`Failed to recreate member "${instance.agentName}" for model switch`);
  next.queuedInputs.push(...queuedInputs);
  next.appliedModel = model;
  next.appliedCredentialId = credentialId;
  logger.info("agent", "modelSwitchRecreated", { member: instance.agentName, roomId: instance.roomId, model, trigger });
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: next.status });
}

async function applyModelSwitchToInstance(instance: AgentInstance, pending: PendingModelSwitch, trigger: string): Promise<void> {
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

  if (shouldRecreateForModelSwitch(instance, resolvedCredentialId)) {
    await recreateInstanceForModelSwitch(instance, model, resolvedCredentialId, trigger);
    return;
  }

  if (!instance.handle.setModel) throw new Error("Runtime does not support dynamic model switching");
  await instance.handle.refreshModelRegistry?.();
  await instance.handle.setModel(model);
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

function applyPendingModelSwitch(instance: AgentInstance, trigger: string): void {
  const pending = instance.pendingModelSwitch;
  if (!pending) return;
  instance.pendingModelSwitch = undefined;
  applyModelSwitchToInstance(instance, pending, trigger).catch((err) => {
    logger.error("agent", "modelSwitchFailed", { member: instance.agentName, roomId: instance.roomId, error: String(err) });
    postMessage(instance.roomId, "system", `Failed to switch model for "${instance.agentName}": ${err.message || String(err)}`);
  });
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
  try { instance.unsubscribe(); } catch {}
  try { instance.handle.destroy(); } catch {}
  instance.status = "inactive";
  updateDispatchState(instance, "idle", "credential_unavailable");
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, ...memberIdentityMeta(instance.agentName, instance.memberId), status: "inactive" });
  logger.warn("agent", "credentialRefreshUnavailable", { member: instance.agentName, roomId: instance.roomId, reason });
  postMessage(instance.roomId, "system", `Member "${instance.agentName}" model credential is no longer available. Update Settings → Model Credentials or choose another model before the next turn.`);
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

    await instance.handle.refreshModelRegistry();
    await instance.handle.setModel(instance.appliedModel);
    if (instance.handle.runtimeParams) {
      instance.handle.runtimeParams.model = instance.appliedModel;
      instance.handle.runtimeParams.credentialId = exported.profile?.id || instance.appliedCredentialId;
      instance.handle.runtimeParams.credentialName = exported.profile?.name;
    }
    instance.appliedCredentialId = exported.profile?.id || instance.appliedCredentialId;
    logger.info("agent", "credentialRefreshApplied", { member: instance.agentName, roomId: instance.roomId, profileId: pending.profileId, providerSlug: pending.providerSlug, trigger });
  } catch (err) {
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
  const results: Array<{ roomId: string; memberName: string; applied: boolean; pending: boolean }> = [];
  for (const instance of Array.from(instances.values())) {
    if (!instanceUsesCredentialProfile(instance, profileId)) continue;
    if (instance.status === "working" || instance.dispatchState !== "idle") {
      instance.pendingCredentialRefresh = pending;
      logger.info("agent", "credentialRefreshQueued", { member: instance.agentName, roomId: instance.roomId, profileId, providerSlug, status: instance.status, dispatchState: instance.dispatchState });
      results.push({ roomId: instance.roomId, memberName: instance.agentName, applied: false, pending: true });
      continue;
    }
    try {
      await applyCredentialRefreshToInstance(instance, pending, "credentialProfileInvalidated");
      results.push({ roomId: instance.roomId, memberName: instance.agentName, applied: true, pending: false });
    } catch (err: any) {
      logger.error("agent", "credentialRefreshFailed", { member: instance.agentName, roomId: instance.roomId, error: String(err) });
      postMessage(instance.roomId, "system", `Failed to refresh model credential for "${instance.agentName}": ${err.message || String(err)}`);
      results.push({ roomId: instance.roomId, memberName: instance.agentName, applied: false, pending: false });
    }
  }
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
    return { msg: m, role: resolveSenderRole(m.sender) as SenderRole, isSummary: m.type === "summary" };
  });

  const nonSummary = items.filter((i) => !i.isSummary);

  // Single non-summary message → single-message envelope.
  if (nonSummary.length === 1) {
    const parts: string[] = [];
    for (const item of items) {
      if (item.isSummary) parts.push(item.msg.content);
      else parts.push(wrapRoomContextMessage(item.msg, roomName, item.role));
    }
    return parts.join("\n\n");
  }

  // Multiple messages → shared transcript envelope (each message keeps its own
  // full sub-header with seq + timestamp so it can be referenced individually).
  const transcript = wrapRoomMessagesTranscript(
    nonSummary.map((i) => ({ msg: i.msg, role: i.role })),
    roomName,
  );
  const summaryParts = items.filter((i) => i.isSummary).map((i) => i.msg.content);
  return [transcript, ...summaryParts].join("\n\n");
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

  const member = resolveRoomMember(roomId, memberRef);
  if (!member) {
    logger.error("agent", "no member or agent definition found", { name: memberRef });
    return null;
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

    const agentDef = loadAgentDefinition(member.agent);
    if (!agentDef) {
      logger.error("agent", "agent definition not found", { member: memberName, agent: member.agent });
      return null;
    }

    const runtime = registry.get(member.runtime);
    if (!runtime) {
      logger.error("agent", "runtime not found", { member: memberName, runtime: member.runtime });
      return null;
    }

    const docsRootPath = join(getBossmodeDir(), "knowledge", "docs");
    const compiled = compileMemberPrompt({ room, member, agentDef, docsRoot: docsRootPath });

    // Resolve skills: member config takes precedence over agent definition
    const skills = resolveSkills(member, agentDef);
    const skillPaths = skills.map((s) => join(getBossmodeDir(), "skills", s));

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
            if (active) clearPendingChatReply(active, "callback:chat");
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
        appliedModel: member.model!,
        appliedCredentialId: member.credentialId,
      };

      const unsubscribe = handle.subscribe((event: AgentStreamEvent) => {
        const newStatus = processEvent(roomId, memberName, key, event, instance.eventBuffer, memberId);
        if (event.type === "tool_end" && (event.toolName === "chat" || event.toolName === "write_summary") && !(event as any).isError) {
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
          // a newline, post the content after the last marker to the room. Checked on
          // every message_end so members can speak while working, not just at turn end.
          // Skipped on error turns and on length-truncated intermediate messages (the
          // final settled message is the one that counts).
          if (event.stopReason !== "error" && !instance.lastMessageEndWasLength) {
            const roomText = extractRoomMarkerText(event.text || "");
            if (roomText !== null) {
              const members = roomStore.getRoomMembers(roomId);
              const mentions = parseMentions(roomText, members.map((m: any) => m.name));
              const target = mentions.length === 1 ? roomStore.resolveRoomMemberRef(roomId, mentions[0]) : undefined;
              postMessage(roomId, memberName, roomText, mentions, { senderMemberId: memberId, mentionMemberIds: target ? [target.id] : [] });
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

        // Unexpected runtime exit: notify room and drop dead instance so next mention respawns.
        if (event.type === "runtime_exit" && event.unexpected) {
          const codeStr = event.code !== null ? `exit ${event.code}` : (event.signal ? `signal ${event.signal}` : "terminated");
          const detail = event.stderrTail ? `\n${event.stderrTail}` : "";
          postMessage(roomId, "system", `Member "${memberName}" runtime ended unexpectedly (${codeStr}).${detail}`);
          logger.warn("agent", "instance removed after unexpected exit", {
            member: memberName, roomId, code: event.code, signal: event.signal,
          });
          if (instances.get(key) === instance) instances.delete(key);
          try { instance.unsubscribe(); } catch {}
          try { handle.destroy(); } catch {}
        }
      });
      instance.unsubscribe = unsubscribe;

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
    postMessage(roomId, "system", `Failed to activate member "${memberName}": not found or runtime unavailable.`);
    return;
  }

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

  setActivationSource(roomId, memberId, "room_mention");
  markPendingChatReply(instance, "activate");

  if (instance.compacting) {
    queueInput(instance, formattedMessages, "activate");
    return;
  }

  if (instance.status === "working") {
    instance.handle.steer(formattedMessages);
    return;
  }

  if (instance.dispatchState !== "idle") {
    queueInput(instance, formattedMessages, "activate");
    return;
  }

  logger.info("agent", "prompt", { member: memberName, messageLength: formattedMessages.length });
  await runPrompt(instance, formattedMessages, "activate", (err) => {
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

export async function switchMemberModel(roomId: string, memberRef: string, model: string, credentialId?: string | null, persistRoomOverride = true): Promise<{ applied: boolean; pending: boolean; active: boolean; model: string }> {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const memberName = member?.name || memberRef;
  const normalizedModel = normalizeSwitchModelRef(model);
  const available = listAvailableModels().some((m) => m.ref === normalizedModel);
  if (!available) throw new Error(`Model is not available or credential is missing: ${normalizedModel}`);
  if (persistRoomOverride) roomStore.updateRoomMemberOverride(roomId, memberId, { model: normalizedModel, credentialId: credentialId || null });

  const key = instanceKey(roomId, memberId);
  const instance = instances.get(key);
  if (!instance) return { applied: false, pending: false, active: false, model: normalizedModel };

  const pending = { model: normalizedModel, credentialId: credentialId || undefined };
  if (instance.status === "working" || instance.dispatchState !== "idle") {
    instance.pendingModelSwitch = pending;
    logger.info("agent", "modelSwitchQueued", { member: memberName, memberId, roomId, model: normalizedModel, status: instance.status, dispatchState: instance.dispatchState });
    return { applied: false, pending: true, active: true, model: normalizedModel };
  }

  await applyModelSwitchToInstance(instance, pending, "switchMemberModel");
  return { applied: true, pending: false, active: true, model: normalizedModel };
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

  // Abort via stdin protocol, keep instance alive. Public idle waits for runtime agent_end.
  instance.handle.abort();
  updateDispatchState(instance, "aborting", "abort");
  instance.queuedInputs = [];
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
  const skillPaths = skills.map((s) => join(getBossmodeDir(), "skills", s));

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
