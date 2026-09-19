// Runtime controls: model/credential changes, stop, compact, reset and teardown.
// Conversation lookup and publication remain application-owned dependencies.
import { getDatabase } from "../data/database.js";
import { logger } from "../kernel/logger.js";
import { getModelCredentialProfile, normalizeModelRef, assertModelAvailable } from "../config/models.js";
import { exportPiConfigForMember } from "../config/pi-adapt/credentials.js";
import { buildMemberAgentSession, getRegistry } from "./assembly.js";
import { queueDepth, hasInputPumps, drainQueuedInputsAsPrompt, cancelPendingRuntimeInputs, invalidateInputScope } from "./scheduler.js";
import { settleMemberShellWaits } from "./terminal.js";
import { instances, instanceKey, cancelledCreations, pendingCreations, memberSwitchGates, pendingCreationsFor, sessionPublishOwners, contextUsageCache, formatRuntimeErrorMessage, memberRuntimeAllowed, runtimeIsStopping, closeRuntimeAdmission, updateDispatchState, transition, memberIdentityMeta, trackMemberOperation, settleMemberOperations, clearRuntimeStateEntry, type AgentInstance, type PendingThinkingSwitch, type PendingCredentialRefresh, type AgentStatusBroadcast } from "./instance.js";
import type { AgentMemberConfig } from "./types.js";
import type { AgentHistoryEvent } from "./events.js";
export interface ControlServices {
  memberConfig(memberId: string): AgentMemberConfig | null;
  memberScopes(memberId: string): string[];
  clearSession(memberId: string): void;
  commitModelBinding(memberId: string, binding: { model: string; credentialId: string }): void;
  emitEvent(sourceRef: string | null, memberId: string, event: AgentHistoryEvent): void;
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
  const credential=instance.pendingCredentialRefresh;instance.pendingCredentialRefresh=undefined;
  if(credential)void refreshCredential(instance,credential,trigger);
  const thinking=instance.pendingThinkingSwitch;instance.pendingThinkingSwitch=undefined;
  if(thinking)void applyThinking(instance,thinking,trigger).catch(error=>noticeCurrentSource(instance,`Failed to switch thinking level for "${instance.agentName}": ${String(error)}`));
}
function normalizedBinding(model:string,credentialId?:string){
  const ref=normalizeModelRef(model.trim());if(!ref)throw new Error("model is required");
  assertModelAvailable(ref,"model switch");const profile=credentialId?getModelCredentialProfile(credentialId):null;
  if(!profile?.enabled)throw new Error(`No model credentials configured for ${ref}`);
  if(ref.split("/")[0]!==profile.providerSlug)throw new Error(`Credential "${profile.name}" (${profile.providerSlug}) does not serve model ${ref}`);
  return {model:ref,profile};
}

async function applyModel(instance:AgentInstance,binding:{model:string;credentialId?:string},trigger:string):Promise<void>{
  if(!memberRuntimeAllowed(instance.memberId))return;const {model,profile}=normalizedBinding(binding.model,binding.credentialId);
  if(!instance.handle.setModel)throw new Error("Runtime does not support dynamic model switching");
  if(!exportPiConfigForMember({memberId:instance.memberId,modelRef:model,credentialId:profile.id}))throw new Error(`No model credentials configured for ${model}`);
  await trackMemberOperation(instance.memberId,async()=>{await instance.handle.setModel!(model,profile.id);});
  instance.appliedModel=model;instance.appliedCredentialId=profile.id;
  if(instance.handle.runtimeParams)Object.assign(instance.handle.runtimeParams,{model,credentialId:profile.id,credentialName:profile.name});
  logger.info("agent","modelSwitchApplied",{member:instance.agentName,model,trigger});publishCurrentStatus(instance);
}

async function applyThinking(instance:AgentInstance,pending:PendingThinkingSwitch,trigger:string):Promise<void>{
  if(!memberRuntimeAllowed(instance.memberId))return;if(!instance.handle.setThinkingLevel)throw new Error("Runtime does not support dynamic thinking level switching");
  await trackMemberOperation(instance.memberId,async()=>{await instance.handle.setThinkingLevel!(pending.thinkingLevel);});
  if(instance.handle.runtimeParams)instance.handle.runtimeParams.thinkingLevel=pending.thinkingLevel;
  logger.info("agent","thinkingSwitchApplied",{member:instance.agentName,thinkingLevel:pending.thinkingLevel,trigger});publishCurrentStatus(instance);
}

