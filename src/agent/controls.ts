// Runtime controls: model/credential changes, stop, compact, reset and teardown.
// Conversation lookup and publication remain application-owned dependencies.
import { getDatabase } from "../data/database.js";
import { logger } from "../kernel/logger.js";
import { getModelCredentialProfile, normalizeModelRef, assertModelAvailable } from "../config/models.js";
import { exportPiConfigForMember } from "../config/pi-adapt/credentials.js";
import { buildMemberAgentSession, maybeFlushPendingReload, getRegistry } from "./assembly.js";
import { queueDepth, hasInputPumps, drainQueuedInputsAsPrompt, cancelPendingRuntimeInputs, invalidateInputScope } from "./scheduler.js";
import { settleMemberShellWaits } from "./terminal.js";
import { instances, instanceKey, cancelledCreations, pendingCreations, memberSwitchGates, pendingCreationsFor, sessionPublishOwners, contextUsageCache, contextCompactionWarningCache, formatRuntimeErrorMessage, memberRuntimeAllowed, runtimeIsStopping, closeRuntimeAdmission, updateDispatchState, transition, memberIdentityMeta, trackMemberOperation, settleMemberOperations, clearRuntimeStateEntry, type AgentInstance, type PendingThinkingSwitch, type PendingCredentialRefresh, type AgentStatusBroadcast } from "./instance.js";
import type { AgentMemberConfig } from "./types.js";
import type { AgentHistoryEvent } from "./events.js";

export interface ControlServices {
  memberConfig(memberId: string): AgentMemberConfig | null;
  resolveMember(scopeId: string, memberRef: string): { id: string; name: string } | null | undefined;
  memberScopes(memberId: string): string[];
  clearSession(memberId: string): void;
  commitModelBinding(memberId: string, binding: { model: string; credentialId: string }): void;
  emitEvent(sourceRef: string | null, memberId: string, event: AgentHistoryEvent, identity?: { memberId: string; agentName: string }): void;
  postSystemNotice(scopeId: string, message: string): void;
  publishStatus(scopeId: string, event: AgentStatusBroadcast): void;
  publishReset(scopeId: string, memberName: string, event: AgentStatusBroadcast): void;
}
let services: ControlServices | undefined;
export function configureControls(next: ControlServices): void {
  if (shutdownRunning) throw new Error("Runtime shutdown is still in progress");
  if (getRegistry() && (instances.size || pendingCreations.size || hasInputPumps())) throw new Error("Runtime initialization requires completed teardown");
  shutdownSettlement = null;
  services = next;
}
function controlServices(): ControlServices {
  if (!services) throw new Error("Runtime controls are not connected");
  return services;
}

function activeSource(instance: AgentInstance): string | null {
  return instance.activeSourceRef;
}

function publishCurrentStatus(instance: AgentInstance): void {
  const sourceRef = activeSource(instance);
  if (!sourceRef) return;
  controlServices().publishStatus(sourceRef, {
    type: "agent:status", roomId: sourceRef, agent: instance.agentName,
    ...memberIdentityMeta(instance.agentName, instance.memberId), status: instance.status,
  });
}

function noticeCurrentSource(instance: AgentInstance, message: string): void {
  const sourceRef = activeSource(instance);
  if (sourceRef) controlServices().postSystemNotice(sourceRef, message);
}

function cancelMemberPending(memberId: string, diagnosis: string): void {
  cancelPendingRuntimeInputs(memberId, diagnosis);
}

let shutdownSettlement: Promise<void> | null = null;

let shutdownRunning = false;

export function applyPendingAfterPromptSettlement(instance:AgentInstance,trigger:string):void{
  applyPendingCredentialRefresh(instance,trigger);applyPendingThinkingSwitch(instance,trigger);
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
    memberId: instance.memberId,
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
  logger.info("agent", "modelSwitchApplied", { member: instance.agentName, sourceRef: activeSource(instance), model, trigger });
  publishCurrentStatus(instance);
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
  logger.info("agent", "thinkingSwitchApplied", { member: instance.agentName, sourceRef: activeSource(instance), thinkingLevel: pending.thinkingLevel, trigger });
  publishCurrentStatus(instance);
}

