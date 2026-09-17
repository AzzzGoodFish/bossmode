// One member-session assembly path. Storage, conversation policy and delivery
// are supplied by the application; this module owns creation gates and teardown.
import { mainSessionDirectory } from "../files/layout.js";
import { logger } from "../kernel/logger.js";
import { MEMBER_CONTRACT_VERSION } from "../kernel/contract-version.js";
import { normalizeModelRef } from "../config/models.js";
import { compileMemberPrompt, type MemberPromptSource } from "./prompt.js";
import type { RuntimeRegistry } from "./runtime/registry.js";
import type { AgentMemberConfig, AgentMemberSnapshot, AgentCallbacks } from "./types.js";
import { instances, instanceKey, pendingCreations, cancelledCreations, memberSwitchGates, sessionPublishOwners, memberRuntimeAllowed, setContractFingerprint, clearStaleMounts, currentProfileRevision, isMemberConfigured, formatRuntimeErrorMessage, chatTargetOf, updateDispatchState, trackMemberOperation, type AgentInstance } from "./instance.js";
import { queueDepth, drainQueuedInputsAsPrompt, wireInstanceEvents } from "./scheduler.js";

export interface AssemblyServices {
  isValidScope(scopeId: string): boolean;
  hasScopeAccess(scopeId: string, memberId: string): boolean;
  currentName(memberId: string, initialName: string): string;
  conversation(member: AgentMemberConfig, activeChat: { scopeId: string }): { roomMembers: string[]; callbacks: AgentCallbacks };
  saveSession(memberId: string, runtime: string, session: { sessionId?: string; sessionFile?: string }): void;
  postSystemNotice(scopeId: string, text: string): void;
}
let registry: RuntimeRegistry | null = null;
let promptSource: ((memberId: string) => MemberPromptSource) | null = null;
let memberSnapshotSource: ((memberId: string) => AgentMemberSnapshot | null) | null = null;
let services: AssemblyServices | undefined;
export function configureAssembly(reg: RuntimeRegistry, loadPrompt: (id: string) => MemberPromptSource, loadSnapshot: (id: string) => AgentMemberSnapshot | null, deps: AssemblyServices): void {
  if (instances.size || pendingCreations.size) throw new Error("Session assembly initialization requires completed teardown");
  registry = reg; promptSource = loadPrompt; memberSnapshotSource = loadSnapshot; services = deps;
}
function assemblyServices(): AssemblyServices {
  if (!services) throw new Error("Session assembly services are not connected");
  return services;
}
function canExecuteScope(scopeId: string, memberId: string): boolean {
  return memberRuntimeAllowed(memberId) && assemblyServices().hasScopeAccess(scopeId, memberId);
}
export function compileForMember(memberId: string) {
  if (!promptSource) throw new Error("Member prompt source is not connected");
  return compileMemberPrompt(promptSource(memberId));
}
export function getRegistry(): RuntimeRegistry | null {
  return registry;
}

export async function buildMemberAgentSession(memberId: string, scopeId: string): Promise<AgentInstance | null> {
  if (!memberRuntimeAllowed(memberId)) return null;
  const creationProfileRevision = currentProfileRevision();
  if (!assemblyServices().isValidScope(scopeId)) {
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
    if (!canExecuteScope(scopeId, memberId)) return null;
    const existing = instances.get(key);
    if (existing) return existing;
    const pending = pendingCreations.get(key);
    if (pending) {
      const retryAfterCancellation = cancelledCreations.has(key);
      const built = await pending;
      if (retryAfterCancellation) continue;
      return canExecuteScope(scopeId, memberId) ? built : null;
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
    && assemblyServices().hasScopeAccess(scopeId, memberId);
  const creation = (async (): Promise<AgentInstance | null> => {
    if (!registry) {
      logger.error("agent", "runtime registry not initialized");
      return null;
    }

    const snapshot = memberSnapshotSource?.(memberId) ?? null;
    if (!snapshot) {
      logger.error("agent", "member not found", { memberId });
      return null;
    }
    const member = snapshot.config;
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
    const skills = member.skills ?? [];
    const skillPaths = snapshot.skillPaths;
    const cwd = snapshot.workspaceRoot;
    const sessionDir = mainSessionDirectory(memberId);
    const resumeSession = snapshot.resumeSession;
    const onSessionChanged = (session: { sessionId?: string; sessionFile?: string }) => {
      if (canPublishSession()) assemblyServices().saveSession(memberId, member.runtime, session);
    };

    // Conversation routing is turn-local; it never selects member assets or a session directory.
    const activeChat = { scopeId };
    const keyRoomId = chatTargetOf(scopeId);
    const { roomMembers, callbacks } = assemblyServices().conversation(member, activeChat);

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
        agentName: assemblyServices().currentName(memberId, member.name),
        profilePromptDirty: memberId.startsWith("mem_") && creationProfileRevision !== currentProfileRevision(),
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
        appliedModel: member.model ? normalizeModelRef(member.model.trim()) : "",
        appliedCredentialId: member.credentialId,
        pendingReload: null,
      };

      wireInstanceEvents(instance);

      instances.set(key, instance);
      return instance;
    } catch (err: any) {
      logger.error("agent", "failed to create member agent", { member: member.name, agent: member.agent, runtime: member.runtime, error: formatRuntimeErrorMessage(err) });
      assemblyServices().postSystemNotice(keyRoomId, `Failed to create member "${member.name}": ${formatRuntimeErrorMessage(err)}`);
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
  const built = await buildMemberAgentSession(memberId, scopeId);
  if(built)drainQueuedInputsAsPrompt(built,"session-reloaded");
  logger.info("agent", "sessionReloaded", { memberId, scopeId, reason, rebuilt: !!built });
  return built;
}

/** Flush a reload requested mid-run once the member is fully settled and
 * nothing is queued (queued prompts are delivered first; the rebuild waits for
 * the next settlement). */
export function maybeFlushPendingReload(instance: AgentInstance): void {
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
