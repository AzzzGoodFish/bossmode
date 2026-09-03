/**
 * Batch 7 P1 (spec-batch7-workspace-shell-impl-v1 §1-§2): member workspace
 * registry. Two kinds — original (whole local machine, builtin, cannot be
 * removed) and ssh (remote machine + root). The active pointer decides where
 * relative paths in file tools resolve and where sessions run.
 *
 * Storage: members/<id>/workspaces.json. Presence of a file with a non-empty
 * workspaces list is the source of truth; original is synthesized when absent
 * so a member always has a valid workspace even before the file exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { memberDir } from "./member-profile.js";

export interface OriginalWorkspace {
  id: string;
  kind: "original";
  description: string;
  root: string;
  builtin: true;
}

export interface SshWorkspace {
  id: string;
  kind: "ssh";
  description: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  root: string;
  builtin?: false;
}

export type WorkspaceEntry = OriginalWorkspace | SshWorkspace;

export interface WorkspaceRegistry {
  active: string;
  workspaces: WorkspaceEntry[];
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function workspacesJsonPath(memberId: string): string {
  return join(memberDir(memberId), "workspaces.json");
}

export function originalWorkspace(memberId: string): OriginalWorkspace {
  return {
    id: "original",
    kind: "original",
    description: "This machine — unrestricted",
    root: memberDir(memberId),
    builtin: true,
  };
}

export function readWorkspaces(memberId: string): WorkspaceRegistry {
  const path = workspacesJsonPath(memberId);
  if (!existsSync(path)) {
    return { active: "original", workspaces: [originalWorkspace(memberId)] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<WorkspaceRegistry>;
    const workspaces = Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0
      ? parsed.workspaces
      : [originalWorkspace(memberId)];
    // original is always present and always synthesized from the member dir
    // (member folder moves should not leave a stale root on disk).
    const merged = [
      originalWorkspace(memberId),
      ...workspaces.filter((w) => w && (w as WorkspaceEntry).id !== "original"),
    ];
    const active = typeof parsed.active === "string" && merged.some((w) => w.id === parsed.active)
      ? parsed.active
      : "original";
    return { active, workspaces: merged };
  } catch {
    return { active: "original", workspaces: [originalWorkspace(memberId)] };
  }
}

function writeWorkspaces(memberId: string, registry: WorkspaceRegistry): void {
  mkdirSync(memberDir(memberId), { recursive: true });
  const path = workspacesJsonPath(memberId);
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

export function listWorkspaces(memberId: string): WorkspaceRegistry {
  return readWorkspaces(memberId);
}

export function getActiveWorkspace(memberId: string): WorkspaceEntry {
  const reg = readWorkspaces(memberId);
  return reg.workspaces.find((w) => w.id === reg.active) ?? reg.workspaces[0];
}

export function getWorkspace(memberId: string, id: string): WorkspaceEntry | null {
  return readWorkspaces(memberId).workspaces.find((w) => w.id === id) ?? null;
}

export interface CreateWorkspaceArgs {
  id: string;
  kind: "ssh";
  description?: string;
  host: string;
  port?: number;
  user: string;
  keyPath?: string;
  root?: string;
}

export type CreateWorkspaceResult =
  | { ok: true; workspace: SshWorkspace }
  | { ok: false; error: string };

export function createWorkspace(memberId: string, args: CreateWorkspaceArgs): CreateWorkspaceResult {
  if (!ID_RE.test(args.id)) {
    return { ok: false, error: `Invalid workspace id "${args.id}" — use letters, digits, dot, dash or underscore (max 64 chars), starting with a letter or digit.` };
  }
  if (args.id === "original") {
    return { ok: false, error: "original is the builtin workspace id and cannot be reused." };
  }
  if (args.kind !== "ssh") {
    return { ok: false, error: `Unsupported workspace kind: ${args.kind}. Use "ssh" (or the builtin "original").` };
  }
  if (!args.host || !args.user) {
    return { ok: false, error: "host and user are required for an ssh workspace." };
  }
  const reg = readWorkspaces(memberId);
  if (reg.workspaces.some((w) => w.id === args.id)) {
    return { ok: false, error: `Workspace id already exists: ${args.id}` };
  }
  const workspace: SshWorkspace = {
    id: args.id,
    kind: "ssh",
    description: args.description?.trim() || `ssh ${args.user}@${args.host}`,
    host: args.host,
    port: args.port && args.port > 0 ? args.port : 22,
    user: args.user,
    keyPath: args.keyPath?.trim() || join(memberDir(memberId), "ssh", "id_ed25519"),
    root: args.root?.trim() || ".",
    builtin: false,
  };
  const next = { active: reg.active, workspaces: [...reg.workspaces, workspace] };
  writeWorkspaces(memberId, next);
  return { ok: true, workspace };
}

export type RemoveWorkspaceResult = { ok: true } | { ok: false; error: string };

export function removeWorkspace(memberId: string, id: string): RemoveWorkspaceResult {
  if (id === "original") {
    return { ok: false, error: "The builtin original workspace cannot be removed." };
  }
  const reg = readWorkspaces(memberId);
  const exists = reg.workspaces.some((w) => w.id === id);
  if (!exists) {
    return { ok: false, error: `Workspace not found: ${id}` };
  }
  const workspaces = reg.workspaces.filter((w) => w.id !== id);
  const active = reg.active === id ? "original" : reg.active;
  writeWorkspaces(memberId, { active, workspaces });
  return { ok: true };
}

export function useWorkspace(memberId: string, id: string): { ok: true; active: string; workspace: WorkspaceEntry } | { ok: false; error: string } {
  const reg = readWorkspaces(memberId);
  const target = reg.workspaces.find((w) => w.id === id);
  if (!target) {
    return { ok: false, error: `Workspace not found: ${id}. Use workspace_list to see what exists.` };
  }
  writeWorkspaces(memberId, { active: id, workspaces: reg.workspaces });
  return { ok: true, active: id, workspace: target };
}

/** Ssh connectivity check (P2 shells use the live connection; P1 validates
 * on creation via a probe in shell-manager once it exists — the registry
 * itself stays dependency-free). */
export function sshWorkspaceSummary(w: SshWorkspace): SshWorkspace {
  return { ...w };
}

/** Where a relative path resolves for a member right now (active workspace root). */
export function activeWorkspaceRoot(memberId: string): string {
  return getActiveWorkspace(memberId).root;
}

export function workspaceRootOf(w: WorkspaceEntry): string {
  return w.root;
}

/** Default workspace root for fresh members is the member's own folder. */
export function ensureDefaultRegistry(memberId: string): void {
  if (!existsSync(workspacesJsonPath(memberId))) {
    writeWorkspaces(memberId, { active: "original", workspaces: [originalWorkspace(memberId)] });
  }
}
