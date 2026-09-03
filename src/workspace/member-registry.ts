/**
 * Global member registry (0.20) — one digital employee per name/id.
 * Storage: ~/.bossmode/members/mem_<uuid>/member.json (no separate registry.json).
 * Contract §2.1 / §6.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  extensions?: string[];
  mcpServers?: string[];
}

/** Diff-only overrides for a scope when unified* is false. Empty object / missing key = inherit global. */
export type MemberScopeOverride = Partial<MemberGlobalConfig>;

export interface MemberRecord {
  id: string;
  name: string;
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
  extensions?: string[];
  mcpServers?: string[];
  unifiedModel?: boolean;
  unifiedExtensions?: boolean;
  /** Optional frontmatter seed (identity title). */
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

function memberJsonPath(memberId: string): string {
  return join(memberDir(memberId), "member.json");
}

function ensureMembersRoot(): void {
  const root = membersRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

function normalizeName(name: string | undefined | null): string {
  return String(name ?? "").trim();
}

function isValidMemberName(name: string): boolean {
  // Display name: non-empty, no path separators, reasonable length.
  if (!name || name.length > 64) return false;
  if (/[/\0]/.test(name)) return false;
  return true;
}

function readRecordRaw(memberId: string): MemberRecord | null {
  const p = memberJsonPath(memberId);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as MemberRecord;
    if (!raw?.id || !raw?.name) return null;
    return {
      ...raw,
      // Batch-5b: unified flags retired — config is always global. Legacy disk
      // values are ignored; the next write persists the normalized shape.
      unifiedModel: true,
      unifiedExtensions: true,
      global: raw.global || {},
      scopeOverrides: {},
    };
  } catch {
    return null;
  }
}

function writeRecord(rec: MemberRecord): void {
  const dir = memberDir(rec.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.member.json.${process.pid}.tmp`);
  // Batch-5b peel: legacy unified flags + scope overrides never reach disk
  // again — any write strips them from an existing record.
  const { unifiedModel: _um, unifiedExtensions: _ue, scopeOverrides: _so, ...onDisk } = rec;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2) + "\n", "utf-8");
  renameSync(tmp, memberJsonPath(rec.id));
}

/** List all member records (scan directory — no registry.json dual source). */
export function listMembers(): MemberRecord[] {
  ensureMembersRoot();
  const root = membersRoot();
  const out: MemberRecord[] = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (!ent.name.startsWith("mem_")) continue;
    const rec = readRecordRaw(ent.name);
    if (rec) out.push(rec);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function getMember(id: string): MemberRecord | null {
  return readRecordRaw(id);
}

export function findMemberByName(name: string): MemberRecord | null {
  const n = normalizeName(name).toLowerCase();
  if (!n) return null;
  for (const m of listMembers()) {
    if (m.name.toLowerCase() === n) return m;
  }
  return null;
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
  if (!isValidMemberName(name)) throw new Error("invalid_member_name");
  if (findMemberByName(name)) throw new MemberNameTakenError(name);

  const id = `mem_${randomUUID()}`;
  const now = Date.now();
  const rec: MemberRecord = {
    id,
    name,
    agentTemplate: input.agentTemplate || "general",
    unifiedModel: true,
    unifiedExtensions: true,
    global: {
      model: input.model ?? null,
      credentialId: input.credentialId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      skills: input.skills ?? [],
      extensions: input.extensions ?? [],
      mcpServers: input.mcpServers ?? [],
    },
    scopeOverrides: {},
    createdAt: now,
    updatedAt: now,
  };
  writeRecord(rec);
  // Legacy memory skeleton (batch 3 migrates; batch 1 still allows old readers).
  mkdirSync(join(memberDir(id), "memory"), { recursive: true });
  // Birth skeleton: member.md frontmatter + empty body; skills/ + shared memory dirs.
  writeMemberProfileSkeleton(id, {
    name,
    title: (input as { title?: string }).title,
  });
  // Batch 7 P1: birth assets — default workspace registry + ssh key pair.
  try { ensureDefaultRegistry(id); } catch { /* synthesized on read anyway */ }
  try { ensureMemberSshKeyPair(id); } catch { /* surfaces at first ssh use */ }
  return rec;
}

export function renameMember(id: string, newName: string): MemberRecord {
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  const name = normalizeName(newName);
  if (!isValidMemberName(name)) throw new Error("invalid_member_name");
  const clash = findMemberByName(name);
  if (clash && clash.id !== id) throw new MemberNameTakenError(name);
  rec.name = name;
  rec.updatedAt = Date.now();
  writeRecord(rec);
  return rec;
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
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  if (patch.agentTemplate !== undefined) rec.agentTemplate = patch.agentTemplate;
  if (patch.global) {
    rec.global = { ...rec.global, ...patch.global };
  }
  rec.updatedAt = Date.now();
  writeRecord(rec);
  return rec;
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
  for (const key of ["model", "credentialId", "thinkingLevel", "mcpServers", "extensions"] as const) {
    if (key in patch) globalPatch[key] = patch[key];
  }
  for (const key of ["mcpServers", "extensions"] as const) {
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
    extensions: "global" | "scope";
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
  const extensions = { value: g.extensions, source: all };
  const mcpServers = { value: g.mcpServers, source: all };

  return {
    model: model.value ?? null,
    credentialId: credentialId.value ?? null,
    thinkingLevel: thinkingLevel.value ?? null,
    skills: skills.value ?? [],
    extensions: extensions.value ?? [],
    mcpServers: mcpServers.value ?? [],
    sources: {
      model: model.source,
      credentialId: credentialId.source,
      thinkingLevel: thinkingLevel.source,
      skills: skills.source,
      extensions: extensions.source,
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
  renameSync(memberDir(id), dest);
  return { archived: rel };
}

/** Hard-delete member dir without archive (tests only). */
export function deleteMemberForTests(id: string): void {
  const dir = memberDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
