import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, type Database } from "../data/database.js";
import { getBossmodeDir, memberDir, membersRoot } from "../files/layout.js";
import { syncMemberBirthAssets } from "../member/assets.js";
import { documentContentMeta, insertInitialDocument } from "../member/assets.js";
import { ensureDmScope } from "../chat/conversations.js";
import { getMember, getMemberConfiguration, getRetainedMember, insertMemberIdentity, prepareMemberIdentity, normalizeMemberName, validateMemberName, deleteMemberIdentity, type MemberRecord, type CreateMemberInput } from "../member/identity.js";
import { ensureDefaultRegistry, prepareMemberSshCredential, importSshCredential, activeWorkspaceRoot } from "../member/workspaces.js";
import { resolveGlobalSkillPaths } from "../member/skills.js";
import { getCurrentSession } from "../member/sessions.js";
import type { AgentMemberSnapshot } from "../agent/types.js";
import { writeMemberProfileSkeleton } from "../member/profile.js";

function insertWithDm(record: MemberRecord): void {
  getDatabase().transaction(() => {
    insertMemberIdentity(record);
    ensureDmScope(record.id);
  });
}
/** Import a normalized identity and its private-chat anchor, without preparing live assets. */
export function importMemberRecord(record: MemberRecord): MemberRecord {
  if (!record || typeof record.id !== "string" || !/^mem_[a-zA-Z0-9_-]+$/.test(record.id) ||
      typeof record.name !== "string" || record.name !== normalizeMemberName(record.name) ||
      !record.name || record.name.length > 64 || /[/\0]/.test(record.name) ||
      typeof record.agentTemplate !== "string" || !record.agentTemplate ||
      !record.global || typeof record.global !== "object" || Array.isArray(record.global) ||
      !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt) ||
      (record.title !== undefined && typeof record.title !== "string")) throw new Error("invalid_member_record");
  validateMemberName(record.name);
  insertWithDm(record);
  return getMember(record.id)!;
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

/** Test cleanup still respects retained-history foreign keys. Never an archive operation. */
export function deleteMemberForTests(id: string): void {
  getDatabase().assertOutsideTransaction();
  deleteMemberIdentity(id);
  rmSync(memberDir(id), { recursive: true, force: true });
}

import { MemberArchiveService } from "../member/archive.js";
import { quiesceMember } from "../agent/controls.js";

/** Session build material for the agent core: member config projection, resolved
 *  skill paths, workspace root and the stored session to resume. Assembled here
 *  so agent code never imports member state directly. */
