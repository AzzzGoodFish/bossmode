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
import * as roomStore from "../workspace/room-store.js";
import * as sessionStore from "../workspace/session-store.js";
import * as knowledgeStore from "../knowledge/store.js";
import { postMessage, getMessagesSince, getLatestMessageId } from "../communication/message-bus.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../communication/ws.js";
import { buildAgentPrompt } from "./prompt-assembler.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk, appendEventToDisk } from "./event-handler.js";
import {
  wrapPrivateMessage,
  wrapRoomContextMessage,
  wrapRoomMentionMessage,
  resolveSenderRole,
  ROOM_REPLY_FOOTER,
  PRIVATE_REPLY_FOOTER,
} from "./message-envelope.js";
import {
  setActivationSource,
  clearActivationSource,
  clearAllActivationSources,
} from "./activation-context.js";
import { USER_DISPLAY_NAME } from "../shared/user-identity.js";
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
  agentName: string;
  status: AgentStatus;
  dispatchState: DispatchState;
  queuedInputs: string[];
  pendingModelSwitch?: PendingModelSwitch;
  pendingThinkingSwitch?: PendingThinkingSwitch;
  pendingCredentialRefresh?: PendingCredentialRefresh;
  unsubscribe: () => void;
  eventBuffer: AgentHistoryEvent[];
  appliedModel: string;
  appliedProvider: string;
  appliedCredentialId?: string;
}

const instances = new Map<string, AgentInstance>();
const pendingCreations = new Map<string, Promise<AgentInstance | null>>();

function instanceKey(roomId: string, agentName: string): string {
  return `${roomId}:${agentName}`;
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
  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: memberName, status: newStatus });
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

function normalizeSwitchModelRef(model: string): string {
  const ref = normalizeModelRef(model.trim());
  const idx = ref.indexOf("/");
  return idx > 0 ? ref : `anthropic/${ref}`;
}

function providerFromModelRef(model: string): string {
  const ref = normalizeSwitchModelRef(model);
  const idx = ref.indexOf("/");
  return idx > 0 ? ref.slice(0, idx) : "anthropic";
}

function shouldRecreateForModelSwitch(instance: AgentInstance, model: string, credentialId?: string): boolean {
  return instance.appliedProvider !== providerFromModelRef(model) || instance.appliedCredentialId !== credentialId;
}

async function recreateInstanceForModelSwitch(instance: AgentInstance, model: string, credentialId: string | undefined, trigger: string): Promise<void> {
  const key = instanceKey(instance.roomId, instance.agentName);
  const queuedInputs = instance.queuedInputs.splice(0);
  try { await instance.handle.waitForIdle?.(); } catch {}
  try { instance.unsubscribe(); } catch {}
  try { instance.handle.destroy(); } catch {}
  if (instances.get(key) === instance) instances.delete(key);
  contextUsageCache.delete(key);

  const next = await getOrCreate(instance.roomId, instance.agentName);
  if (!next) throw new Error(`Failed to recreate member "${instance.agentName}" for model switch`);
  next.queuedInputs.push(...queuedInputs);
  next.appliedModel = model;
  next.appliedProvider = providerFromModelRef(model);
  next.appliedCredentialId = credentialId;
  logger.info("agent", "modelSwitchRecreated", { member: instance.agentName, roomId: instance.roomId, model, trigger });
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, status: next.status });
}

async function applyModelSwitchToInstance(instance: AgentInstance, pending: PendingModelSwitch, trigger: string): Promise<void> {
  const model = normalizeSwitchModelRef(pending.model);
  const credentialId = pending.credentialId;
  const exported = exportPiConfigForMember({
    roomId: instance.roomId,
    memberName: instance.agentName,
    modelRef: model,
    credentialId,
  });
  if (!exported) throw new Error(`No model credentials configured for ${model}`);
  const resolvedCredentialId = exported.profile?.id || credentialId;

  if (shouldRecreateForModelSwitch(instance, model, resolvedCredentialId)) {
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
  instance.appliedProvider = providerFromModelRef(model);
  instance.appliedCredentialId = resolvedCredentialId;
  logger.info("agent", "modelSwitchApplied", { member: instance.agentName, roomId: instance.roomId, model, trigger });
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, status: instance.status });
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
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, status: instance.status });
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

function instanceUsesCredentialProfile(instance: AgentInstance, profileId: string, providerSlug: string): boolean {
  return instance.appliedCredentialId === profileId || (!instance.appliedCredentialId && instance.appliedProvider === providerSlug);
}

