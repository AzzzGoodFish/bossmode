import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createJiti } from "jiti";
import { getDatabase, type Database } from "../data/database.js";
import { getBossmodeDir, memberDir, membersRoot, memberSkillsDir, memberExtensionsDir } from "../files/layout.js";
import { syncMemberBirthAssets } from "../member/assets.js";
import { documentContentMeta, insertInitialDocument } from "../member/assets.js";
import { ensureDmScope } from "../chat/conversations.js";
import { getMember, getMemberConfiguration, getRetainedMember, insertMemberIdentity, prepareMemberIdentity, normalizeMemberName, validateMemberName, deleteMemberIdentity, type MemberRecord, type CreateMemberInput } from "../member/identity.js";
import { ensureDefaultRegistry, prepareMemberSshCredential, importSshCredential, activeWorkspaceRoot, getActiveWorkspace, getWorkspace } from "../member/workspaces.js";
import { configureTerminalWorkspaces } from "../agent/terminal.js";
import { resolveGlobalSkillPaths } from "../member/skills.js";
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
  const memberSkillRoot = memberSkillsDir(memberId);
  const skillPaths = resolveGlobalSkillPaths(skillNames);
  if (existsSync(memberSkillRoot)) skillPaths.push(memberSkillRoot);
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

import { configureControls, applyPendingAfterPromptSettlement, interruptAcceptedInput, destroyInstance } from "../agent/controls.js";

import { recoverRuntimeInputState, acceptAgentAdmission, acceptControlInput, pendingRuntimeInputOwners, cancelPendingRuntimeInputs, waitForInputSettlement, configureScheduler, pumpRuntimeInputs, wakeAgent } from "../agent/scheduler.js";

import { appendMessageWithAdmissions, confirmChatAdmission, dismissPendingReplies, listPendingChatAdmissions, listPendingReplies, repairPendingChatAdmission, type PreparedChatAdmission } from "../chat/delivery.js";
import { scheduleMessageDispatch, type Message, type MessageInput } from "../chat/messages.js";
import { isBlankPersona } from "../member/profile.js";
import { openRuntimeAdmission, memberRuntimeAllowed } from "../agent/instance.js";

import { logger } from "../kernel/logger.js";

import * as roomStore from "../chat/conversations.js";
import * as sessionStore from "../member/sessions.js";

import { buildMemberAgentSession, reloadMemberSession, maybeFlushPendingReload, compileForMember, getRegistry, configureAssembly } from "../agent/assembly.js";

import { isMmScopeId, parseMmScopeId, scopeIdOf, parseScopeId, type ScopeId } from "../chat/conversations.js";
import { listRoomsForMember } from "../chat/conversations.js";
import { applyMemberConfigPatch, updateMember } from "../member/identity.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk } from "../agent/events.js";
import { clearRuntimeStateEntry } from "../agent/instance.js";
import type { AgentHistoryEvent } from "../agent/events.js";
import type { RuntimeRegistry } from "../agent/types.js";
import type { AgentStreamEvent, AgentMemberConfig } from "../agent/types.js";

import type { AgentStatus, ContextUsage } from "../kernel/types.js";
import { contextCompactionWarningCache, contextUsageCache, instanceKey, instances, isCompactUsageDrop, memberIdentityMeta, pendingCreations, shouldKeepCompactedMarker, type AgentInstance } from "../agent/instance.js";

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