function applyPendingThinkingSwitch(instance: AgentInstance, trigger: string): void {
  const pending = instance.pendingThinkingSwitch;
  if (!pending) return;
  instance.pendingThinkingSwitch = undefined;
  applyThinkingSwitchToInstance(instance, pending, trigger).catch((err) => {
    logger.error("agent", "thinkingSwitchFailed", { member: instance.agentName, sourceRef: activeSource(instance), error: String(err) });
    noticeCurrentSource(instance, `Failed to switch thinking level for "${instance.agentName}": ${err.message || String(err)}`);
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
  publishCurrentStatus(instance);
  logger.warn("agent", "credentialRefreshUnavailable", { member: instance.agentName, sourceRef: activeSource(instance), reason });
  noticeCurrentSource(instance, `Member "${instance.agentName}" model credential is no longer available. Update Settings → Model Credentials or choose another model before the next turn.`);
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
      memberId: instance.memberId,
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
    logger.info("agent", "credentialRefreshApplied", { member: instance.agentName, roomId: activeSource(instance) ?? instance.memberId, profileId: pending.profileId, providerSlug: pending.providerSlug, trigger });
  } catch (err) {
    // Profile gone / export empty already dropped above. Network/timeouts must NOT
    // destroy the live instance or cry "credential no longer available".
    if (pending.changeType !== "profileDeleted" && isTransientCredentialRefreshError(err)) {
      logger.warn("agent", "credentialRefreshTransient", {
        member: instance.agentName,
        roomId: activeSource(instance) ?? instance.memberId,
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
    logger.error("agent", "credentialRefreshFailed", { member: instance.agentName, roomId: activeSource(instance) ?? instance.memberId, error: String(err) });
    noticeCurrentSource(instance, `Failed to refresh model credential for "${instance.agentName}": ${err.message || String(err)}`);
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
        roomId: activeSource(instance) ?? instance.memberId,
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
        logger.info("agent", "credentialRefreshQueued", { member: instance.agentName, roomId: activeSource(instance) ?? instance.memberId, profileId, providerSlug, status: instance.status, dispatchState: instance.dispatchState });
        continue;
      }
      // Fire-and-forget; errors handled inside applyCredentialRefreshToInstance.
      void applyCredentialRefreshToInstance(instance, pending, "credentialProfileInvalidated").catch((err) => {
        logger.error("agent", "credentialRefreshFailed", { member: instance.agentName, roomId: activeSource(instance) ?? instance.memberId, error: String(err) });
      });
    }
    return targets.map((instance) => ({
      roomId: activeSource(instance) ?? instance.memberId,
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
      logger.info("agent", "credentialRefreshQueued", { member: instance.agentName, roomId: activeSource(instance) ?? instance.memberId, profileId, providerSlug, status: instance.status, dispatchState: instance.dispatchState });
      results.push({ roomId: activeSource(instance) ?? instance.memberId, memberName: instance.agentName, applied: false, pending: true });
      return;
    }
    try {
      await applyCredentialRefreshToInstance(instance, pending, "credentialProfileInvalidated");
      results.push({ roomId: activeSource(instance) ?? instance.memberId, memberName: instance.agentName, applied: true, pending: false });
    } catch (err: any) {
      logger.error("agent", "credentialRefreshFailed", { member: instance.agentName, roomId: activeSource(instance) ?? instance.memberId, error: String(err) });
      noticeCurrentSource(instance, `Failed to refresh model credential for "${instance.agentName}": ${err.message || String(err)}`);
      results.push({ roomId: activeSource(instance) ?? instance.memberId, memberName: instance.agentName, applied: false, pending: false });
    }
  }));
  return results;
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
      destroyInstance(inst.memberId);
      failedScopes.push((activeSource(inst) ?? inst.memberId));
      continue;
    }
    try {
      await applyModelSwitchToInstance(inst, { model: original.model, credentialId: original.credentialId }, trigger);
    } catch (err) {
      logger.error("agent", "modelSwitchRollbackFailed", {
        member: inst.agentName,
        scopeId: (activeSource(inst) ?? inst.memberId),
        error: String(err),
        trigger,
      });
      destroyInstance(inst.memberId);
      failedScopes.push((activeSource(inst) ?? inst.memberId));
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
      const failedAt = attempted[attempted.length - 1]?.memberId ?? "unknown member";
      const reason = String((err as Error)?.message || err);
      const failedScopes = await rollbackSwitchedInstances(attempted, originals, "switchMemberModel-rollback");
      throw new Error(failedScopes.length > 0
        ? `Model switch failed at ${failedAt} (${reason}); rollback could not restore ${failedScopes.join(", ")} — those instances were stopped, their conversation history is preserved.`
        : `Model switch failed at ${failedAt} (${reason}); every attempted instance was restored to its previous model.`);
    }

    // Commit the global config exactly once, after every instance accepted.
    try {
      controlServices().commitModelBinding(memberId, { model: normalizedModel, credentialId: binding.credentialId });
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
      instances: attempted.map((inst) => ({ scopeId: (activeSource(inst) ?? inst.memberId), applied: true })),
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
      pending.push((activeSource(inst) ?? inst.memberId));
      continue;
    }
    await applyThinkingSwitchToInstance(inst, p, "switchMemberThinkingLevel");
    applied.push((activeSource(inst) ?? inst.memberId));
  }
  return { applied, pending };
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
export async function compactMember(scopeId: string | null, memberId: string): Promise<{ ok: boolean; action: string }> {
  let instance: AgentInstance | undefined = instances.get(instanceKey(memberId)) ?? undefined;
  if (!instance) {
    // The room /compact command can arrive before any activation — build the
    // session (no prompt) so there is something to compact. Unresolvable or
    // unconfigured members still fail honestly.
    instance = (await buildMemberAgentSession(memberId)) ?? undefined;
    if (!instance) throw new Error(`No active member session to compact (${memberId})`);
  }
  if (instance.compacting) throw new Error("Compaction is already in progress for this session");
  if (!instance.handle.compact) throw new Error("Runtime does not support manual compaction");

  // Busy before the next await (§3): once an instance is in hand (live or
  // freshly built — the build itself is gated), the lifecycle is marked
  // synchronously so message paths see a compacting/busy instance and queue;
  // Stop finds a busy lifecycle in every window instead of an already-idle
  // no-op. Reuses the existing compacting/dispatch fields — no second queue,
  // no timers.
  instance.activeSourceRef = scopeId;
  instance.compacting = true;
  updateDispatchState(instance, "running", "compact-requested");
  transition(instance, scopeId, instance.agentName, "working", "compact-requested");
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
        logger.info("agent", "manualCompactStoppedBeforeStart", { member: instance.agentName, sourceRef: activeSource(instance) });
        return { ok: false, action: "stopped" };
      }
    }
    started = true;
    // From here the event bridge owns the lifecycle: compaction_end resets
    // compacting/status and resumes queued inputs as a fresh prompt.
    const outcome = await instance.handle.compact();
    if (outcome?.aborted) {
      logger.info("agent", "manualCompactAborted", { member: instance.agentName, sourceRef: activeSource(instance) });
      return { ok: false, action: "stopped" };
    }
    completed = true;
    return { ok: true, action: "compacted" };
  } catch (err) {
    const message = formatRuntimeErrorMessage(err);
    if (started) {
      // The bridge already emitted compaction_end(aborted/error) and settled.
      logger.error("agent", "manualCompactFailed", { member: instance.agentName, sourceRef: activeSource(instance), error: message });
      noticeCurrentSource(instance, `Manual compaction failed for "${instance.agentName}": ${message}`);
    }
    throw err;
  } finally {
    if (!started) {
      // Never reached the SDK operation (stopped in the window or pre-start
      // failure): restore the lifecycle here and resume queued inputs.
      instance.compacting = false;
      updateDispatchState(instance, "idle", "compact-not-started");
      transition(instance, scopeId, instance.agentName, "idle", "compact-not-started");
      drainQueuedInputsAsPrompt(instance, "compact-not-started");
    }
    // A manual compact emits agent_end after compaction_end and has no input
    // pump to flush deferred reloads. Wait for the actual SDK operation first.
    if (completed && instances.get(instanceKey(memberId)) === instance
      && memberRuntimeAllowed(memberId) && !queueDepth(instance)) maybeFlushPendingReload(instance);
    if (instance.activeSourceRef === scopeId && !instance.promptInFlight && !instance.turnActive) instance.activeSourceRef = null;
  }
}

