/**
 * Global member registry (0.20) — one digital employee per name/id.
 * Storage: authoritative members table in ~/.bossmode/bossmode.db.
 * Contract §2.1 / §6.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, type Database } from "../data/database.js";
import { MembersRepository } from "../data/repositories/members.js";
import { documentContentMeta, insertInitialDocument } from "../data/repositories/document-repository.js";
import { ConversationsRepository } from "../data/repositories/conversations.js";
import { prepareMemberSshCredential, syncMemberBirthAssets } from "../files/member-birth-assets.js";
import { SshCredentialsRepository } from "../data/repositories/workspace-settings.js";
import { newMemberId } from "../kernel/short-id.js";
import { membersRoot, memberDir } from "../files/layout.js";
import type { ScopeId } from "../chat/conversation-ref.js";
import { markStaleMounts } from "./runtime-state.js";
import { writeMemberProfileSkeleton } from "./profile/member-profile.js";
import { ensureDefaultRegistry } from "./workspaces/workspace-registry.js";
import type { MemberGlobalConfig, MemberScopeOverride, MemberRecord } from "../data/types.js";

export type { MemberGlobalConfig, MemberScopeOverride, MemberRecord };

export interface CreateMemberInput {
  /** Empty/omitted → "New Member" (+ numeric suffix if taken). */
  name?: string;
  agentTemplate?: string;
  model?: string | null;
  credentialId?: string | null;
  thinkingLevel?: string | null;
  skills?: string[];
  mcpServers?: string[];
  unifiedModel?: boolean;
  unifiedExtensions?: boolean;
  /** Optional member title, stored with identity. */
  title?: string;
}

export class MemberNameTakenError extends Error {
  readonly code = "name_taken" as const;
  constructor(name: string) {
    super(`Member name already taken: ${name}`);
    this.name = "MemberNameTakenError";
  }
}

export class MemberNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor(id: string) {
    super(`Member not found: ${id}`);
    this.name = "MemberNotFoundError";
  }
}

