import { getDatabase, type Database } from "../data/database.js";
import { memberDir } from "../files/layout.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

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
  const saved = readWorkspaceRegistry(memberId);
  if (!saved) return { active: "original", workspaces: [originalWorkspace(memberId)] };
  const workspaces = [originalWorkspace(memberId), ...saved.workspaces.filter(w => w.id !== "original")];
  return { active: workspaces.some(w => w.id === saved.active) ? saved.active : "original", workspaces };
}

function writeWorkspaces(memberId: string, registry: WorkspaceRegistry): void {
  importWorkspaceRegistry(memberId, registry);
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
      keyPath: args.keyPath?.trim() || memberSshKeyPath(memberId),
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

/** Where a relative path resolves for a member right now (active workspace root). */
export function activeWorkspaceRoot(memberId: string): string {
  return getActiveWorkspace(memberId).root;
}

/** Default workspace root for fresh members is the member's own folder. */
export function ensureDefaultRegistry(memberId: string): void {
  getDatabase().transaction(() => {
    if (!readWorkspaceRegistry(memberId)) {
      writeWorkspaces(memberId, { active: "original", workspaces: [originalWorkspace(memberId)] });
    }
  });
}

export interface SshCredentialMaterial { privateKey: string; publicKey: string; config?: string }
export function readWorkspaceRegistry(memberId: string, db: Database = getDatabase()): WorkspaceRegistry | null {
  const row = db.get<{ active: string }>("SELECT active FROM workspace_registries WHERE member_id=?", memberId);
  if (!row) return null;
  return { active: row.active, workspaces: db.all<any>("SELECT * FROM workspaces WHERE member_id=? ORDER BY position", memberId).map(w => ({
    id: w.id, kind: w.kind, description: w.description, root: w.root, builtin: w.kind === "original",
    ...(w.kind === "ssh" ? { host: w.host, port: w.port, user: w.user, keyPath: w.key_path } : {}),
  } as WorkspaceEntry)) };
}
export function importWorkspaceRegistry(memberId: string, registry: WorkspaceRegistry, db: Database = getDatabase()): void {
  if (!registry.workspaces.some(w => w.id === registry.active)) throw new Error("Active workspace is missing");
  db.transaction(tx => {
    tx.run("INSERT INTO workspace_registries VALUES (?,?) ON CONFLICT(member_id) DO UPDATE SET active=excluded.active", memberId, registry.active);
    tx.run("DELETE FROM workspaces WHERE member_id=?", memberId);
    registry.workspaces.forEach((w, i) => tx.run("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?,?)", memberId, w.id, i, w.kind, w.description, w.root,
      w.kind === "ssh" ? w.host : null, w.kind === "ssh" ? w.port : null, w.kind === "ssh" ? w.user : null, w.kind === "ssh" ? w.keyPath : null));
  });
}
export function readSshCredential(memberId: string, db: Database = getDatabase()): SshCredentialMaterial | null {
  const row = db.get<any>("SELECT * FROM ssh_credentials WHERE member_id=?", memberId);
  return row ? { privateKey: row.private_key, publicKey: row.public_key, ...(row.config === null ? {} : { config: row.config }) } : null;
}
export function importSshCredential(memberId: string, material: SshCredentialMaterial, db: Database = getDatabase()): void {
  if (!material.privateKey.trim() || !material.publicKey.trim()) throw new Error("Incomplete SSH credential");
  db.run("INSERT OR REPLACE INTO ssh_credentials VALUES (?,?,?,?)", memberId, material.privateKey, material.publicKey, material.config ?? null);
}
export function prepareMemberSshCredential(memberId: string): SshCredentialMaterial;
export function prepareMemberSshCredential(memberId: string, optional: true): SshCredentialMaterial | null;
export function prepareMemberSshCredential(memberId: string, optional = false): SshCredentialMaterial | null {
  const dir = mkdtempSync(join(tmpdir(), "bossmode-member-key-"));
  try {
    const key = join(dir, "id_ed25519");
    try { execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "bossmode-member-" + memberId, "-f", key], { stdio: "ignore" }); }
    catch (error) { if (optional) return null; throw error; }
    return { privateKey: readFileSync(key, "utf8"), publicKey: readFileSync(key + ".pub", "utf8").trim() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function memberSshKeyPath(memberId: string): string { return join(memberDir(memberId), "ssh", "id_ed25519"); }

export function readMemberSshPublicKey(memberId: string): string | null { return readSshCredential(memberId)?.publicKey.trim() ?? null; }

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
