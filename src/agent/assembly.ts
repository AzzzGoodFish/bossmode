// One member-session assembly path. Member assets are captured by app as one
// immutable snapshot; chat source is assigned later by the scheduler per batch.
import { mainSessionDirectory } from "../files/layout.js";
import { logger } from "../kernel/logger.js";
import { MEMBER_CONTRACT_VERSION } from "../kernel/contract-version.js";
import { normalizeModelRef } from "../config/models.js";
import type { AgentMemberSnapshot, RuntimeRegistry } from "./types.js";
import {
  instances,
  instanceKey,
  pendingCreations,
  cancelledCreations,
  memberSwitchGates,
  sessionPublishOwners,
  memberRuntimeAllowed,
  setContractFingerprint,
  clearStaleMounts,
  currentProfileRevision,
  isMemberConfigured,
  formatRuntimeErrorMessage,
  updateDispatchState,
  trackMemberOperation,
  type AgentInstance,
} from "./instance.js";
import { queueDepth, drainQueuedInputsAsPrompt, wireInstanceEvents } from "./scheduler.js";

export interface AssemblyServices {
  saveSession(memberId: string, runtime: string, session: { sessionId?: string; sessionFile?: string }): void;
}

let registry: RuntimeRegistry | null = null;
let memberSnapshotSource: ((memberId: string) => AgentMemberSnapshot | null) | null = null;
let services: AssemblyServices | undefined;

export function configureAssembly(
  reg: RuntimeRegistry,
  loadSnapshot: (memberId: string) => AgentMemberSnapshot | null,
  deps: AssemblyServices,
): void {
  if (instances.size || pendingCreations.size) throw new Error("Session assembly initialization requires completed teardown");
  registry = reg;
  memberSnapshotSource = loadSnapshot;
  services = deps;
}

function assemblyServices(): AssemblyServices {
  if (!services) throw new Error("Session assembly services are not connected");
  return services;
}

function memberSnapshot(memberId: string): AgentMemberSnapshot | null {
  if (!memberSnapshotSource) throw new Error("Member snapshot source is not connected");
  return memberSnapshotSource(memberId);
}

export function compileForMember(memberId: string): AgentMemberSnapshot["prompt"] {
  const snapshot = memberSnapshot(memberId);
  if (!snapshot) throw new Error(`Member not found: ${memberId}`);
  return snapshot.prompt;
}

export function getRegistry(): RuntimeRegistry | null {
  return registry;
}

export async function buildMemberAgentSession(memberId: string): Promise<AgentInstance | null> {
  if (!memberRuntimeAllowed(memberId)) return null;
  const creationProfileRevision = currentProfileRevision();
  const key = instanceKey(memberId);

  for (;;) {
    if (!memberRuntimeAllowed(memberId)) return null;
    const existing = instances.get(key);
    if (existing) return existing;
    const pending = pendingCreations.get(key);
    if (pending) {
      const retryAfterCancellation = cancelledCreations.has(key);
      const built = await pending;
      if (retryAfterCancellation) continue;
      return memberRuntimeAllowed(memberId) ? built : null;
    }
    const gate = memberSwitchGates.get(memberId);
    if (gate) {
      await gate;
      continue;
    }
    break;
  }

  const publicationOwner = {};
  sessionPublishOwners.set(key, publicationOwner);
  const canPublishSession = () => sessionPublishOwners.get(key) === publicationOwner;
  const canPublishInstance = () => canPublishSession() && memberRuntimeAllowed(memberId);
  const creation = (async (): Promise<AgentInstance | null> => {
    if (!registry) {
      logger.error("agent", "runtime registry not initialized");
      return null;
    }
    const snapshot = memberSnapshot(memberId);
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

    const compiled = snapshot.prompt;
    setContractFingerprint(memberId, compiled.contractFingerprint, MEMBER_CONTRACT_VERSION);
    clearStaleMounts(memberId);
    const sessionDir = mainSessionDirectory(memberId);
    const onSessionChanged = (session: { sessionId?: string; sessionFile?: string }) => {
      if (canPublishSession()) assemblyServices().saveSession(memberId, member.runtime, session);
    };
    const resolveSourceRef = () => instances.get(key)?.activeSourceRef ?? null;

    try {
      const handle = await runtime.createAgent({
        cwd: snapshot.workspaceRoot,
        member,
        resolveSourceRef,
        resources: snapshot.resources,
        agentPrompt: compiled.agentPrompt,
        appendSystemPrompt: compiled.appendSystemPrompt,
        skillPaths: snapshot.resources.skillPaths,
        skillNames: snapshot.resources.skillNames,
        resumeSession: snapshot.resumeSession,
        sessionDir,
        onSessionChanged,
      });

      if (!canPublishInstance()) {
        if (!handle.destroyAndWait) throw new Error("Runtime cannot confirm rejected builder cleanup");
        await handle.destroyAndWait();
        return null;
      }

      const instance: AgentInstance = {
        handle,
        activeSourceRef: null,
        memberId,
        agentName: member.name,
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
                appendSystemPrompt: [...compiled.appendSystemPrompt],
          },
          skills: [...snapshot.resources.skillNames],
          skillPaths: [...snapshot.resources.skillPaths],
          cwd: snapshot.workspaceRoot,
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
      logger.info("agent", "memberAgentCreated", { member: member.name, runtime: member.runtime, memberId });
      return instance;
    } catch (error) {
      logger.error("agent", "failed to create member agent", {
        member: member.name,
        agent: member.agent,
        runtime: member.runtime,
        error: formatRuntimeErrorMessage(error),
      });
      return null;
    }
  })();

  pendingCreations.set(key, creation);
  try {
    return await creation;
  } finally {
    if (pendingCreations.get(key) === creation) {
      pendingCreations.delete(key);
      cancelledCreations.delete(key);
    }
    if (!instances.has(key) && sessionPublishOwners.get(key) === publicationOwner) sessionPublishOwners.delete(key);
  }
}