function ensureMembersRoot(): void {
  const root = membersRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

function normalizeName(name: string | undefined | null): string {
  return String(name ?? "").trim();
}

function rejectReservedMemberName(name: string): void {
  if (["all", "user", "system"].includes(name.toLowerCase())) {
    throw new Error("reserved_member_name");
  }
}

function isValidMemberName(name: string): boolean {
  // Display name: non-empty, no path separators, reasonable length.
  if (!name || name.length > 64) return false;
  if (/[/\0]/.test(name)) return false;
  return true;
}

function repository(): MembersRepository { return new MembersRepository(getDatabase()); }

function translateWriteError(err: unknown, name: string): never {
  if (String(err).includes("UNIQUE constraint failed: members.name_key")) throw new MemberNameTakenError(name);
  throw err;
}

function insertRecord(rec: MemberRecord): void {
  try {
    getDatabase().transaction(() => {
      repository().insert(rec);
      new ConversationsRepository(getDatabase()).ensureDmScope(rec.id);
    });
  } catch (err) { translateWriteError(err, rec.name); }
}

function writeRecord(rec: MemberRecord): void {
  try { repository().update(rec); }
  catch (err) { translateWriteError(err, rec.name); }
}

/** Strict insert for offline migration. Never overwrites an existing ID or creates persona files. */
export function importMemberRecord(rec: MemberRecord): MemberRecord {
  if (!rec || typeof rec.id !== "string" || !/^mem_[a-zA-Z0-9_-]+$/.test(rec.id) ||
      typeof rec.name !== "string" || rec.name !== normalizeName(rec.name) || !isValidMemberName(rec.name) ||
      typeof rec.agentTemplate !== "string" || !rec.agentTemplate ||
      !rec.global || typeof rec.global !== "object" || Array.isArray(rec.global) ||
      !Number.isSafeInteger(rec.createdAt) || !Number.isSafeInteger(rec.updatedAt) ||
      (rec.title !== undefined && typeof rec.title !== "string")) throw new Error("invalid_member_record");
  rejectReservedMemberName(rec.name);
  insertRecord(rec);
  return getMember(rec.id)!;
}

/** Database only. Files left by old installations are never a live fallback. */
export function listMembers(): MemberRecord[] {
  return repository().list().sort((a, b) => a.name.localeCompare(b.name));
}

/** Narrow display directory; never reads configuration or persona files. */
export function listMemberIdentities(): Array<{id: string; name: string}> {
  return repository().listIdentities();
}

export function getMember(id: string): MemberRecord | null {
  return repository().get(id);
}

export function findMemberByName(name: string): MemberRecord | null {
  const key = normalizeName(name).toLowerCase();
  if (!key) return null;
  return repository().findByNameKey(key);
}

/** Resolve name or id (read paths). */
export function resolveMemberRef(ref: string): MemberRecord | null {
  if (!ref) return null;
  if (ref.startsWith("mem_")) return getMember(ref);
  return findMemberByName(ref);
}

/** Allocate a unique display name starting from `base` ("New Member", "New Member 2", …). */
export function allocateUniqueMemberName(base = "New Member"): string {
  const root = normalizeName(base) || "New Member";
  if (!findMemberByName(root)) return root;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${root} ${i}`;
    if (!findMemberByName(candidate)) return candidate;
  }
  throw new Error("could not allocate unique member name");
}

export function createMember(input: CreateMemberInput): MemberRecord {
  return createMemberWithPersona(input, "");
}

/** All owned assets are prepared before the single identity/document/settings commit. */
export function createMemberWithPersona(input: CreateMemberInput, persona: string,
  prepareMetadata?: (record: MemberRecord) => (db: Database) => void,
): MemberRecord {
  getDatabase().assertOutsideTransaction();
  if (typeof persona !== "string") throw new Error("invalid_member_persona");
  if (prepareMetadata?.constructor.name === "AsyncFunction") throw new Error("member_metadata_preparation_must_be_synchronous");
  ensureMembersRoot();
  const rawName = normalizeName(input.name);
  const name = rawName ? rawName : allocateUniqueMemberName("New Member");
  rejectReservedMemberName(name);
  if (!isValidMemberName(name)) throw new Error("invalid_member_name");
  if (findMemberByName(name)) throw new MemberNameTakenError(name);

  // Batch 5: fresh ids are `mem_<nanoid10>`. Bounded retry on an occupied identity
  // (table row or claimed asset dir); a residual collision still fails loudly at the
  // mkdir claim below — preexisting assets are never overwritten.
  let id = newMemberId();
  for (let attempts = 0; attempts < 10 && (getMember(id) || existsSync(memberDir(id))); attempts++) id = newMemberId();
  const now = Date.now();
  const rec: MemberRecord = {
    id,
    name,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    agentTemplate: input.agentTemplate || "general",
    unifiedModel: true,
    unifiedExtensions: true,
    global: {
      model: input.model ?? null,
      credentialId: input.credentialId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      skills: input.skills ?? [],
      mcpServers: input.mcpServers ?? [],
    },
    scopeOverrides: {},
    createdAt: now,
    updatedAt: now,
  };
  // Claim only this freshly allocated path. Never remove or overwrite preexisting assets.
  mkdirSync(memberDir(id));
  try {
    mkdirSync(join(memberDir(id), "memory"));
    writeMemberProfileSkeleton(id);
    writeFileSync(join(memberDir(id), "persona.md"), persona, "utf8");
    const personaMeta = documentContentMeta(persona);
    const ssh = prepareMemberSshCredential(id);
    const commitMetadata = prepareMetadata?.(rec);
    if (commitMetadata && (typeof commitMetadata !== "function" || commitMetadata.constructor.name === "AsyncFunction")) throw new Error("member_metadata_commit_must_be_synchronous");
    syncMemberBirthAssets(memberDir(id));
    getDatabase().transaction(db => {
      insertRecord(rec);
      insertInitialDocument(db, { path: `members/${id}/persona.md`, layer: "persona", memberId: id }, personaMeta);
      ensureDefaultRegistry(id);
      new SshCredentialsRepository(getDatabase()).importKey(id, ssh);
      if (commitMetadata) getDatabase().transaction(commitMetadata);
    });
  } catch (err) {
    try { rmSync(memberDir(id), { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([err, cleanupError], "Member birth failed and owned-asset cleanup failed"); }
    throw err;
  }
  return rec;
}

export function updateMemberIdentity(id: string, patch: { name?: string; title?: string | null }): MemberRecord {
  return getDatabase().transaction(() => {
    const rec = getMember(id);
    if (!rec) throw new MemberNotFoundError(id);
    const name = patch.name === undefined ? rec.name : normalizeName(patch.name);
    if ((patch.name !== undefined && typeof patch.name !== "string") || !isValidMemberName(name)) throw new Error("invalid_member_name");
    if (patch.title !== undefined && patch.title !== null && typeof patch.title !== "string") throw new Error("invalid_member_title");
    if (patch.name !== undefined) rejectReservedMemberName(name);
    const title = patch.title === undefined ? rec.title : (patch.title?.trim() || undefined);
    if (name === rec.name && title === rec.title) return rec;
    rec.name = name;
    rec.title = title;
    rec.updatedAt = Date.now();
    writeRecord(rec);
    return rec;
  });
}

export function renameMember(id: string, newName: string): MemberRecord {
  return updateMemberIdentity(id, { name: newName });
}

export function updateMember(
  id: string,
  patch: Partial<Pick<MemberRecord, "agentTemplate">> & {
    global?: Partial<MemberGlobalConfig>;
    /** Retired (batch-5b) — sent values are ignored. */
    unifiedModel?: boolean;
    unifiedExtensions?: boolean;
  },
): MemberRecord {
  return getDatabase().transaction(() => {
    const rec = getMember(id);
    if (!rec) throw new MemberNotFoundError(id);
    if (patch.agentTemplate !== undefined) rec.agentTemplate = patch.agentTemplate;
    if (patch.global) {
      rec.global = { ...rec.global, ...patch.global };
    }
    rec.updatedAt = Date.now();
    writeRecord(rec);
    return rec;
  });
}

/** Scope overrides retired (batch-5b): config is always global. Kept as a
 *  no-op for legacy callers; writes nothing, returns the normalized record. */
export function patchScopeOverride(
  id: string,
  _scopeId: ScopeId,
  _diff: MemberScopeOverride | null,
): MemberRecord {
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  return rec;
}

/**
 * Single write authority for member config patches (batch-5b): config is
 * always global — every field writes the member's global config. scopeId is
 * accepted for call-site compatibility and stale bookkeeping only.
 */
export function applyMemberConfigPatch(
  id: string,
  scopeId: ScopeId,
  patch: Record<string, unknown>,
): MemberRecord {
  return getDatabase().transaction(() => {
    const rec = getMember(id);
    if (!rec) throw new MemberNotFoundError(id);
    const globalPatch: Record<string, unknown> = {};
    const mountFieldsChanged: string[] = [];
    for (const key of ["model", "credentialId", "thinkingLevel", "mcpServers"] as const) {
      if (key in patch) globalPatch[key] = patch[key];
    }
    for (const key of ["mcpServers"] as const) {
      if (key in patch) mountFieldsChanged.push(key);
    }
    if (Object.keys(globalPatch).length > 0) updateMember(id, { global: globalPatch as Partial<MemberGlobalConfig> });

    if (mountFieldsChanged.length > 0) {
      markStaleMounts(id, mountFieldsChanged);
    }

    return getMember(id)!;
  });
}

export interface EffectiveConfig extends MemberGlobalConfig {
  sources: {
    model: "global" | "scope";
    credentialId: "global" | "scope";
    thinkingLevel: "global" | "scope";
    skills: "global" | "scope";
    mcpServers: "global" | "scope";
  };
}

/**
 * Resolve effective config (batch-5b): config is always the global one —
 * scopeId is accepted for call-site compatibility and ignored.
 */
export function getEffectiveConfig(id: string, _scopeId: ScopeId): EffectiveConfig {
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  const g = rec.global;
  const all = "global" as const;

  const model = { value: g.model, source: all };
  const credentialId = { value: g.credentialId, source: all };
  const thinkingLevel = { value: g.thinkingLevel, source: all };
  const skills = { value: g.skills, source: all };
  const mcpServers = { value: g.mcpServers, source: all };

  return {
    model: model.value ?? null,
    credentialId: credentialId.value ?? null,
    thinkingLevel: thinkingLevel.value ?? null,
    skills: skills.value ?? [],
    mcpServers: mcpServers.value ?? [],
    sources: {
      model: model.source,
      credentialId: credentialId.source,
      thinkingLevel: thinkingLevel.source,
      skills: skills.source,
      mcpServers: mcpServers.source,
    },
  };
}

/** Hard-delete unreferenced test identities only; FK-protected history is never cascaded. */
export function deleteMemberForTests(id: string): void {
  getDatabase().assertOutsideTransaction();
  repository().delete(id);
  const dir = memberDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
