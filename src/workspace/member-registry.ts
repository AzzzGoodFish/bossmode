/**
 * Global member registry (0.20) — one digital employee per name/id.
 * Storage: authoritative members table in ~/.bossmode/bossmode.db.
 * Contract §2.1 / §6.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb } from "./db/sqlite.js";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "../shared/config.js";
import type { ScopeId } from "../shared/conversation-ref.js";
import { markStaleMounts } from "./runtime-state.js";
import { parseScopeId } from "../shared/conversation-ref.js";
import { writeMemberProfileSkeleton } from "./member-profile.js";
import { ensureDefaultRegistry } from "./workspace-registry.js";
import { ensureMemberSshKeyPair } from "./ssh-keygen.js";

export interface MemberGlobalConfig {
  model?: string | null;
  credentialId?: string | null;
  thinkingLevel?: string | null;
  skills?: string[];
  mcpServers?: string[];
}

/** Diff-only overrides for a scope when unified* is false. Empty object / missing key = inherit global. */
export type MemberScopeOverride = Partial<MemberGlobalConfig>;

export interface MemberRecord {
  id: string;
  name: string;
  title?: string;
  agentTemplate: string;
  /** Default true — scope inherits global model/credential/thinking. */
  unifiedModel: boolean;
  /** Default true — scope inherits global extensions/skills/mcp. */
  unifiedExtensions: boolean;
  global: MemberGlobalConfig;
  /** Keys are ScopeId ("dm:<id>" | "room:<roomId>"). Values are diff-only. */
  scopeOverrides: Record<string, MemberScopeOverride>;
  createdAt: number;
  updatedAt: number;
}

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

function membersRoot(): string {
  return join(getBossmodeDir(), "members");
}

