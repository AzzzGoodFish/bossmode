import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, type Database } from "../data/database.js";
import { getBossmodeDir, memberDir, membersRoot, memberSkillsDir, memberExtensionsDir } from "../files/layout.js";
import { syncMemberBirthAssets } from "../member/assets.js";
import { documentContentMeta, insertInitialDocument } from "../member/assets.js";
import { ensureDmScope } from "../chat/conversations.js";
import { getMember, getMemberConfiguration, getRetainedMember, insertMemberIdentity, prepareMemberIdentity, type MemberRecord, type CreateMemberInput } from "../member/identity.js";
import { ensureDefaultRegistry, prepareMemberSshCredential, importSshCredential, activeWorkspaceRoot } from "../member/workspaces.js";
import { builtinMcpAdapterPath, discoverMemberExtensionEntries } from "../member/extensions.js";
import { filterMcpConfigForServers, getAssignableMcpServerNames, getBossmodeMcpRuntimeDir, readMemberMcpConfig } from "../member/mcp.js";
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

import { acceptAgentAdmission, acceptControlInput, pendingRuntimeInputOwners, waitForInputSettlement, pumpRuntimeInputs, wakeAgent } from "../agent/scheduler.js";

import { appendMessageWithAdmissions, confirmChatAdmission, listPendingChatAdmissions, repairPendingChatAdmission, type PreparedChatAdmission } from "../chat/delivery.js";
import { scheduleMessageDispatch, type Message, type MessageInput } from "../chat/messages.js";
import { isBlankPersona } from "../member/profile.js";
import { memberRuntimeAllowed } from "../agent/instance.js";

import { logger } from "../kernel/logger.js";

import * as roomStore from "../chat/conversations.js";
import { parseScopeId, type ScopeId } from "../chat/conversations.js";
import type { AgentMemberConfig } from "../agent/types.js";

import type { AgentStatus, ContextUsage } from "../agent/types.js";
import { contextUsageCache, instanceKey, instances, pendingCreations } from "../agent/instance.js";


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
