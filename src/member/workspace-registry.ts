/** Member workspace metadata is authoritative in the bound core database. */
import { getDatabase } from "../data/database.js";
import { WorkspacesRepository } from "../data/repositories/workspace-settings.js";
function repository(): WorkspacesRepository { return new WorkspacesRepository(getDatabase()); }
import { join } from "node:path";
import { memberDir } from "../files/layout.js";
import type { OriginalWorkspace, SshWorkspace, WorkspaceEntry, WorkspaceRegistry } from "../data/types.js";

export type { OriginalWorkspace, SshWorkspace, WorkspaceEntry, WorkspaceRegistry };

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
  const saved = repository().read(memberId);
  if (!saved) return { active: "original", workspaces: [originalWorkspace(memberId)] };
  const workspaces = [originalWorkspace(memberId), ...saved.workspaces.filter(w => w.id !== "original")];
  return { active: workspaces.some(w => w.id === saved.active) ? saved.active : "original", workspaces };
}

function writeWorkspaces(memberId: string, registry: WorkspaceRegistry): void {
  repository().importRegistry(memberId, registry);
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
  return getDatabase().transaction(() => {
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
  });
}

export type RemoveWorkspaceResult = { ok: true } | { ok: false; error: string };

export function removeWorkspace(memberId: string, id: string): RemoveWorkspaceResult {
  if (id === "original") {
    return { ok: false, error: "The builtin original workspace cannot be removed." };
  }
  return getDatabase().transaction(() => {
    const reg = readWorkspaces(memberId);
    const exists = reg.workspaces.some((w) => w.id === id);
    if (!exists) {
      return { ok: false, error: `Workspace not found: ${id}` };
    }
    const workspaces = reg.workspaces.filter((w) => w.id !== id);
    const active = reg.active === id ? "original" : reg.active;
    writeWorkspaces(memberId, { active, workspaces });
    return { ok: true };
  });
}

export function useWorkspace(memberId: string, id: string): { ok: true; active: string; workspace: WorkspaceEntry } | { ok: false; error: string } {
  return getDatabase().transaction(() => {
    const reg = readWorkspaces(memberId);
    const target = reg.workspaces.find((w) => w.id === id);
    if (!target) {
      return { ok: false, error: `Workspace not found: ${id}. Use workspace_list to see what exists.` };
    }
    writeWorkspaces(memberId, { active: id, workspaces: reg.workspaces });
    return { ok: true, active: id, workspace: target };
  });
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
  getDatabase().transaction(() => {
    if (!repository().read(memberId)) {
      writeWorkspaces(memberId, { active: "original", workspaces: [originalWorkspace(memberId)] });
    }
  });
}