function dropCredential(instance:AgentInstance,reason:string):void{
  const key=instanceKey(instance.memberId);if(instances.get(key)===instance)instances.delete(key);contextUsageCache.delete(key);
  try{instance.unsubscribe();}catch{}try{instance.handle.destroy();}catch{}instance.status="inactive";updateDispatchState(instance,"idle","credential_unavailable");publishCurrentStatus(instance);
  logger.warn("agent","credentialRefreshUnavailable",{member:instance.agentName,reason});noticeCurrentSource(instance,`Member "${instance.agentName}" model credential is no longer available.`);
}

async function refreshCredential(instance:AgentInstance,pending:PendingCredentialRefresh,trigger:string):Promise<void>{
  if(!memberRuntimeAllowed(instance.memberId))return;
  try{
    const exported=exportPiConfigForMember({memberId:instance.memberId,modelRef:instance.appliedModel,credentialId:instance.appliedCredentialId});
    if(!exported||!instance.handle.refreshModelRegistry||!instance.handle.setModel){dropCredential(instance,`${pending.changeType}:${pending.profileId}`);return;}
    await trackMemberOperation(instance.memberId,async()=>{await instance.handle.refreshModelRegistry!({allowNetwork:false});await instance.handle.setModel!(instance.appliedModel,instance.appliedCredentialId!);});
    instance.appliedCredentialId=exported.profile?.id||instance.appliedCredentialId;
    if(instance.handle.runtimeParams)Object.assign(instance.handle.runtimeParams,{credentialId:instance.appliedCredentialId,credentialName:exported.profile?.name});
    logger.info("agent","credentialRefreshApplied",{member:instance.agentName,profileId:pending.profileId,trigger});
  }catch(error){if(pending.changeType==="profileDeleted")dropCredential(instance,String(error));else logger.warn("agent","credentialRefreshFailed",{member:instance.agentName,error:String(error)});}
}

export async function refreshAllInstanceModelRegistries():Promise<{refreshed:number;failed:number}>{
  let refreshed=0,failed=0;await Promise.all([...instances.values()].map(async instance=>{if(!instance.handle.refreshModelRegistry)return;try{await instance.handle.refreshModelRegistry({allowNetwork:false});refreshed++;}catch(error){failed++;logger.warn("agent","catalogRegistryRefreshFailed",{member:instance.agentName,error:String(error)});}}));return {refreshed,failed};
}

export async function invalidateModelCredentialProfile(profileId:string,providerSlug:string,changeType:PendingCredentialRefresh["changeType"]="profileUpdated"):Promise<Array<{roomId:string;memberName:string;applied:boolean;pending:boolean}>>{
  const pending={profileId,providerSlug,changeType},targets=[...instances.values()].filter(instance=>instance.appliedCredentialId===profileId);
  return Promise.all(targets.map(async instance=>{const roomId=activeSource(instance)??instance.memberId;if(instance.status==="working"||instance.dispatchState!=="idle"){instance.pendingCredentialRefresh=pending;return {roomId,memberName:instance.agentName,applied:false,pending:true};}await refreshCredential(instance,pending,"credentialProfileInvalidated");return {roomId,memberName:instance.agentName,applied:true,pending:false};}));
}

export class MemberModelSwitchConflictError extends Error{constructor(memberId:string){super(`A model switch is already in progress for this member (${memberId})`);this.name="MemberModelSwitchConflictError";}}
export interface MemberModelSwitchResult{model:string;credentialId:string;instances:Array<{scopeId:string;applied:boolean}>}

