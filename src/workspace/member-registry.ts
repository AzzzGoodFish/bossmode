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
  name: string;
  agentTemplate: string;
  model?: string | null;
  credentialId?: string | null;
  thinkingLevel?: string | null;
  skills?: string[];
  extensions?: string[];
  mcpServers?: string[];
  unifiedModel?: boolean;
  unifiedExtensions?: boolean;
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

function normalizeName(name: string): string {
  return name.trim();
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
      unifiedModel: raw.unifiedModel !== false,
      unifiedExtensions: raw.unifiedExtensions !== false,
      global: raw.global || {},
      scopeOverrides: raw.scopeOverrides || {},
    };
  } catch {
    return null;
  }
}

function writeRecord(rec: MemberRecord): void {
  const dir = memberDir(rec.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.member.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", "utf-8");
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

export function createMember(input: CreateMemberInput): MemberRecord {
  ensureMembersRoot();
  const name = normalizeName(input.name);
  if (!isValidMemberName(name)) throw new Error("invalid_member_name");
  if (findMemberByName(name)) throw new MemberNameTakenError(name);

  const id = `mem_${randomUUID()}`;
  const now = Date.now();
  const rec: MemberRecord = {
    id,
    name,
    agentTemplate: input.agentTemplate || "general",
    unifiedModel: input.unifiedModel !== false,
    unifiedExtensions: input.unifiedExtensions !== false,
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
  // Ensure memory skeleton
  mkdirSync(join(memberDir(id), "memory"), { recursive: true });
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
  patch: Partial<Pick<MemberRecord, "unifiedModel" | "unifiedExtensions" | "agentTemplate">> & {
    global?: Partial<MemberGlobalConfig>;
  },
): MemberRecord {
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  if (patch.unifiedModel !== undefined) rec.unifiedModel = !!patch.unifiedModel;
  if (patch.unifiedExtensions !== undefined) rec.unifiedExtensions = !!patch.unifiedExtensions;
  if (patch.agentTemplate !== undefined) rec.agentTemplate = patch.agentTemplate;
  if (patch.global) {
    rec.global = { ...rec.global, ...patch.global };
  }
  rec.updatedAt = Date.now();
  writeRecord(rec);
  return rec;
}

/**
 * Patch scope override (diff-only). Pass null for a field to clear that override
 * (fall back to global). Empty override object is removed from the map.
 */
export function patchScopeOverride(
  id: string,
  scopeId: ScopeId,
  diff: MemberScopeOverride | null,
): MemberRecord {
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  if (!parseScopeId(scopeId)) throw new Error("scope_not_found");

  if (diff === null) {
    delete rec.scopeOverrides[scopeId];
  } else {
    const prev = { ...(rec.scopeOverrides[scopeId] || {}) };
    for (const [k, v] of Object.entries(diff) as Array<[keyof MemberGlobalConfig, unknown]>) {
      if (v === null || v === undefined) {
        delete (prev as any)[k];
      } else {
        (prev as any)[k] = v;
      }
    }
    if (Object.keys(prev).length === 0) delete rec.scopeOverrides[scopeId];
    else rec.scopeOverrides[scopeId] = prev;
  }
  rec.updatedAt = Date.now();
  writeRecord(rec);
  return rec;
}

/**
 * Single write authority for member config patches (0.20 unified semantics):
 * model/credentialId/thinkingLevel go global when unifiedModel=true, else this
 * scope's override; mcpServers/extensions go global when unifiedExtensions=true,
 * else scope override (mixed members split across both writes). Null clears a
 * field (global: reset to null; scope: fall back to global). Every API write
 * path — room PATCH, members PATCH, panel model switch — delegates here.
 */
export function applyMemberConfigPatch(
  id: string,
  scopeId: ScopeId,
  patch: Record<string, unknown>,
): MemberRecord {
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  const globalPatch: Record<string, unknown> = {};
  const scopePatch: Record<string, unknown> = {};
  for (const key of ["model", "credentialId", "thinkingLevel"] as const) {
    if (key in patch) (rec.unifiedModel ? globalPatch : scopePatch)[key] = patch[key];
  }
  const mountFieldsChanged: string[] = [];
  for (const key of ["mcpServers", "extensions"] as const) {
    if (key in patch) {
      (rec.unifiedExtensions ? globalPatch : scopePatch)[key] = patch[key];
      mountFieldsChanged.push(key);
    }
  }
  if (Object.keys(globalPatch).length > 0) updateMember(id, { global: globalPatch as Partial<MemberGlobalConfig> });
  if (Object.keys(scopePatch).length > 0) patchScopeOverride(id, scopeId, scopePatch as MemberScopeOverride);

  // Auto-reload prompt (fish 2026-08-07): mount config changed → mark the
  // affected member stale so the UI shows a reload badge.
  // A member's mount config is their own (0.20+): changing A's mounts never
  // affects B. Only mark the member being edited.
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

/** Resolve effective config for a scope — single implementation for UI + runtime. */
export function getEffectiveConfig(id: string, scopeId: ScopeId): EffectiveConfig {
  const rec = getMember(id);
  if (!rec) throw new MemberNotFoundError(id);
  const ov = rec.scopeOverrides[scopeId] || {};
  const g = rec.global;

  const pick = <K extends keyof MemberGlobalConfig>(
    key: K,
    unified: boolean,
  ): { value: MemberGlobalConfig[K]; source: "global" | "scope" } => {
    if (!unified && Object.prototype.hasOwnProperty.call(ov, key) && (ov as any)[key] !== undefined) {
      return { value: (ov as any)[key], source: "scope" };
    }
    return { value: g[key], source: "global" };
  };

  const model = pick("model", rec.unifiedModel);
  const credentialId = pick("credentialId", rec.unifiedModel);
  const thinkingLevel = pick("thinkingLevel", rec.unifiedModel);
  const skills = pick("skills", rec.unifiedExtensions);
  const extensions = pick("extensions", rec.unifiedExtensions);
  const mcpServers = pick("mcpServers", rec.unifiedExtensions);

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