function dropInstanceAfterCredentialUnavailable(instance: AgentInstance, reason: string): void {
  const key = instanceKey(instance.roomId, instance.agentName);
  if (instances.get(key) === instance) instances.delete(key);
  contextUsageCache.delete(key);
  try { instance.unsubscribe(); } catch {}
  try { instance.handle.destroy(); } catch {}
  instance.status = "inactive";
  updateDispatchState(instance, "idle", "credential_unavailable");
  broadcastToRoom(instance.roomId, { type: "agent:status", roomId: instance.roomId, agent: instance.agentName, status: "inactive" });
  logger.warn("agent", "credentialRefreshUnavailable", { member: instance.agentName, roomId: instance.roomId, reason });
  postMessage(instance.roomId, "system", `Member "${instance.agentName}" model credential is no longer available. Update Settings → Model Credentials or choose another model before the next turn.`);
}

async function applyCredentialRefreshToInstance(instance: AgentInstance, pending: PendingCredentialRefresh, trigger: string): Promise<void> {
  try {
    const exported = exportPiConfigForMember({
      roomId: instance.roomId,
      memberName: instance.agentName,
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
    if (!instanceUsesCredentialProfile(instance, profileId, providerSlug)) continue;
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

function formatMessagesForAgent(messages: RoomMessage[], receiver: string, roomName: string): string {
  if (messages.length === 0) return "";

  let triggerIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.type === "summary") continue;
    if (Array.isArray(msg.mentions) && msg.mentions.includes(receiver)) {
      triggerIdx = i;
      break;
    }
  }

  if (triggerIdx === -1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type !== "summary") {
        triggerIdx = i;
        break;
      }
    }
  }

  const wrapped = messages.map((m, idx) => {
    if (m.type === "summary") return m.content;
    const senderRole = resolveSenderRole(m.sender);
    if (idx === triggerIdx) {
      return wrapRoomMentionMessage(m, roomName, senderRole, receiver);
    }
    return wrapRoomContextMessage(m, roomName, senderRole);
  });

  if (triggerIdx >= 0) wrapped.push(ROOM_REPLY_FOOTER);
  return wrapped.join("\n\n");
}

// Resolve skills: member config > agent definition > empty
function resolveSkills(member: AgentMemberConfig, agentDef: { skills?: string[] }): string[] {
  return member.skills ?? agentDef.skills ?? [];
}

// -- Instance creation --