export function initializeMemberRuntime(reg: RuntimeRegistry, loadPrompt: (memberId: string) => MemberPromptSource, loadSnapshot: (memberId: string) => AgentMemberSnapshot | null): void {
  configureTerminalWorkspaces((memberId,workspaceId)=>(workspaceId?getWorkspace(memberId,workspaceId):getActiveWorkspace(memberId))??undefined);
  configureMcpFactoryLoader(async adapterPath=>{
    const loaded=await createJiti(import.meta.url).import(join(dirname(adapterPath),"host-factory.js")) as any;
    return {name:"pi-mcp-adapter",factory:loaded.createMcpAdapter({authStorage:createMcpOauthStorage(getDatabase())})};
  });
  configureControls({
    memberConfig: memberRecordToConfig,
    resolveMember: resolveRoomMember,
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
    reloadSession: reloadMemberSession,
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

/**
 * ① B4: working-set for contacts — the scopes where this member has unhandled
 * messages queued or a turn being served right now (one runtime serves every
 * chat, so the build scope says nothing about where it is active).
 */
export function getMemberActiveScopes(globalMemberId: string): ScopeId[] {
  const scopes = new Set<string>(pendingRuntimeInputOwners(globalMemberId).filter((scope): scope is string => scope !== null));
  const instance = instances.get(instanceKey(globalMemberId));
  if (instance?.activeSourceRef && (instance.status === "working" || instance.dispatchState !== "idle")) {
    scopes.add(instance.activeSourceRef);
  }
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
      applyMemberConfigPatch(memberId, patch as Record<string, unknown>);
    } catch (err) {
      logger.error("agent", "persistConfigPatch: member not in registry", { memberId, roomId, error: String(err) });
    }
    return;
  }
  roomStore.updateRoomMemberOverride(roomId, memberId, patch);
}

export function getAgentStatus(roomId: string, memberRef: string): AgentStatus {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const instance = instances.get(instanceKey(memberId));
  if (!instance) return "inactive";
  return instance.status;
}

export function getMemberBusyState(roomId: string, memberRef: string): { busy: boolean; reason?: string } {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const key = instanceKey(memberId);
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

export function getAgentContextUsage(roomId: string, memberRef: string): ContextUsage | null {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  const key = instanceKey(memberId);
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
  const key = instanceKey(memberId);
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
  const key = instanceKey(memberId);
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
    const timer = setTimeout(() => {
      // A retry can fire after teardown (shutdown, test isolation): drop it
      // instead of letting the storage access escape as an unhandled error.
      try { refreshContextUsageOnce(roomId, memberRef, options); }
      catch { /* runtime torn down — drop the retry */ }
    }, delay * i);
    (timer as { unref?: () => void }).unref?.();
  }
}

function emitAgentLocalEvent(
  sourceRef: string | null,
  memberRef: string,
  event: AgentHistoryEvent,
  identity?: { memberId: string; agentName: string },
): void {
  const scopedMember = sourceRef?.startsWith("dm:") ? getMember(memberRef) : null;
  const roomId = sourceRef ? chatTargetOf(sourceRef) : null;
  const member = identity ? undefined : scopedMember ?? (roomId ? roomStore.resolveRoomMemberRef(roomId, memberRef) : undefined);
  // Prefer live instance identity, then the global member record for DM.
  const keyHint = instanceKey(member?.id || memberRef);
  const instance = instances.get(keyHint);
  const memberId = identity?.memberId || member?.id || instance?.memberId || memberRef;
  const agentName = identity?.agentName || member?.name || instance?.agentName || memberRef;
  // Use the same authoritative, commit-safe event/outbox path as SDK events.
  // Failed persistence is not a successful activity notification.
  processEvent(sourceRef,agentName,keyHint,event as AgentStreamEvent,instance?.eventBuffer ?? [],memberId);

}

// -- Instance management --

export function getMemberInstances(memberName: string): Array<{
  roomId: string;
  roomName: string;
  status: AgentStatus;
  runtime: string;
  pid?: number;
  spawnArgs?: string[];
  runtimeParams?: import("../agent/types.js").AgentRuntimeParams;
}> {
  const result: Array<{ roomId: string; roomName: string; status: AgentStatus; runtime: string; pid?: number; spawnArgs?: string[]; runtimeParams?: import("../agent/types.js").AgentRuntimeParams }> = [];
  for (const instance of instances.values()) {
    if (instance.agentName === memberName || instance.memberId === memberName) {
      const roomId = instance.activeSourceRef ?? `dm:${instance.memberId}`;
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

// -- Member-level operations (① B5) --
// Stop / compact / reset / restart target the member directly — one runtime
// per member means no chat scope belongs in the interface.

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

import { MemberNotFoundError } from "../member/identity.js";
import type { RoomMemberRecord } from "../kernel/types.js";

function toAgentMemberConfig(roomMember: RoomMemberRecord): AgentMemberConfig | null {
  const globalId = roomMember.id.startsWith("mem_") ? roomMember.id
    : roomMember.sourceMemberId?.startsWith("mem_") ? roomMember.sourceMemberId : undefined;
  if (globalId) {
    // Current identity and configuration come exclusively from the database.
    // Cleared values must never revive config from a historical room shadow.
    const member = getMember(globalId);
    if (!member) throw new MemberNotFoundError(globalId);
    const config = getMemberConfiguration(globalId);
    return {
      id: globalId,
      name: member.name,
      type: "agent",
      agent: member.agentTemplate,
      runtime: "pi-cli",
      model: config.model ?? undefined,
      credentialId: config.credentialId ?? undefined,
      thinkingLevel: config.thinkingLevel || "off",
      skills: config.skills,
      mcpServers: config.mcpServers,
      createdAt: roomMember.createdAt,
      ...(member.title ? { title: member.title } : {}),
    };
  }

  // Legacy snapshots are display/import data, not executable members.
  return null;
}

export function resolveRoomMember(roomId: string, memberRef: string): AgentMemberConfig | null {
  const roomMember = roomStore.resolveRoomMemberRef(roomId, memberRef);
  if (roomMember) return toAgentMemberConfig(roomMember);
  return null;
}

import type { WsServerEvent } from "../kernel/types.js";
/** Transport is registered by app/wire, never imported by application use cases. */
export type RuntimeViewSink = (scopeId: string, event: WsServerEvent, memberName?: string) => void;
let runtimeViewSink: RuntimeViewSink | undefined;
export function setRuntimeViewSink(sink: RuntimeViewSink | undefined): void { runtimeViewSink = sink; }
const broadcastToRoom = (scopeId: string, event: WsServerEvent): void => { runtimeViewSink?.(scopeId, event); };
const broadcastToAgentSubscribers = (scopeId: string, name: string, event: WsServerEvent): void => { runtimeViewSink?.(scopeId, event, name); };
export function getRuntimeCapabilities() { return getRegistry()?.getCapabilities() ?? {}; }