export function loadAgentMemberSnapshot(memberId: string): AgentMemberSnapshot | null {
  const config = memberRecordToConfig(memberId);
  if (!config) return null;
  const skills = config.skills ?? [];
  const savedSession = getCurrentSession(memberId);
  return {
    config,
    skillPaths: resolveGlobalSkillPaths(skills),
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

import { recoverRuntimeInputState, acceptRuntimeInput, acceptControlInput, pendingRuntimeInputOwners, runtimeInputOwner, cancelPendingRuntimeInputs, waitForInputSettlement, configureScheduler, pumpRuntimeInputs, type PreparedRuntimeInput } from "../agent/scheduler.js";

import {ReplyObligationRepository,type ReplyDisposition} from "../data/repositories/reply-obligation-repository.js";
import type {CapturedMessage} from "../data/repositories/delivery-repository.js";
import { isBlankPersona } from "../member/profile.js";
import type {MentionActivationCtx} from "../chat/router.js";

import { openRuntimeAdmission, memberRuntimeAllowed } from "../agent/instance.js";

import { logger } from "../kernel/logger.js";

import { isSystemNoticeHiddenFromMembers } from "../kernel/runtime-error-limit.js";
import * as roomStore from "../chat/conversations.js";
import * as sessionStore from "../member/sessions.js";

import * as attachmentStore from "../files/attachment-store.js";
import { postMessage, getMessagesSince } from "../chat/message-bus.js";
import { initRouter } from "../chat/router.js";

import { buildMemberAgentSession, reloadMemberSession, maybeFlushPendingReload, compileForMember, getRegistry, configureAssembly } from "../agent/assembly.js";

import { isMmScopeId, parseMmScopeId, scopeIdOf, parseScopeId, type ScopeId } from "../chat/conversations.js";
import { listRoomsForMember } from "../chat/conversations.js";
import { applyMemberConfigPatch, updateMember } from "../member/identity.js";
import { readAllDmMessages } from "../chat/dm-message-store.js";
import { handleAgentEvent as processEvent, loadEventsFromDisk } from "../agent/events.js";
import { loadScopeMessages } from "../agent/tools/tools.js";

import { clearRuntimeStateEntry } from "../agent/instance.js";
import {
  wrapRoomContextMessage,
  wrapRoomMessagesTranscript,
  resolveSenderRole,
  type SenderRole,
} from "../agent/prompt.js";
import type { AgentHistoryEvent } from "../agent/events.js";
import type { RuntimeRegistry } from "../agent/types.js";
import type { AgentStreamEvent, AgentMemberConfig } from "../agent/types.js";

import type { AgentStatus, RoomMessage, ContextUsage } from "../kernel/types.js";
import { chatTargetOf, contextCompactionWarningCache, contextUsageCache, instanceKey, instances, isCompactUsageDrop, memberIdentityMeta, pendingCreations, shouldKeepCompactedMarker, type AgentInstance } from "../agent/instance.js";

export function initializeMemberRuntime(reg: RuntimeRegistry, loadPrompt: (memberId: string) => MemberPromptSource, loadSnapshot: (memberId: string) => AgentMemberSnapshot | null): void {
  configureControls({
    memberConfig: memberRecordToConfig,
    resolveMember: resolveRoomMember,
    memberScopes: memberScopesFor,
    privateScope: memberId => scopeIdOf({ kind: "dm", memberId }),
    clearSession: sessionStore.clearCurrentSession,
    commitModelBinding: (memberId, binding) => { updateMember(memberId, { global: binding }); },
    emitEvent: emitAgentLocalEvent,
    postSystemNotice: (scopeId, text) => { postMessage(scopeId, "system", text); },
    publishStatus: broadcastToRoom,
    publishReset: (scopeId, memberName, event) => {
      if (scopeId.startsWith("dm:")) broadcastToAgentSubscribers(chatTargetOf(scopeId), memberName, event);
      else broadcastToRoom(chatTargetOf(scopeId), event);
    },
  });
  recoverRuntimeInputState();
  openRuntimeAdmission();
  configureAssembly(reg, loadPrompt, loadSnapshot, {
    isValidScope: scopeId => !!parseScopeId(scopeId) || isMmScopeId(scopeId),
    hasScopeAccess: memberHasScopeAccess,
    currentName: currentRuntimeName,
    conversation: sessionConversation,
    saveSession: (memberId, runtime, session) => sessionStore.saveCurrentSession(memberId, { runtime, ...session }),
    postSystemNotice: (scopeId, text) => { postMessage(scopeId, "system", text); },
  });
  configureScheduler({
    buildSession: (memberId, scopeId) => buildMemberAgentSession(memberId,
      scopeId.startsWith("dm:") || isMmScopeId(scopeId) ? scopeId : roomScopeId(scopeId)),
    memberConfig: memberRecordToConfig,
    canExecuteScope: memberScopeAllowsExecution,
    postSystemNotice: (scopeId, text) => { postMessage(scopeId, "system", text); },
    emitEvent: emitAgentLocalEvent,
    refreshProfileSources,
    applyPendingControls: applyPendingAfterPromptSettlement,
    flushPendingReload: maybeFlushPendingReload,
    reloadSession: reloadMemberSession,
  });
}

function filterAgentVisibleMessages(messages: RoomMessage[], _memberName: string): RoomMessage[] {
  // fish 2026-08-04: members never see system notices — neither runtime
  // failures nor non-error system prompts. Typed task/knowledge events stay.
  return messages.filter((message) => !isSystemNoticeHiddenFromMembers(message));
}

/** Last visible message that mentions this member (the @ that fired the
 * activation); -1 when nothing mentions (steer/system activations). */
function isOwnMessage(message: RoomMessage, memberId: string, memberName: string): boolean {
  return message.senderMemberId !== undefined ? message.senderMemberId === memberId
    : !memberId.startsWith("mem_") && message.sender === memberName;
}

function lastMentionTriggerIndex(messages: RoomMessage[], memberName: string, memberId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (Array.isArray(message.mentionMemberIds)) {
      if (message.mentionMemberIds.includes(memberId)) return i;
    } else if (!memberId.startsWith("mem_") && message.mentions?.includes(memberName)) return i;
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
  return `[Earlier in this room ${range}: ${senders}${eventClause}. Read them with chat_read (from_seq ${fromSeq}); reading marks them seen.]`;
}

function roomScopeId(roomId: string): ScopeId {
  return scopeIdOf({ kind: "room", roomId });
}

/** Current SQL scope access, separate from immutable historical execution ownership. */
function memberHasScopeAccess(scopeValue: string, memberId: string): boolean {
  const scope = runtimeInputOwner(scopeValue, memberId).scopeId;
  if (scope.startsWith("dm:")) return scope === `dm:${memberId}`;
  if (isMmScopeId(scope)) return Boolean(parseMmScopeId(scope)?.includes(memberId));
  return !!scope && !!roomStore.resolveRoomMemberRef(scope, memberId);
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
  const out: ScopeId[] = [];
  const seen = new Set<string>();
  const push = (scope: string) => { if (scope && !seen.has(scope)) { seen.add(scope); out.push(scope as ScopeId); } };
  const own = instances.get(instanceKey(globalMemberId));
  for (const scope of pendingRuntimeInputOwners(globalMemberId)) push(scope);
  if (own && (own.status === "working" || own.dispatchState !== "idle")) push(own.activeChat?.scopeId || own.scopeId);
  if (own || out.length) return Array.from(out);
  // Historical name-only members (no mem_ id): keep the legacy room/DM match.
  for (const inst of instances.values()) {
    if (inst.status !== "working" && inst.dispatchState === "idle") continue;
    if (inst.memberId.startsWith("mem_")) continue;
    if (inst.scopeId.startsWith("dm:")) {
      if (inst.memberId === globalMemberId || inst.scopeId === `dm:${globalMemberId}`) push(inst.scopeId);
      continue;
    }
    const roomUuid = inst.roomId.startsWith("room:") ? inst.roomId.slice("room:".length) : inst.roomId;
    const r = roomStore.getRoom(roomUuid);
    if (!r) continue;
    const local = roomStore.getRoomMembers(r.id).find((m) => m.id === inst.memberId || m.name === inst.agentName);
    if (!local) continue;
    const gid = roomStore.resolveGlobalMemberId(r, local);
    if (gid === globalMemberId) push(scopeIdOf({ kind: "room", roomId: r.id }));
  }
  return Array.from(out);
}

function currentRuntimeName(memberId: string, initialName: string): string {
  if (!memberId.startsWith("mem_")) return initialName;
  const member = getMember(memberId);
  if (!member) throw new Error(`Member no longer exists: ${memberId}`);
  return member.name;
}

function refreshProfileSources(instance: AgentInstance): void {
  if (!instance.profilePromptDirty) return;
  const member = getMember(instance.memberId);
  if (!member) throw new Error(`Member no longer exists: ${instance.memberId}`);
  const ref = parseScopeId(instance.scopeId);
  const parentId = ref?.kind === "room" ? ref.roomId : undefined;
  const room = parentId ? roomStore.getRoom(parentId) : null;
  // ① batch 2: one prompt per member — the compiler takes no scope.
  const compiled = compileForMember(member.id);
  instance.agentName = member.name;
  instance.sessionSources.member.name = member.name;
  instance.sessionSources.member.title = member.title;
  instance.sessionSources.compiled = compiled;
  instance.sessionSources.roomMembers = room ? roomStore.getRoomMembers(room.id).map(m => m.name) : [member.name];
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
        scopeById = new Map(all.filter(m=>!isSystemNoticeHiddenFromMembers(m)).map((m) => [m.id, m]));
      } catch {
        scopeById = new Map();
      }
    }
    return scopeById.get(ref.messageId);
  };

  // Single message → single-message envelope.
  if (items.length === 1) {
    return wrapRoomContextMessage(items[0].msg, { kind: "room", id: roomId, name: roomName }, items[0].role, lookup);
  }

  // Multiple messages → shared transcript envelope (each message keeps its own
  // full sub-header with seq + timestamp so it can be referenced individually).
  return wrapRoomMessagesTranscript(
    items.map((i) => ({ msg: i.msg, role: i.role })),
    { kind: "room", id: roomId, name: roomName },
    lookup,
  );
}