// -- Abort --

export function abortAgent(roomId: string, memberRef: string): { ok: boolean; action: string } {
  const member = controlServices().resolveMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const memberName = member?.name || memberRef;
  const key = instanceKey(memberId);
  cancelPendingRuntimeInputs(memberId,"explicit stop",roomId);
  const instance = instances.get(key);
  if (!instance) return { ok: false, action: "not_found" };
  if (instance.status !== "working" && instance.dispatchState === "idle") return { ok: true, action: "already_idle" };

  // Stop is the sole abort entry.
  try { settleMemberShellWaits(memberId); } catch { /* ignore */ }

  // Abort via stdin protocol, keep instance alive. Public idle waits for runtime agent_end.
  instance.handle.abort();
  updateDispatchState(instance, "aborting", "abort");
  if(instance.activeSourceRef)cancelPendingRuntimeInputs(instance.memberId,"explicit stop",instance.activeSourceRef);
  logger.info("agent", "aborted", { member: memberName, memberId, roomId });
  return { ok: true, action: "aborted" };
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
  cancelPendingRuntimeInputs(memberId, "explicit stop");
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
  return compactMember(null, memberId);
}

/** Reset the member's session from any interface. */
export function resetMemberSession(memberId: string): { ok: true; message: string } {
  const instance = instances.get(instanceKey(memberId));
  const agentName = instance?.agentName || controlServices().memberConfig(memberId)?.name || memberId;
  const scopes = controlServices().memberScopes(memberId);
  const message = "Session reset. Next activation will start fresh.";
  getDatabase().transaction(() => {
    cancelPendingRuntimeInputs(memberId, "session reset");
    controlServices().clearSession(memberId);
  });
  teardownMemberInstance(memberId);
  for (const scope of scopes) {
    clearRuntimeStateEntry(memberId);
    const statusEvent = { type: "agent:status" as const, roomId: scope, agent: agentName, ...memberIdentityMeta(agentName, memberId), status: "inactive" as const };
    controlServices().publishReset(scope, agentName, statusEvent);
  }
  controlServices().emitEvent(null, memberId, { type: "system", text: message }, { memberId, agentName });
  logger.info("agent", "memberSessionReset", { memberId, member: agentName });
  return { ok: true, message };
}