export async function reloadMemberSession(memberId: string, reason: string): Promise<{ queued: boolean; rebuilt: boolean }> {
  const instance = instances.get(instanceKey(memberId));
  if (!instance) return { queued: false, rebuilt: !!(await buildMemberAgentSession(memberId)) };
  if (instance.status === "working" || instance.compacting || instance.dispatchState !== "idle" || instance.promptInFlight || queueDepth(instance) > 0) {
    instance.pendingReload = reason;
    logger.info("agent", "reloadQueued", { memberId, reason });
    return { queued: true, rebuilt: false };
  }
  await rebuildLiveInstance(instance, reason);
  return { queued: false, rebuilt: true };
}

function rebuildLiveInstance(instance: AgentInstance, reason: string): Promise<AgentInstance | null> {
  if (!memberRuntimeAllowed(instance.memberId)) return Promise.resolve(null);
  return trackMemberOperation(instance.memberId, () => rebuildLiveInstanceInternal(instance, reason));
}

async function rebuildLiveInstanceInternal(instance: AgentInstance, reason: string): Promise<AgentInstance | null> {
  const memberId = instance.memberId;
  updateDispatchState(instance, "aborting", "session-reload");
  if (!instance.handle.destroyAndWait) throw new Error("Runtime cannot confirm reload teardown");
  await instance.handle.destroyAndWait();
  if (instances.get(instanceKey(memberId)) !== instance || !memberRuntimeAllowed(memberId)) return null;
  instance.unsubscribe();
  instances.delete(instanceKey(memberId));
  sessionPublishOwners.delete(instanceKey(memberId));
  const built = await buildMemberAgentSession(memberId);
  if (built) drainQueuedInputsAsPrompt(built, "session-reloaded");
  logger.info("agent", "sessionReloaded", { memberId, reason, rebuilt: !!built });
  return built;
}

export function maybeFlushPendingReload(instance: AgentInstance): void {
  if (!instance.pendingReload) return;
  if (instance.status !== "idle" || instance.compacting || instance.turnActive || instance.dispatchState !== "idle" || instance.promptInFlight) return;
  if (queueDepth(instance) > 0) return;
  const reason = instance.pendingReload;
  instance.pendingReload = null;
  const key = instanceKey(instance.memberId);
  setTimeout(() => {
    if (instances.get(key) !== instance) return;
    void reloadMemberSession(instance.memberId, reason).catch((error) =>
      logger.error("agent", "pendingReload failed", { memberId: instance.memberId, error: String(error) }),
    );
  }, 0);
}