// Only current member configuration selects skills, including an explicit empty list.
export function resolveSkills(member: AgentMemberConfig): string[] {
  return member.skills ?? [];
}

// -- Activation --

type ReplyContext = { needResponse?: string[]; needResponseMemberIds?: string[]; senderName?: string; senderOrigin?: "user"|"member"|"system"|"unresolved" };

function replyObligation(memberId: string, memberName: string, ctx?: ReplyContext) {
  const isUser = ctx?.senderOrigin !== undefined ? ctx.senderOrigin === "user" : ctx?.senderName === "user";
  const listed = ctx?.needResponseMemberIds !== undefined
    ? ctx.needResponseMemberIds.includes(memberId)
    : (ctx?.needResponse || []).some(name => name === memberName || name === memberId);
  const explicitFyi = isUser && Array.isArray(ctx?.needResponse) && ctx.needResponse.length === 0;
  const replyDebt = !explicitFyi && (isUser || !ctx || listed);
  const banner = replyDebt ? (isUser || !ctx
    ? "[REPLY EXPECTED] Respond using the chat tool."
    : `[REPLY EXPECTED] ${ctx.senderName} expects your reply — respond with the chat tool.`) : undefined;
  return { replyDebt, banner };
}

const INTERRUPT_INPUT_BANNER="Your previous turn was interrupted by this message. Commands in terminals keep running. Check terminal_list for running commands and use terminal_wait to collect their results before continuing dependent work.";