export function memberDir(memberId: string): string {
  return join(membersRoot(), memberId);
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

interface MemberRow {
  id: string; name: string; title: string | null; agent_template: string;
  global_json: string; created_at: number; updated_at: number;
}

function fromRow(row: MemberRow): MemberRecord {
  const global = JSON.parse(row.global_json);
  if (!global || typeof global !== "object" || Array.isArray(global)) throw new Error(`Invalid member configuration: ${row.id}`);
  return { id: row.id, name: row.name, ...(row.title ? { title: row.title } : {}),
    agentTemplate: row.agent_template, global,
    unifiedModel: true, unifiedExtensions: true, scopeOverrides: {},
    createdAt: row.created_at, updatedAt: row.updated_at };
}

function cleanGlobal(global: MemberGlobalConfig): MemberGlobalConfig {
  const { extensions: _retired, ...rest } = global as MemberGlobalConfig & { extensions?: unknown };
  return rest;
}

function translateWriteError(err: unknown, name: string): never {
  if (String(err).includes("UNIQUE constraint failed: members.name_key")) throw new MemberNameTakenError(name);
  throw err;
}

function insertRecord(rec: MemberRecord): void {
  try {
    openDb().run(`INSERT INTO members (id, name, name_key, title, agent_template, global_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, rec.id, rec.name, rec.name.toLowerCase(), rec.title || null,
      rec.agentTemplate, JSON.stringify(cleanGlobal(rec.global)), rec.createdAt, rec.updatedAt);
  } catch (err) { translateWriteError(err, rec.name); }
}

function writeRecord(rec: MemberRecord): void {
  try {
    openDb().run(`UPDATE members SET name = ?, name_key = ?, title = ?, agent_template = ?, global_json = ?,
      created_at = ?, updated_at = ? WHERE id = ?`, rec.name, rec.name.toLowerCase(), rec.title || null,
      rec.agentTemplate, JSON.stringify(cleanGlobal(rec.global)), rec.createdAt, rec.updatedAt, rec.id);
  } catch (err) { translateWriteError(err, rec.name); }
}

/** Strict insert for offline migration. Never overwrites an existing ID or creates persona files. */
export function importMemberRecord(rec: MemberRecord): MemberRecord {
  if (!rec || typeof rec.id !== "string" || !/^mem_[a-zA-Z0-9_-]+$/.test(rec.id) ||
      typeof rec.name !== "string" || rec.name !== normalizeName(rec.name) || !isValidMemberName(rec.name) ||
      typeof rec.agentTemplate !== "string" || !rec.agentTemplate ||
      !rec.global || typeof rec.global !== "object" || Array.isArray(rec.global) ||
      !Number.isSafeInteger(rec.createdAt) || !Number.isSafeInteger(rec.updatedAt) ||
      (rec.title !== undefined && typeof rec.title !== "string")) throw new Error("invalid_member_record");
  insertRecord(rec);
  return getMember(rec.id)!;
}

/** Database only. Files left by old installations are never a live fallback. */
export function listMembers(): MemberRecord[] {
  return openDb().all<MemberRow>("SELECT * FROM members").map(fromRow).sort((a, b) => a.name.localeCompare(b.name));
}

export function getMember(id: string): MemberRecord | null {
  const row = openDb().get<MemberRow>("SELECT * FROM members WHERE id = ?", id);
  return row ? fromRow(row) : null;
}

export function findMemberByName(name: string): MemberRecord | null {
  const key = normalizeName(name).toLowerCase();
  if (!key) return null;
  const row = openDb().get<MemberRow>("SELECT * FROM members WHERE name_key = ?", key);
  return row ? fromRow(row) : null;
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
  ensureMembersRoot();
  const rawName = normalizeName(input.name);
  const name = rawName ? rawName : allocateUniqueMemberName("New Member");
  rejectReservedMemberName(name);
  if (!isValidMemberName(name)) throw new Error("invalid_member_name");
  if (findMemberByName(name)) throw new MemberNameTakenError(name);

  const id = `mem_${randomUUID()}`;
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
  try {
    mkdirSync(join(memberDir(id), "memory"), { recursive: true });
    // Persona contains free Markdown only, without identity frontmatter.
    writeMemberProfileSkeleton(id);
    insertRecord(rec);
  } catch (err) {
    rmSync(memberDir(id), { recursive: true, force: true });
    throw err;
  }
  // Batch 7 P1: birth assets — default workspace registry + ssh key pair.
  try { ensureDefaultRegistry(id); } catch { /* synthesized on read anyway */ }
  try { ensureMemberSshKeyPair(id); } catch { /* surfaces at first ssh use */ }
  return rec;
}

export function updateMemberIdentity(id: string, patch: { name?: string; title?: string | null }): MemberRecord {
  return openDb().transaction(() => {
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
  return openDb().transaction(() => {
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
    markStaleMounts(scopeId, id, mountFieldsChanged);
  }

  return getMember(id)!;
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

/**
 * Fire a member: move directory to backups/fired-<name>-<ts>/ and remove from active tree.
 * Returns archive relative path.
 */
export function fireMember(id: string, opts?: { confirm?: boolean }): { archived: string } {
  if (!opts?.confirm) throw new Error("confirm_required");
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = rec.name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48) || "member";
  const rel = join("backups", `fired-${safeName}-${ts}`);
  const dest = join(getBossmodeDir(), rel);
  mkdirSync(join(getBossmodeDir(), "backups"), { recursive: true });
  const source = memberDir(id);
  if (!existsSync(source)) throw new Error("member_assets_missing");
  // Archive-only export. This is never consulted by the active registry.
  renameSync(source, dest);
  let exported = false;
  try {
    const { unifiedModel: _um, unifiedExtensions: _ue, scopeOverrides: _so, ...metadata } = rec;
    writeFileSync(join(dest, "member.json"), JSON.stringify(metadata, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    exported = true;
    // Persist the identity export and both sides of the rename before the
    // durable DB deletion. A crash must not erase the only identity copy.
    for (const path of [join(dest, "member.json"), dest, dirname(dest), dirname(source), getBossmodeDir()]) {
      const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    openDb().run("DELETE FROM members WHERE id = ?", id);
  } catch (err) {
    // Keep identity active if archive publication/removal did not finish.
    if (exported) rmSync(join(dest, "member.json"));
    renameSync(dest, source);
    throw err;
  }
  return { archived: rel };
}

/** Hard-delete member dir without archive (tests only). */
export function deleteMemberForTests(id: string): void {
  openDb().run("DELETE FROM members WHERE id = ?", id);
  const dir = memberDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
