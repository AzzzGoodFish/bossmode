import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import { getDatabase, type Database } from "../data/database.js";
import { getBossmodeDir, memberDir, membersRoot, memberSkillsDir, memberExtensionsDir } from "../files/layout.js";
import { syncMemberBirthAssets } from "../member/assets.js";
import { documentContentMeta, insertInitialDocument } from "../member/assets.js";
import { ensureDmScope } from "../chat/conversations.js";
import { getMember, getMemberConfiguration, getRetainedMember, insertMemberIdentity, prepareMemberIdentity, type MemberRecord, type CreateMemberInput } from "../member/identity.js";
import { ensureDefaultRegistry, prepareMemberSshCredential, importSshCredential, activeWorkspaceRoot, getActiveWorkspace, getWorkspace } from "../member/workspaces.js";
import { configureTerminalWorkspaces } from "../agent/terminal.js";
import { builtinMcpAdapterPath, discoverMemberExtensionEntries } from "../member/extensions.js";
import { createMcpOauthStorage, filterMcpConfigForServers, getAssignableMcpServerNames, getBossmodeMcpRuntimeDir, readMemberMcpConfig } from "../member/mcp.js";
import { configureMcpFactoryLoader } from "../agent/runtime/resources.js";
import { getCurrentSession } from "../member/sessions.js";
import type { AgentMemberSnapshot } from "../agent/types.js";
import { writeMemberProfileSkeleton } from "../member/profile.js";
function insertWithDm(record: MemberRecord): void {
  getDatabase().transaction(() => {
    insertMemberIdentity(record);
    ensureDmScope(record.id);
  });
}
export function createMember(input: CreateMemberInput): MemberRecord { return createMemberWithPersona(input, ""); }
/** All owned files precede the one identity/document/workspace/SSH/chat transaction. */
export function createMemberWithPersona(input: CreateMemberInput, persona: string,
  prepareMetadata?: (record: MemberRecord) => (db: Database) => void,
): MemberRecord {
  getDatabase().assertOutsideTransaction();
  if (typeof persona !== "string") throw new Error("invalid_member_persona");
  if (prepareMetadata?.constructor.name === "AsyncFunction") throw new Error("member_metadata_preparation_must_be_synchronous");
  mkdirSync(membersRoot(), { recursive: true });
  let record = prepareMemberIdentity(input);
  for (let attempt = 0; attempt < 10 && (getRetainedMember(record.id) || existsSync(memberDir(record.id))); attempt++) record = prepareMemberIdentity(input);
  const id = record.id;
  mkdirSync(memberDir(id));
  try {
    mkdirSync(join(memberDir(id), "memory"));
    writeMemberProfileSkeleton(id);
    writeFileSync(join(memberDir(id), "persona.md"), persona, "utf8");
    const meta = documentContentMeta(persona);
    const ssh = prepareMemberSshCredential(id);
    const commitMetadata = prepareMetadata?.(record);
    if (commitMetadata && (typeof commitMetadata !== "function" || commitMetadata.constructor.name === "AsyncFunction")) throw new Error("member_metadata_commit_must_be_synchronous");
    syncMemberBirthAssets(memberDir(id));
    getDatabase().transaction(db => {
      insertWithDm(record);
      insertInitialDocument(db, { path: `members/${id}/persona.md`, layer: "persona", memberId: id }, meta);
      ensureDefaultRegistry(id);
      importSshCredential(id, ssh, db);
      if (commitMetadata) getDatabase().transaction(commitMetadata);
    });
  } catch (error) {
    try { rmSync(memberDir(id), { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Member birth failed and owned-asset cleanup failed"); }
    throw error;
  }
  return record;
}

import { MemberArchiveService } from "../member/archive.js";
import { quiesceMember } from "../agent/controls.js";

/** Session build material for the agent core: member config projection, resolved
 *  skill paths, workspace root and the stored session to resume. Assembled here
 *  so agent code never imports member state directly. */
export function loadAgentMemberSnapshot(memberId: string): AgentMemberSnapshot | null {
  const config = memberRecordToConfig(memberId);
  if (!config) return null;
  const skillNames = config.skills ?? [];
  const memberSkillRoot=memberSkillsDir(memberId);
  const skillPaths=existsSync(memberSkillRoot)?[memberSkillRoot]:[];
  const mcpConfig = readMemberMcpConfig(memberId) ?? { mcpServers: {} };
  const mcpServerNames = getAssignableMcpServerNames(mcpConfig);
  const savedSession = getCurrentSession(memberId);
  const prompt = compileMemberPrompt(loadMemberPromptSource(memberId));
  return {
    config,
    prompt,
    resources: {
      skillNames,
      skillPaths,
      extensionPaths: discoverMemberExtensionEntries(memberExtensionsDir(memberId)),
      mcp: {
        adapterPath: builtinMcpAdapterPath(),
        runtimeDir: getBossmodeMcpRuntimeDir(),
        config: filterMcpConfigForServers(mcpConfig, mcpServerNames),
        serverNames: mcpServerNames,
      },
    },
    workspaceRoot: activeWorkspaceRoot(memberId),
    resumeSession: savedSession
      ? { sessionId: savedSession.sessionId, sessionFile: savedSession.sessionFile }
      : undefined,
  };
}
import { detachMemberFromConversations } from "../chat/conversations.js";
function memberArchives(): MemberArchiveService {
  return new MemberArchiveService(getDatabase(), getBossmodeDir(), { quiesce: quiesceMember, detachFromConversations: detachMemberFromConversations });
}
export function archiveMember(memberId: string, options: { confirm?: boolean }): Promise<{ archived: string }> {
  return memberArchives().archive(memberId, options);
}
export function recoverMemberArchives(): Promise<void> { return memberArchives().recoverPending(); }

import { readMemberProfile } from "../member/profile.js";
import { requireMember } from "../member/identity.js";
import { buildSkillCatalog } from "../member/skills.js";
import { memberArchiveDir } from "../files/layout.js";
import { directoryHasReadableEntries } from "../files/io.js";
import { compileMemberPrompt, type MemberPromptSource } from "../agent/prompt.js";
/** Capture member-owned prompt inputs once; compilation does not read storage. */
export function loadMemberPromptSource(memberId: string, contextWindowTokens = 128_000): MemberPromptSource {
  const member = requireMember(memberId);
  const profile = readMemberProfile(memberId);
  const catalog = buildSkillCatalog(memberId, contextWindowTokens);
  return {
    memberId, memberName: member.name, description: member.title,
    persona: profile.body, profileOverBudget: profile.overBudget,
    skillsEnabled: catalog.entries.map(entry => entry.relPath.replace(/\/SKILL\.md$/, "")).join(", "),
    platformSkillsDir: catalog.platformSkillsDir,
    archiveAvailable: directoryHasReadableEntries(memberArchiveDir(memberId)),
  };
}
export function previewMemberPrompt(memberId: string, contextWindowTokens?: number) {
  return compileMemberPrompt(loadMemberPromptSource(memberId, contextWindowTokens));
}

import { configureControls, applyPendingAfterPromptSettlement, interruptAcceptedInput } from "../agent/controls.js";

import { recoverRuntimeInputState, acceptAgentAdmission, acceptControlInput, pendingRuntimeInputOwners, waitForInputSettlement, configureScheduler, pumpRuntimeInputs, wakeAgent } from "../agent/scheduler.js";

import { appendMessageWithAdmissions, confirmChatAdmission, dismissPendingReplies, listPendingChatAdmissions, listPendingReplies, repairPendingChatAdmission, type PreparedChatAdmission } from "../chat/delivery.js";
import { scheduleMessageDispatch, type Message, type MessageInput } from "../chat/messages.js";
import { isBlankPersona } from "../member/profile.js";
import { openRuntimeAdmission, memberRuntimeAllowed } from "../agent/instance.js";

import { logger } from "../kernel/logger.js";

import * as roomStore from "../chat/conversations.js";
import * as sessionStore from "../member/sessions.js";

import { buildMemberAgentSession, maybeFlushPendingReload, compileForMember, configureAssembly } from "../agent/assembly.js";

import { isMmScopeId, parseMmScopeId, scopeIdOf, parseScopeId, type ScopeId } from "../chat/conversations.js";
import { listRoomsForMember } from "../chat/conversations.js";
import { updateMember } from "../member/identity.js";
import { handleAgentEvent as processEvent } from "../agent/events.js";
import type { AgentHistoryEvent } from "../agent/events.js";
import type { RuntimeRegistry } from "../agent/types.js";
import type { AgentStreamEvent, AgentMemberConfig } from "../agent/types.js";

import type { AgentStatus, ContextUsage } from "../agent/types.js";
import { contextUsageCache, instanceKey, instances, memberIdentityMeta, pendingCreations, type AgentInstance, type AgentStatusBroadcast } from "../agent/instance.js";

const chatTargetOf = (sourceRef: string): string => sourceRef.startsWith("room:") ? sourceRef.slice(5) : sourceRef;
const canonicalSourceRef = (value: string): string => value.startsWith("room:") || value.startsWith("dm:") || value.startsWith("mm:") ? value : `room:${value}`;
const runtimeInputOwner = (sourceRef: string, memberId: string) => ({ scopeId: canonicalSourceRef(sourceRef), targetActorKey: memberId });

/** Compose chat acceptance, agent enqueue and cursor confirmation in the caller's transaction. */
export function acceptPreparedChatAdmission(db: Database, admission: PreparedChatAdmission) {
  const { chatToken, ...agentAdmission } = admission;
  const receipt = acceptAgentAdmission(db, agentAdmission);
  confirmChatAdmission(db, chatToken, receipt.inputId);
  if (receipt.enqueued) db.afterCommit(() => {
    void wakeAgent(admission.memberId, receipt).catch(error =>
      logger.error("agent", "accepted chat input wake failed", { memberId: admission.memberId, inputId: receipt.inputId, error: String(error) }));
  });
  return receipt;
}

export function repairPendingAgentAdmissions(): number {
  const db=getDatabase();let repaired=0;
  for(const candidate of listPendingChatAdmissions(db))db.transaction(tx=>{
    const admission=repairPendingChatAdmission(tx,candidate.sourceRef,candidate.chatToken.messageId,candidate.memberId);
    if(!admission)return;
    acceptPreparedChatAdmission(tx,admission);repaired++;
  });
  return repaired;
}

export function commitChatMessage(sourceRef: string, input: MessageInput): Message {
  const message = getDatabase().transaction(tx => {
    const prepared = appendMessageWithAdmissions(tx, sourceRef, input);
    for (const admission of prepared.admissions) acceptPreparedChatAdmission(tx, admission);
    return prepared.message;
  });
  scheduleMessageDispatch();
  return message;
}

export function initializeMemberRuntime(reg: RuntimeRegistry, loadSnapshot: (memberId: string) => AgentMemberSnapshot | null): void {
  configureTerminalWorkspaces((memberId,workspaceId)=>(workspaceId?getWorkspace(memberId,workspaceId):getActiveWorkspace(memberId))??undefined);
  configureMcpFactoryLoader(async adapterPath=>{
    const loaded=await createJiti(import.meta.url).import(join(dirname(adapterPath),"host-factory.js")) as any;
    return {name:"pi-mcp-adapter",factory:loaded.createMcpAdapter({authStorage:createMcpOauthStorage(getDatabase())})};
  });
  configureControls({
    memberConfig: memberRecordToConfig,
    memberScopes: memberScopesFor,
    clearSession: sessionStore.clearCurrentSession,
    commitModelBinding: (memberId, binding) => { updateMember(memberId, { global: binding }); },
    emitEvent: emitAgentLocalEvent,
    postSystemNotice: (scopeId, text) => { commitChatMessage(scopeId, { sender: "system", content: text, mentions: [] }); },
    publishStatus: broadcastToRoom,
    publishReset: (scopeId, memberName, event) => {
      if (scopeId.startsWith("dm:")) broadcastToAgentSubscribers(chatTargetOf(scopeId), memberName, event);
      else broadcastToRoom(chatTargetOf(scopeId), event);
    },
  });
  recoverRuntimeInputState();
  openRuntimeAdmission();
  configureAssembly(reg, loadSnapshot, {
    saveSession: (memberId, runtime, session) => sessionStore.saveCurrentSession(memberId, { runtime, ...session }),
  });
  configureScheduler({
    buildSession: buildMemberAgentSession,
    memberConfig: memberRecordToConfig,
    authorizeExecution: (memberId, sourceRef) => sourceRef === null || memberScopeAllowsExecution(sourceRef, memberId),
    postSystemNotice: (sourceRef, text) => { commitChatMessage(sourceRef, { sender: "system", content: text, mentions: [] }); },
    emitEvent: emitAgentLocalEvent,
    refreshProfileSources,
    applyPendingControls: applyPendingAfterPromptSettlement,
    interruptAccepted: (instance, sourceRef) => interruptAcceptedInput(sourceRef, instance, "message_interrupt"),
    flushPendingReload: maybeFlushPendingReload,
    hasPendingReply: (db, memberId, sourceRef, replySources) =>
      listPendingReplies(sourceRef, memberId, db).some(reply => replySources.includes(reply.messageId)),
    dismissReplies: (db, memberId, sourceRef, diagnosis, disposition) => {
      if (!sourceRef) return;
      dismissPendingReplies(sourceRef, memberId, disposition, diagnosis, Date.now(), undefined, db);
    },
  });
  repairPendingAgentAdmissions();
}

/** Current SQL scope access, separate from immutable historical execution ownership. */
function memberHasScopeAccess(scopeValue: string, memberId: string): boolean {
  const scope = runtimeInputOwner(scopeValue, memberId).scopeId;
  if (scope.startsWith("dm:")) return scope === `dm:${memberId}`;
  if (isMmScopeId(scope)) return Boolean(parseMmScopeId(scope)?.includes(memberId));
  return scope.startsWith("room:") && !!roomStore.resolveRoomMemberRef(chatTargetOf(scope), memberId);
}
function memberScopeAllowsExecution(scopeValue: string, memberId: string): boolean {
  return memberRuntimeAllowed(memberId) && memberHasScopeAccess(scopeValue, memberId);
}

export function getScopeLiveStatus(scopeId:ScopeId):"idle"|"working"|"inactive"{
  const ref=parseScopeId(scopeId);if(!ref)return "inactive";
  if(ref.kind==="dm")return getAgentStatus(ref.memberId);
  const statuses=roomStore.getRoomMembers(ref.roomId).map(member=>getAgentStatus(member.id));
  return statuses.includes("working")?"working":statuses.some(status=>status!=="inactive")?"idle":"inactive";
}

export function getMemberActiveScopes(memberId:string):ScopeId[]{
  const scopes=new Set(pendingRuntimeInputOwners(memberId).filter((scope):scope is string=>scope!==null));
  const instance=instances.get(instanceKey(memberId));if(instance?.activeSourceRef&&(instance.status==="working"||instance.dispatchState!=="idle"))scopes.add(instance.activeSourceRef);
  return [...scopes] as ScopeId[];
}

function refreshProfileSources(instance: AgentInstance): void {
  if (!instance.profilePromptDirty) return;
  const member = getMember(instance.memberId);
  if (!member) throw new Error(`Member no longer exists: ${instance.memberId}`);
  // One prompt per member; chat source never participates in refresh.
  const compiled = compileForMember(member.id);
  instance.agentName = member.name;
  instance.sessionSources.member.name = member.name;
  instance.sessionSources.member.title = member.title;
  instance.sessionSources.compiled = compiled;
}

export function getAgentStatus(memberId:string):AgentStatus{return instances.get(instanceKey(memberId))?.status??"inactive";}
export function getMemberBusyState(memberId:string):{busy:boolean;reason?:string}{
  const key=instanceKey(memberId),instance=instances.get(key);if(pendingCreations.has(key))return {busy:true,reason:"pending_creation"};if(!instance)return {busy:false};
  const reason=instance.status==="working"?"working":instance.dispatchState!=="idle"?instance.dispatchState:instance.promptInFlight?"prompt_in_flight":undefined;return reason?{busy:true,reason}:{busy:false};
}
export function getRoomAgentStatuses(roomId:string):Record<string,AgentStatus>{return Object.fromEntries(roomStore.getRoomMembers(roomId).map(member=>[member.name,getAgentStatus(member.id)]));}
export function getAgentContextUsage(memberId:string):ContextUsage|null{return contextUsageCache.get(instanceKey(memberId))??null;}
export function getMemberActiveTools(memberId:string):{sessionActive:boolean;tools:Array<{name:string;label?:string;description:string;parameters:unknown;source:string}>;message?:string}{
  const handle=instances.get(instanceKey(memberId))?.handle;if(!handle?.getActiveTools)return {sessionActive:false,tools:[],message:"Start or Reload this member to see active tools."};return {sessionActive:true,tools:handle.getActiveTools()||[]};
}

export function refreshContextUsage(roomId:string,memberId:string):void{
  const agentName=getMember(memberId)?.name||memberId,key=instanceKey(memberId),instance=instances.get(key);
  if(!instance?.handle.getContextUsage)return;
  instance.handle.getContextUsage().then(usage=>{
    if(!usage)return;
    contextUsageCache.set(key,usage);
    broadcastToRoom(roomId,{type:"agent:context_usage",roomId,agent:agentName,...memberIdentityMeta(agentName,memberId),usage});
  }).catch(()=>{});
}

function emitAgentLocalEvent(sourceRef:string|null,memberId:string,event:AgentHistoryEvent):void{
  const instance=instances.get(instanceKey(memberId)),agentName=instance?.agentName??getMember(memberId)?.name??memberId;
  processEvent(sourceRef,agentName,instanceKey(memberId),event as AgentStreamEvent,instance?.eventBuffer??[],memberId);
}

// -- Instance management --

/** Every scope this member can hold queued work in. */
function memberScopesFor(memberId: string): string[] {
  return [
    ...listRoomsForMember(memberId).map((r) => `room:${r.id}`),
    ...roomStore.listMmScopesForMember(memberId),
    scopeIdOf({ kind: "dm", memberId }),
  ];
}

export function getActiveInstanceCount(): number {
  return instances.size;
}

// -- DM activation (0.20, no @ required) -------------------------------------

export function memberRecordToConfig(memberId: string): AgentMemberConfig | null {
  const rec = getMember(memberId);
  if (!rec) return null;
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

/** Activate a newly created member in its explicit user DM. Ordinary DM
 * messages enter through the chat admission transaction instead. */
export async function activateDmMember(memberId:string):Promise<void>{
  if(!memberRuntimeAllowed(memberId))return;
  const member=getMember(memberId);if(!member)return;
  const sourceRef=`dm:${memberId}`;
  const prompt=isBlankPersona(readMemberProfile(memberId))
    ?`You are in a private chat with the user (${sourceRef}). Introduce yourself briefly with chat_send and ask what they want you around for.`
    :`You are in a private chat with the user (${sourceRef}). Greet briefly with chat_send, or wait for their request.`;
  const {input}=acceptControlInput(sourceRef,memberId,{prompt,source:"private_instruction",trigger:"dm-activate",replySources:[]},false);
  await waitForInputSettlement(input,pumpRuntimeInputs(memberId));
}

type RuntimeViewEvent=AgentStatusBroadcast|{type:"agent:context_usage";roomId:string;agent:string;memberId:string;usage:ContextUsage|null};
/** Transport is registered by app/wire, never imported by application use cases. */
export type RuntimeViewSink = (scopeId:string,event:RuntimeViewEvent,memberName?:string)=>void;
let runtimeViewSink:RuntimeViewSink|undefined;
export function setRuntimeViewSink(sink:RuntimeViewSink|undefined):void{runtimeViewSink=sink;}
const broadcastToRoom=(scopeId:string,event:RuntimeViewEvent):void=>{runtimeViewSink?.(scopeId,event);};
const broadcastToAgentSubscribers=(scopeId:string,name:string,event:RuntimeViewEvent):void=>{runtimeViewSink?.(scopeId,event,name);};