function prepareScopeInput(scopeValue:string,memberId:string,ctx?:ReplyContext,capture?:CapturedMessage):{payload:PreparedRuntimeInput;replyExpected:boolean;onAccepted?:()=>void}|null{
  const scope=runtimeInputOwner(scopeValue,memberId).scopeId;
  const rec=getMember(memberId);if(!rec)throw new Error(`Member not found: ${memberId}`);
  const replyExpected=capture
    ?new ReplyObligationRepository(getDatabase()).listPending(scope,memberId).some(x=>x.messageId===capture.messageId)
    :replyObligation(memberId,rec.name,ctx).replyDebt;
  const senderName=capture?.snapshot.origin==="member"?String(capture.snapshot.message.sender):ctx?.senderName;
  const senderIsMember=capture?capture.snapshot.origin==="member":!!ctx&&ctx.senderOrigin!=="user"&&ctx.senderName!=="user";
  const banner=replyExpected?(senderIsMember&&senderName?`[REPLY EXPECTED] ${senderName} expects your reply — respond with the chat tool.`:"[REPLY EXPECTED] Respond using the chat tool."):undefined;
  const captured=capture?.snapshot.message as unknown as RoomMessage|undefined;
  if(scope.startsWith("dm:")){
    const all=readAllDmMessages(memberId).filter(m=>!isSystemNoticeHiddenFromMembers(m));
    // Private messages are delivered to this member immediately; the turn carries only the
    // target message itself. Earlier history stays available through chat_read.
    const target=captured??all.at(-1);
    // ① D1: every delivered message carries its source chat id and sender id;
    // this private chat is `dm:<memberId>`.
    const dmLabel=`dm:${memberId}`;
    const delivered=target?(target.sender==="user"?`[User] ${target.content}`:`[Member \`${target.sender}\`${target.senderMemberId?` (${target.senderMemberId})`:''}] ${target.content}`):undefined;
    let prompt:string;
    if(delivered)prompt=`You are in a private chat with the user (${dmLabel}). New message:\n\n${delivered}${replyExpected?"\n\nRespond to the latest user message with the chat tool.":""}`;
    else if(isBlankPersona(readMemberProfile(memberId)))prompt=`You are in a private chat with the user (${dmLabel}). You just came online with a blank persona (your persona.md body is empty). Your first action must be a chat call: introduce yourself by name in one short line, say you are starting from a blank slate, and ask what they want you around for. Do not call other tools first. After they answer, write what you learned in persona.md as free-form Markdown. No frontmatter or particular headings are required.`;
    else prompt=`You are in a private chat with the user (${dmLabel}). They just opened the conversation. Greet briefly with the chat tool, or wait for their request.`;
    return {payload:{prompt:[banner,prompt].filter(Boolean).join("\n\n"),source:"private_instruction",trigger:"dm-activate"},replyExpected};
  }
  if(scope.startsWith("mm:")){
    // ⑤ B: member↔member private chat — mirror the DM delivery-only path for the peer.
    const pair=parseMmScopeId(scope);
    if(!pair||!pair.includes(memberId))throw new Error(`Member chat scope does not include member ${memberId}`);
    const otherId=pair.find(id=>id!==memberId)!;
    const otherName=getMember(otherId)?.name??otherId;
    const all=loadScopeMessages(scope).filter(m=>!isSystemNoticeHiddenFromMembers(m));
    const target=captured??all.at(-1);
    const delivered=target?`[Member \`${target.sender}\`${target.senderMemberId?` (${target.senderMemberId})`:''}] ${target.content}`:undefined;
    let prompt:string;
    if(delivered)prompt=`You are in a private chat with member \`${otherName}\` (${scope}). New message:\n\n${delivered}${replyExpected?"\n\nRespond to the latest message with the chat tool.":""}`;
    else prompt=`You are in a private chat with member \`${otherName}\` (${scope}). They just opened it — reply with the chat tool, or wait for their next message.`;
    return {payload:{prompt:[banner,prompt].filter(Boolean).join("\n\n"),source:"private_instruction",trigger:"mm-activate"},replyExpected};
  }
  const parent=scope;
  const room=roomStore.getRoom(parent);if(!room)throw new Error("Room not found");
  const member=resolveRoomMember(parent,memberId);if(!member)throw new Error("Member is not in the room");
  const cursor=roomStore.getCursors(parent)[memberId];
  const all=getMessagesSince(parent,cursor??null);
  const visible=filterAgentVisibleMessages(all,rec.name);
  const index=lastMentionTriggerIndex(visible,rec.name,memberId);
  const trigger=captured??visible[index>=0?index:visible.length-1];
  if(!trigger)return null;
  let formatted=trigger?formatMessagesForAgent(scope,[trigger],rec.name,room.name):"";
  if(trigger){
    const backlog=visible.filter(m=>m.id!==trigger.id&&(m.seq??0)<(trigger.seq??Number.MAX_SAFE_INTEGER)&&!isOwnMessage(m,memberId,rec.name));
    const limit=(member as any).contextLimit||50;
    const hint=buildUnreadBacklogHint(backlog.slice(-limit),backlog.length>limit?{total:backlog.length,fromSeq:(backlog[0].seq??1)-1}:undefined);
    if(hint)formatted=`${hint}\n\n${formatted}`;
  }
  return {payload:{prompt:[banner,formatted].filter(Boolean).join("\n\n"),source:"room_mention",trigger:"activate"},replyExpected,onAccepted:()=>{
    if(trigger?.id){
      const current=roomStore.getCursors(parent)[memberId];
      const currentMessage=current?loadScopeMessages(scope).find(m=>m.id===current):undefined;
      if(!currentMessage||(currentMessage.seq??0)<=(trigger.seq??Number.MAX_SAFE_INTEGER)){
        roomStore.setCursor(parent,memberId,trigger.id);
      }
    }
  }};
}