async function getOrCreate(roomId: string, memberName: string): Promise<AgentInstance | null> {
  const key = instanceKey(roomId, memberName);
  const existing = instances.get(key);
  if (existing) return existing;

  const pending = pendingCreations.get(key);
  if (pending) return pending;

  const creation = (async (): Promise<AgentInstance | null> => {
    if (!registry) {
      logger.error("agent", "runtime registry not initialized");
      return null;
    }

    logger.info("agent", "getOrCreate", { member: memberName, roomId, found: false });

    const room = roomStore.getRoom(roomId);
    if (!room) {
      logger.error("agent", "room not found", { roomId });
      return null;
    }

    const member = resolveRoomMember(roomId, memberName);
    if (!member) {
      logger.error("agent", "no member or agent definition found", { name: memberName });
      return null;
    }
    logger.info("agent", "loadMember", { member: memberName, source: "room-effective", agent: member.agent, runtime: member.runtime, model: member.model, thinkingLevel: member.thinkingLevel });

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

    // Load global document tree (injected as index) + active rule docs
    // (injected as full content). The tree is always present; rules depend on
    // what the room explicitly picks via room.ruleDocs.
    const knowledgeEntries = knowledgeStore.listEntries();
    const tree = knowledgeStore.getDocumentTree();

    const ruleDocPaths: string[] = Array.isArray(room.ruleDocs) ? room.ruleDocs : [];

    let rulesPrompt: string | undefined;
    if (ruleDocPaths.length > 0) {
      const rules = ruleDocPaths
        .map((p) => knowledgeStore.getEntry(p))
        .filter(Boolean);
      if (rules.length > 0) {
        rulesPrompt = rules.map((r) => `# ${r!.title}\n\n${r!.content}`).join("\n\n---\n\n");
      }
    }

    const docsRootPath = join(getBossmodeDir(), "knowledge", "docs");
    const assembled = buildAgentPrompt(agentDef, knowledgeEntries, room.members, room.name, memberName, tree, ruleDocPaths, docsRootPath);

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
    const savedSession = sessions[memberName];
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
        agentPrompt: assembled.agentPrompt,
        envPrompt: assembled.envPrompt,
        skillPaths,
        skillNames: skills,
        rulesPrompt,
        roomMembers: room.members,
        resumeSession,
        onSessionChanged: (session) => {
          sessionStore.saveSession(roomId, memberName, {
            runtime: member.runtime,
            sessionId: session.sessionId,
            sessionFile: session.sessionFile,
          });
          logger.info("agent", "sessionSaved", { member: memberName, sessionId: session.sessionId, sessionFile: session.sessionFile });
        },
        callbacks: {
          onChat: async (message: string) => {
            postMessage(roomId, memberName, message);
          },
          onMention: async (targetMember: string, message: string) => {
            // Mention activation is handled by router listener via message-bus.
            postMessage(roomId, memberName, message, [targetMember]);
          },
        },
      });

      logger.info("agent", "agentCreated", { member: memberName, agent: member.agent, runtime: member.runtime, roomId });

      const instance: AgentInstance = {
        handle,
        roomId,
        agentName: memberName,
        status: "idle",
        dispatchState: "idle",
        queuedInputs: [],
        unsubscribe: () => {},
        eventBuffer: [],
        appliedModel: normalizeSwitchModelRef(member.model || "claude-sonnet-4-6"),
        appliedProvider: providerFromModelRef(member.model || "claude-sonnet-4-6"),
        appliedCredentialId: member.credentialId || handle.runtimeParams?.credentialId,
      };

      const unsubscribe = handle.subscribe((event: AgentStreamEvent) => {
        const newStatus = processEvent(roomId, memberName, key, event, instance.eventBuffer);
        if (event.type === "agent_start") {
          updateDispatchState(instance, "running", event.type);
          flushQueuedInputs(instance, event.type);
        } else if (event.type === "agent_end") {
          updateDispatchState(instance, "idle", event.type);
          applyPendingCredentialRefresh(instance, event.type);
          applyPendingModelSwitch(instance, event.type);
          applyPendingThinkingSwitch(instance, event.type);
        } else if (event.type === "runtime_exit" && event.unexpected) {
          updateDispatchState(instance, "idle", event.type);
          instance.queuedInputs = [];
        }
        if (newStatus) transition(instance, roomId, memberName, newStatus, event.type);

        if (event.type === "message_end" && event.stopReason === "error") {
          const formattedError = typeof event.errorMessage === "string" ? formatRuntimeErrorMessage(event.errorMessage).trim() : "";
          const detail = formattedError
            ? ` Error: ${formattedError}`
            : " An unrecoverable provider error occurred.";
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

export async function activateAgent(roomId: string, memberName: string): Promise<void> {
  logger.info("agent", "activateAgent", { roomId, member: memberName });

  const instance = await getOrCreate(roomId, memberName);
  if (!instance) {
    postMessage(roomId, "system", `Failed to activate member "${memberName}": not found or runtime unavailable.`);
    return;
  }

  const cursors = roomStore.getCursors(roomId);
  const lastCursor = cursors[memberName] ?? null;
  const allNewMessages = getMessagesSince(roomId, lastCursor);
  const latestId = getLatestMessageId(roomId);
  if (latestId) roomStore.setCursor(roomId, memberName, latestId);
  if (allNewMessages.length === 0) return;

  // Context limit
  const member = resolveRoomMember(roomId, memberName);
  const contextLimit = (member as any)?.contextLimit || 50;
  const newMessages = allNewMessages.length > contextLimit
    ? allNewMessages.slice(-contextLimit)
    : allNewMessages;

  logger.info("agent", "incrementalMessages", { member: memberName, count: newMessages.length, total: allNewMessages.length, cursorFrom: lastCursor });

  const formattedMessages = formatMessagesForAgent(newMessages, memberName, roomStore.getRoom(roomId)?.name || roomId);

  setActivationSource(roomId, memberName, "room_mention");

  if (instance.dispatchState === "running" || instance.status === "working") {
    instance.handle.steer(formattedMessages);
    return;
  }

  if (instance.dispatchState === "promptSubmitted" || instance.dispatchState === "aborting") {
    queueInput(instance, formattedMessages, "activate");
    return;
  }

  logger.info("agent", "prompt", { member: memberName, messageLength: formattedMessages.length });
  updateDispatchState(instance, "promptSubmitted", "activate");
  try {
    await instance.handle.prompt(formattedMessages);
    if ((instance.dispatchState as DispatchState) !== "running") updateDispatchState(instance, "idle", "activate_prompt_resolved");
  } catch (err: any) {
    logger.error("agent", `prompt error`, { member: memberName, error: formatRuntimeErrorMessage(err) });
    postMessage(roomId, "system", `Member "${memberName}" error: ${formatRuntimeErrorMessage(err)}`);
    updateDispatchState(instance, "idle", "activate_prompt_error");
    instance.queuedInputs = [];
  }
}

// -- @all broadcast --

export async function activateAll(roomId: string): Promise<void> {
  const room = roomStore.getRoom(roomId);
  if (!room) return;
  const activations = room.members.map((agentName) => {
    const key = instanceKey(roomId, agentName);
    const instance = instances.get(key);
    if (instance && (instance.status === "working" || instance.dispatchState !== "idle")) return Promise.resolve();
    return activateAgent(roomId, agentName);
  });
  await Promise.allSettled(activations);
}

// -- Model switching --

export async function switchMemberModel(roomId: string, memberName: string, model: string, credentialId?: string | null, persistRoomOverride = true): Promise<{ applied: boolean; pending: boolean; active: boolean; model: string }> {
  const normalizedModel = normalizeSwitchModelRef(model);
  const available = listAvailableModels().some((m) => m.ref === normalizedModel);
  if (!available) throw new Error(`Model is not available or credential is missing: ${normalizedModel}`);
  if (persistRoomOverride) roomStore.updateRoomMemberOverride(roomId, memberName, { model: normalizedModel, credentialId: credentialId || null });

  const key = instanceKey(roomId, memberName);
  const instance = instances.get(key);
  if (!instance) return { applied: false, pending: false, active: false, model: normalizedModel };

  const pending = { model: normalizedModel, credentialId: credentialId || undefined };
  if (instance.status === "working" || instance.dispatchState !== "idle") {
    instance.pendingModelSwitch = pending;
    logger.info("agent", "modelSwitchQueued", { member: memberName, roomId, model: normalizedModel, status: instance.status, dispatchState: instance.dispatchState });
    return { applied: false, pending: true, active: true, model: normalizedModel };
  }

  await applyModelSwitchToInstance(instance, pending, "switchMemberModel");
  return { applied: true, pending: false, active: true, model: normalizedModel };
}

export async function switchMemberThinkingLevel(roomId: string, memberName: string, thinkingLevel: string): Promise<{ applied: boolean; pending: boolean; active: boolean; thinkingLevel: string }> {
  const key = instanceKey(roomId, memberName);
  const instance = instances.get(key);
  if (!instance) return { applied: false, pending: false, active: false, thinkingLevel };

  const pending = { thinkingLevel };
  if (instance.status === "working" || instance.dispatchState !== "idle") {
    instance.pendingThinkingSwitch = pending;
    logger.info("agent", "thinkingSwitchQueued", { member: memberName, roomId, thinkingLevel, status: instance.status, dispatchState: instance.dispatchState });
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

export function getAgentStatus(roomId: string, agentName: string): AgentStatus {
  const instance = instances.get(instanceKey(roomId, agentName));
  if (!instance) return "inactive";
  return instance.status;
}

export function getRoomAgentStatuses(roomId: string): Record<string, AgentStatus> {
  const room = roomStore.getRoom(roomId);
  if (!room) return {};
  const result: Record<string, AgentStatus> = {};
  for (const m of room.members) result[m] = getAgentStatus(roomId, m);
  return result;
}

// -- Context usage (cache-only API + idle refresh push) --

const contextUsageCache = new Map<string, ContextUsage>();

export function getAgentContextUsage(roomId: string, agentName: string): ContextUsage | null {
  const key = instanceKey(roomId, agentName);
  return contextUsageCache.get(key) ?? null;
}

/** Proactively refresh context usage cache (called on agent_end). Fire-and-forget, non-blocking. */
export function refreshContextUsageOnIdle(roomId: string, agentName: string): void {
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  if (!instance?.handle.getContextUsage) return;

  instance.handle.getContextUsage().then((usage) => {
    if (!usage) return;
    contextUsageCache.set(key, usage);
    broadcastToRoom(roomId, {
      type: "agent:context_usage",
      roomId,
      agent: agentName,
      usage,
    });
  }).catch(() => {});
}

// -- Event history --

export function getAgentEventHistory(roomId: string, agentName: string): AgentHistoryEvent[] {
  return loadEventsFromDisk(roomId, agentName);
}

function emitAgentLocalEvent(roomId: string, agentName: string, event: AgentHistoryEvent): void {
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  if (instance) instance.eventBuffer.push(event);
  try { appendEventToDisk(roomId, agentName, event); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, error: String(err) }); }
  broadcastToAgentSubscribers(roomId, agentName, {
    type: "agent:event",
    roomId,
    agent: agentName,
    event,
  });
}

// -- Agent reply (private, user-only) --

export function emitAgentReply(roomId: string, agentName: string, text: string): void {
  emitAgentLocalEvent(roomId, agentName, { type: "agent_reply", text });
}

// -- Steer --

export async function steerAgent(roomId: string, agentName: string, instruction: string): Promise<void> {
  const instance = await getOrCreate(roomId, agentName);
  if (!instance) throw new Error(`Cannot steer agent "${agentName}": not found`);

  const steerEvent: AgentHistoryEvent = { type: "user_steer", text: instruction };
  instance.eventBuffer.push(steerEvent);
  try { appendEventToDisk(roomId, agentName, steerEvent); } catch (err) { logger.error("agent", "disk write failed", { roomId, agent: agentName, error: String(err) }); }

  // Slash commands (e.g. /compact, /model) are transparently forwarded to the runtime.
  // Only regular text gets wrapped with the private envelope + footer.
  const isSlashCommand = instruction.startsWith('/');
  const userMessage = isSlashCommand
    ? instruction
    : `${wrapPrivateMessage(instruction, USER_DISPLAY_NAME)}\n\n${PRIVATE_REPLY_FOOTER}`;

  setActivationSource(roomId, agentName, isSlashCommand ? "system" : "private_instruction");

  if (instance.dispatchState === "running" || instance.status === "working") {
    instance.handle.steer(userMessage);
    return;
  }

  if (instance.dispatchState === "promptSubmitted" || instance.dispatchState === "aborting") {
    queueInput(instance, userMessage, "steer");
    return;
  }

  updateDispatchState(instance, "promptSubmitted", "steer");
  try {
    await instance.handle.prompt(userMessage);
    if ((instance.dispatchState as DispatchState) !== "running") updateDispatchState(instance, "idle", "steer_prompt_resolved");
  } catch (err: any) {
    logger.error("agent", "steer error", { agent: agentName, error: formatRuntimeErrorMessage(err) });
    updateDispatchState(instance, "idle", "steer_prompt_error");
    instance.queuedInputs = [];
  }
}

// -- Abort --

export function abortAgent(roomId: string, memberName: string): { ok: boolean; action: string } {
  const key = instanceKey(roomId, memberName);
  const instance = instances.get(key);
  if (!instance) return { ok: false, action: "not_found" };
  if (instance.status !== "working" && instance.dispatchState === "idle") return { ok: true, action: "already_idle" };

  // Abort via stdin protocol, keep instance alive. Public idle waits for runtime agent_end.
  instance.handle.abort();
  updateDispatchState(instance, "aborting", "abort");
  instance.queuedInputs = [];
  logger.info("agent", "aborted", { member: memberName, roomId });
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
    if (key.endsWith(`:${memberName}`)) {
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

export function resetAgentSession(roomId: string, agentName: string): { ok: true; message: string } {
  const sessions = sessionStore.getSessions(roomId);
  const member = getMemberByName(agentName);
  const key = instanceKey(roomId, agentName);
  const instance = instances.get(key);
  const runtime = member?.runtime || sessions[agentName]?.runtime || instance?.handle.runtimeName || "pi-cli";

  destroyInstance(roomId, agentName);
  clearActivationSource(roomId, agentName);
  sessionStore.clearSession(roomId, agentName, runtime);
  roomStore.setCursor(roomId, agentName, null);

  const message = "Session reset. Next activation will start fresh.";
  emitAgentLocalEvent(roomId, agentName, { type: "system", text: message });
  broadcastToRoom(roomId, { type: "agent:status", roomId, agent: agentName, status: "inactive" });
  return { ok: true, message };
}

export function destroyInstance(roomId: string, memberName: string): void {
  const key = instanceKey(roomId, memberName);
  const instance = instances.get(key);
  if (instance) {
    instance.handle.abort();
    instance.handle.destroy();
    instance.unsubscribe();
    instances.delete(key);
    contextUsageCache.delete(key);
    clearActivationSource(roomId, memberName);
    logger.info("agent", "instance destroyed", { member: memberName, roomId });
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
  clearAllActivationSources();
  if (registry) {
    for (const rt of registry.getAll()) {
      await rt.shutdownAll().catch((err) => {
        logger.error("agent", "runtime shutdown error", { runtime: rt.name, error: String(err) });
      });
    }
  }
}