/** Restart the member's runtime: drop it; the next activation rebuilds. */
export function restartMember(memberId: string): { ok: true; message: string } {
  cancelPendingRuntimeInputs(memberId, "member restart");
  teardownMemberInstance(memberId);
  logger.info("agent", "memberRestarted", { memberId });
  return { ok: true, message: "Member restarted. Next activation will start a fresh runtime." };
}

export function destroyInstance(memberId: string,options:{preservePending?:boolean}={}): void {
  const key = instanceKey(memberId);
  if(!options.preservePending)cancelMemberPending(memberId,"instance removed");
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
    logger.info("agent", "instance destroyed", { memberId });
  }
}

export function interruptAcceptedInput(_scopeId:string,instance:AgentInstance,trigger:string):void{
  try{settleMemberShellWaits(instance.memberId);}catch{}
  // ① B1: one runtime serves every chat, so an interrupt can arrive while the
  // member is between turns. Only a real in-flight turn becomes "aborting" —
  // marking a quiet instance aborting would wedge its input pump (nothing
  // would fire the agent_end that settles it).
  const inFlightTurn=instance.promptInFlight||instance.turnActive;
  instance.handle.abort({preserveCompaction:true});
  if(inFlightTurn)updateDispatchState(instance,"aborting",trigger);
}

function requestInstanceStop(instance: AgentInstance,preservePending=false): void {
  const failures: unknown[] = [];
  if(!runtimeIsStopping()&&!preservePending)cancelMemberPending(instance.memberId,"member quiescence");
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
  cancelPendingRuntimeInputs(memberId,"member archived");
  settleMemberShellWaits(memberId);
  const {dropSftpConnectionsForMember}=await import("./tools.js");
  try {await dropSftpConnectionsForMember(memberId);}catch(error){errors.push(error);}
  for (const instance of instances.values()) if (instance.memberId===memberId) {
    try {requestInstanceStop(instance);} catch(error){errors.push(error);}
  }
  await Promise.allSettled([...pendingCreationsFor(memberId), ...(memberSwitchGates.has(memberId) ? [memberSwitchGates.get(memberId)!] : [])]);
  const {closeAllShellsForMember}=await import("./terminal.js");
  const resources = await Promise.allSettled([closeAllShellsForMember(memberId)]);
  for (const result of resources) if (result.status === "rejected") errors.push(result.reason);
  for (const [key,instance] of [...instances]) if(instance.memberId===memberId) {
    try {
      requestInstanceStop(instance);
      if (!instance.handle.destroyAndWait) throw new Error("Runtime cannot confirm member teardown");
      await instance.handle.destroyAndWait();instance.unsubscribe();instances.delete(key);sessionPublishOwners.delete(key);
      contextUsageCache.delete(key);contextCompactionWarningCache.delete(key);
    }catch(error){errors.push(error);}
  }
  for (const runtime of getRegistry()?.getAll() ?? []) {
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
    const {dropSftpConnectionsForMember}=await import("./tools.js");
    try {await dropSftpConnectionsForMember();}catch(error){failures.push(error);}
    for (const instance of instances.values()) {
      try { requestInstanceStop(instance); } catch (error) { failures.push(error); }
    }
    for (const pending of await Promise.allSettled([...pendingCreations.values(), ...memberSwitchGates.values()])) {
      if (pending.status === "rejected") failures.push(pending.reason);
    }
    const {closeAllShellsForMember}=await import("./terminal.js");
    const resources = await Promise.allSettled([closeAllShellsForMember()]);
    for (const result of resources) if (result.status === "rejected") failures.push(result.reason);
    for (const rt of getRegistry()?.getAll() ?? []) {
      try { await rt.shutdownAll(); } catch (error) { failures.push(error); }
    }
    await settleMemberOperations();
    for (const instance of instances.values()) {try {instance.unsubscribe();}catch(error){failures.push(error);}}
    instances.clear(); pendingCreations.clear(); sessionPublishOwners.clear();
    contextUsageCache.clear(); contextCompactionWarningCache.clear();
    if (failures.length) throw new AggregateError(failures, "Runtime shutdown incomplete");
  })().finally(() => { shutdownRunning = false; });
  return shutdownSettlement;
}