/** Admission is synchronous. The outbox may acknowledge only after this returns. */
function admitCapturedActivation(scopeValue:string,memberId:string,ctx:MentionActivationCtx):void{
  const scope=runtimeInputOwner(scopeValue,memberId).scopeId;
  const active=instances.get(instanceKey(memberId));
  const busy=!!active&&(active.status==="working"||active.dispatchState!=="idle");
  const target=ctx.capture.snapshot.targets[ctx.deliveryKind].find(actor=>actor.actorKey===memberId);
  const scopeAllowed=memberHasScopeAccess(scope,memberId);
  const unavailable=target?.memberId!==memberId||!scopeAllowed||!memberRuntimeAllowed(memberId)||!getMember(memberId);
  // ① B3: @everyone reaches everyone — a busy member is interrupted and
  // re-delivered just like any other message, never skipped.
  const skipped=unavailable;
  let prepared:ReturnType<typeof prepareScopeInput>;
  const receipt=acceptRuntimeInput(ctx.capture,{scopeId:scope,messageId:ctx.capture.messageId,targetActorKey:memberId,deliveryKind:ctx.deliveryKind},()=>{
    if(skipped)return {prompt:"",source:"system",trigger:"not-dispatched"};
    prepared=prepareScopeInput(scope,memberId,ctx,ctx.capture);
    if(!prepared)throw new Error("Captured message has no executable input");
    const payload={...prepared.payload};
    if(busy&&!active!.compacting)payload.prompt=`${INTERRUPT_INPUT_BANNER}\n\n${payload.prompt}`;
    return payload;
  },{placement:(busy&&!active?.compacting)?"front":"tail",onAccepted:()=>prepared?.onAccepted?.(),...(skipped?{skip:{diagnosis:"member unavailable",disposition:"cancelled" as ReplyDisposition}}:{})});
  if(receipt.input.status!=="pending"){
    return;
  }
  if(receipt.accepted&&busy&&!active!.compacting){
    interruptAcceptedInput(scope,active!,"message_interrupt");
  }
  void pumpRuntimeInputs(scope,memberId).catch(error=>logger.error("router","accepted input execution failed",{scopeId:scope,memberId,error:String(error)}));
}

