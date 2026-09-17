import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, type Database } from "../data/database.js";
import { getBossmodeDir, memberDir, membersRoot } from "../files/layout.js";
import { syncMemberBirthAssets } from "../member/assets.js";
import { documentContentMeta, insertInitialDocument } from "../member/assets.js";
import { ensureDmScope } from "../chat/conversations.js";
import { getMember, getRetainedMember, insertMemberIdentity, prepareMemberIdentity, normalizeMemberName, validateMemberName, deleteMemberIdentity, type MemberRecord, type CreateMemberInput } from "../member/identity.js";
import { ensureDefaultRegistry, prepareMemberSshCredential, importSshCredential } from "../member/workspaces.js";
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
import { quiesceMember } from "../agent/orchestrator/agent-manager.js";
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