export async function switchMemberModel(memberId:string,binding:{model:string;credentialId:string}):Promise<MemberModelSwitchResult>{
  if(memberSwitchGates.has(memberId))throw new MemberModelSwitchConflictError(memberId);
  let release=()=>{};memberSwitchGates.set(memberId,new Promise<void>(resolve=>{release=resolve;}));
  try{
    const {model,profile}=normalizedBinding(binding.model,binding.credentialId);await Promise.all(pendingCreationsFor(memberId));
    const instance=instances.get(instanceKey(memberId)),original=instance?{model:instance.appliedModel,credentialId:instance.appliedCredentialId}:null;
    try{if(instance)await applyModel(instance,{model,credentialId:profile.id},"switchMemberModel");controlServices().commitModelBinding(memberId,{model,credentialId:profile.id});}
    catch(error){if(instance&&original?.model&&original.credentialId)try{await applyModel(instance,original,"switchMemberModel-rollback");}catch{destroyInstance(memberId);}throw error;}
    return {model,credentialId:profile.id,instances:instance?[{scopeId:activeSource(instance)??memberId,applied:true}]:[]};
  }finally{memberSwitchGates.delete(memberId);release();}
}

export async function switchMemberThinkingLevel(memberId:string,thinkingLevel:string):Promise<{applied:string[];pending:string[]}>{
  const instance=instances.get(instanceKey(memberId));if(!instance)return {applied:[],pending:[]};const source=activeSource(instance)??memberId;
  if(instance.status==="working"||instance.dispatchState!=="idle"){instance.pendingThinkingSwitch={thinkingLevel};return {applied:[],pending:[source]};}
  await applyThinking(instance,{thinkingLevel},"switchMemberThinkingLevel");return {applied:[source],pending:[]};
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
export async function compactMember(sourceRef:string|null,memberId:string):Promise<{ok:boolean;action:string}>{
  const instance=instances.get(instanceKey(memberId))??await buildMemberAgentSession(memberId)??undefined;
  if(!instance)throw new Error(`No active member session to compact (${memberId})`);
  if(instance.compacting)throw new Error("Compaction is already in progress for this session");
  instance.activeSourceRef=sourceRef;instance.compacting=true;updateDispatchState(instance,"running","compact-requested");
  transition(instance,sourceRef,instance.agentName,"working","compact-requested");
  try{
    if(instance.turnActive||instance.promptInFlight){settleMemberShellWaits(memberId);instance.handle.abort();await instance.handle.waitForIdle();}
    if(instance.dispatchState==="aborting"||!memberRuntimeAllowed(memberId))return {ok:false,action:"stopped"};
    const outcome=await instance.handle.compact();return outcome.aborted?{ok:false,action:"stopped"}:{ok:true,action:"compacted"};
  }catch(error){
    const message=formatRuntimeErrorMessage(error);logger.error("agent","manualCompactFailed",{member:instance.agentName,sourceRef,error:message});
    noticeCurrentSource(instance,`Manual compaction failed for "${instance.agentName}": ${message}`);throw error;
  }finally{
    if(instance.compacting){instance.compacting=false;updateDispatchState(instance,"idle","compact-settled");transition(instance,sourceRef,instance.agentName,"idle","compact-settled");drainQueuedInputsAsPrompt(instance,"compact-settled");}
    if(instance.activeSourceRef===sourceRef&&!instance.promptInFlight&&!instance.turnActive)instance.activeSourceRef=null;
  }
}

// -- Abort --

/** Drop the member's live runtime (teardown only; no SQL side effects). */
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
  destroyInstance(memberId);
  clearRuntimeStateEntry(memberId);
  for (const scope of scopes) {
    const statusEvent = { type: "agent:status" as const, roomId: scope, agent: agentName, ...memberIdentityMeta(agentName, memberId), status: "inactive" as const };
    controlServices().publishReset(scope, agentName, statusEvent);
  }
  controlServices().emitEvent(null, memberId, { type: "system", text: message });
  logger.info("agent", "memberSessionReset", { memberId, member: agentName });
  return { ok: true, message };
}

/** Restart the member's runtime: drop it; the next activation rebuilds. */
export function restartMember(memberId: string): { ok: true; message: string } {
  cancelPendingRuntimeInputs(memberId, "member restart");
  destroyInstance(memberId);
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
      contextUsageCache.delete(key);
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
    contextUsageCache.clear();
    if (failures.length) throw new AggregateError(failures, "Runtime shutdown incomplete");
  })().finally(() => { shutdownRunning = false; });
  return shutdownSettlement;
}