async function activateControl(scope:string,memberId:string,ctx?:ReplyContext):Promise<void>{
  if(!memberRuntimeAllowed(memberId))return;
  const prepared=prepareScopeInput(scope,memberId,ctx);
  if(!prepared){
    await buildMemberAgentSession(memberId,(scope.startsWith("dm:")||isMmScopeId(scope)?scope:roomScopeId(scope)) as ScopeId);
    return;
  }
  const active=instances.get(instanceKey(memberId));
  const busy=!!active&&(active.status==="working"||active.dispatchState!=="idle");
  if(busy&&!active!.compacting)prepared.payload.prompt=`${INTERRUPT_INPUT_BANNER}\n\n${prepared.payload.prompt}`;
  const {input}=acceptControlInput(scope,memberId,prepared.payload,prepared.replyExpected,busy?"front":"tail",prepared.onAccepted);
  if(busy&&!active!.compacting)interruptAcceptedInput(scope,active!,"message_interrupt");
  const running=pumpRuntimeInputs(scope,memberId);
  if(!busy&&!active?.compacting)await waitForInputSettlement(input,running);else void running.catch(error=>logger.error("agent","control input failed",{memberId,error:String(error)}));
}
export async function activateAgent(roomId:string,memberRef:string,ctx?:ReplyContext):Promise<void>{
  const member=resolveRoomMember(roomId,memberRef);if(!member)return;
  return activateControl(roomId,member.id,ctx);
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

/** Persist a config patch for a room member (resolves ref → member id, routes by authority). */
export function persistRoomMemberConfigPatch(roomId: string, memberRef: string, patch: RoomMemberConfigPatch): void {
  const member = resolveRoomMember(roomId, memberRef);
  const memberId = member?.id || memberRef;
  persistConfigPatch(roomId, memberId, patch);
}

// -- Status --

/** Read-only live-instance lookup by scope (batch 6 reload surface + tests). */
export function getAgentInstanceForScope(scopeId: string, memberId: string): AgentInstance | null {
  const instance = instances.get(instanceKey(memberId)) ?? null;
  if (instance?.profilePromptDirty) refreshProfileSources(instance);
  return instance;
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

export function broadcastMemberStatus(roomId: string, memberRef: string): void {
  const member = resolveRoomMember(roomId, memberRef);
  if (!member) return;
  const key = instanceKey(member.id);
  const instance = instances.get(key);
  const status = instance?.status ?? "inactive";
  broadcastToRoom(roomId, {
    type: "agent:status",
    roomId,
    agent: member.name,
    ...memberIdentityMeta(member.name, member.id),
    status,
  });
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

export const refreshContextUsageOnIdle = refreshContextUsage;

// -- Event history --

export function getAgentEventHistory(roomId: string, memberRef: string): AgentHistoryEvent[] {
  const member = resolveRoomMember(roomId, memberRef);
  return loadEventsFromDisk(roomId, member?.id || memberRef);
}

function emitAgentLocalEvent(
  roomId: string,
  memberRef: string,
  event: AgentHistoryEvent,
  identity?: { memberId: string; agentName: string },
): void {
  const scopedMember = roomId.startsWith("dm:") ? getMember(memberRef) : null;
  const member = identity ? undefined : scopedMember ?? roomStore.resolveRoomMemberRef(roomId, memberRef);
  // Prefer live instance identity, then the global member record for DM.
  const keyHint = instanceKey(member?.id || memberRef);
  const instance = instances.get(keyHint)
    || [...instances.values()].find((inst) => inst.roomId === roomId && (inst.memberId === memberRef || inst.agentName === memberRef));
  const memberId = identity?.memberId || member?.id || instance?.memberId || memberRef;
  const agentName = identity?.agentName || member?.name || instance?.agentName || memberRef;
  // Use the same authoritative, commit-safe event/outbox path as SDK events.
  // Failed persistence is not a successful activity notification.
  processEvent(roomId,agentName,keyHint,event as AgentStreamEvent,instance?.eventBuffer ?? [],memberId);

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
      const roomId = instance.roomId;
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

export function resetAgentSession(roomId: string, memberRef: string): { ok: true; message: string } {
  const scopeId = roomId.startsWith("dm:") ? roomId : `room:${roomId}`;
  const ref = parseScopeId(scopeId);
  const resolved = ref?.kind === "room" ? resolveRoomMember(ref.roomId, memberRef) : undefined;
  const memberId = resolved?.id || memberRef;
  const key = instanceKey(memberId);
  const instance = instances.get(key);
  const agentName = resolved?.name || instance?.agentName || memberRecordToConfig(memberId)?.name || memberRef;

  destroyInstance(scopeId, memberId, {preservePending:true});
  const message = "Session reset. Next activation will start fresh.";
  getDatabase().transaction(() => {
    cancelPendingRuntimeInputs(runtimeInputOwner(scopeId,memberId),"session reset");
    sessionStore.clearCurrentSession(memberId);
    clearRuntimeStateEntry(memberId);
    if (ref?.kind === "room") roomStore.setCursor(ref.roomId, memberId, null);
    emitAgentLocalEvent(ref?.kind === "room" ? ref.roomId : scopeId, memberId,
      {type:"system",text:message},{memberId,agentName});
  });
  if (ref) {
    const eventScope = ref.kind === "room" ? ref.roomId : scopeId;
    const statusEvent = { type: "agent:status" as const, roomId: eventScope, agent: agentName, ...memberIdentityMeta(agentName, memberId), status: "inactive" as const };
    if (ref.kind === "dm") broadcastToAgentSubscribers(eventScope, agentName, statusEvent);
    else broadcastToRoom(eventScope, statusEvent);
  }
  return { ok: true, message };
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

/**
 * Activate a member in their DM scope (user message path — no @ required).
 * Builds context from recent DM messages and prompts the runtime.
 */
export async function activateDmMember(memberId:string,ctx?:ReplyContext):Promise<void>{return activateControl(`dm:${memberId}`,memberId,ctx);}

/** Single mention-router wiring for production server + acceptance tests (canonical room:/dm: scopes only). */
export function wireMentionRouter():()=>void{
  return initRouter({mention:admitCapturedActivation});
}

// Conversation routing stays at the application boundary, not in session assembly.
function sessionConversation(member: AgentMemberConfig, activeChat: { scopeId: string }) {
  const memberId = member.id;
  const ref = parseScopeId(activeChat.scopeId);
  const chatTarget = () => chatTargetOf(activeChat.scopeId);
  const memberName = () => currentRuntimeName(memberId, member.name);
  const roomMembers = ref?.kind === "room" ? roomStore.getRoom(ref.roomId)?.members ?? [] : [member.name];
  const callbacks = {
    onChat: async (message: string) => {
      postMessage(chatTarget(), memberName(), message, [], { senderMemberId: memberId });
    },
    onMention: async (targetMember: string, message: string) => {
      const current = parseScopeId(activeChat.scopeId);
      const target = current?.kind === "room" ? roomStore.resolveRoomMemberRef(current.roomId, targetMember) : null;
      postMessage(chatTarget(), memberName(), message, current?.kind === "room" ? [targetMember] : [], {
        senderMemberId: memberId, ...(current?.kind === "room" ? { mentionMemberIds: target ? [target.id] : [] } : {}),
      });
    },
  };
  return { roomMembers, callbacks };
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

export function resolveRoomMembers(roomId: string, memberRefs?: string[]): AgentMemberConfig[] {
  const roomMembers = roomStore.getRoomMembers(roomId);
  if (roomMembers.length > 0) return roomMembers.map(toAgentMemberConfig).filter((m): m is AgentMemberConfig => Boolean(m));
  return (memberRefs || []).map((name) => resolveRoomMember(roomId, name)).filter((m): m is AgentMemberConfig => Boolean(m));
}

import type { WsServerEvent } from "../kernel/types.js";
/** Transport is registered by app/wire, never imported by application use cases. */
export type RuntimeViewSink = (scopeId: string, event: WsServerEvent, memberName?: string) => void;
let runtimeViewSink: RuntimeViewSink | undefined;
export function setRuntimeViewSink(sink: RuntimeViewSink | undefined): void { runtimeViewSink = sink; }
const broadcastToRoom = (scopeId: string, event: WsServerEvent): void => { runtimeViewSink?.(scopeId, event); };
const broadcastToAgentSubscribers = (scopeId: string, name: string, event: WsServerEvent): void => { runtimeViewSink?.(scopeId, event, name); };
export function getRuntimeCapabilities() { return getRegistry()?.getCapabilities() ?? {}; }
