import type { Database } from "../database.js";
import type { WorkspaceRegistry, WorkspaceEntry } from "../../member/workspace-registry.js";
export interface SshCredentialMaterial { privateKey: string; publicKey: string; config?: string }
export class WorkspacesRepository {
  constructor(private readonly db: Database) {}
  read(memberId: string): WorkspaceRegistry | null {
    const r=this.db.get<{active:string}>("SELECT active FROM workspace_registries WHERE member_id=?",memberId);
    if (!r) return null;
    return {active:r.active,workspaces:this.db.all<any>("SELECT * FROM workspaces WHERE member_id=? ORDER BY position",memberId).map(w => ({
      id:w.id,kind:w.kind,description:w.description,root:w.root,builtin:w.kind === "original",
      ...(w.kind === "ssh" ? {host:w.host,port:w.port,user:w.user,keyPath:w.key_path} : {}),
    } as WorkspaceEntry))};
  }
  importRegistry(memberId: string, registry: WorkspaceRegistry): void {
    if (!registry.workspaces.some(w => w.id === registry.active)) throw new Error("Active workspace is missing");
    this.db.transaction(tx => {
      tx.run("INSERT INTO workspace_registries VALUES (?,?) ON CONFLICT(member_id) DO UPDATE SET active=excluded.active",memberId,registry.active);
      tx.run("DELETE FROM workspaces WHERE member_id=?",memberId);
      registry.workspaces.forEach((w,i) => tx.run("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?,?,?)",memberId,w.id,i,w.kind,w.description,w.root,
        w.kind === "ssh" ? w.host : null,w.kind === "ssh" ? w.port : null,w.kind === "ssh" ? w.user : null,w.kind === "ssh" ? w.keyPath : null));
    });
  }
}
export class SshCredentialsRepository {
  constructor(private readonly db: Database) {}
  read(memberId: string): SshCredentialMaterial | null {
    const r=this.db.get<any>("SELECT * FROM ssh_credentials WHERE member_id=?",memberId);
    return r ? {privateKey:r.private_key,publicKey:r.public_key,...(r.config === null ? {} : {config:r.config})} : null;
  }
  /** Only importer-selected Bossmode-owned keys; external paths are never read here. */
  importKey(memberId: string, material: SshCredentialMaterial): void {
    if (!material.privateKey.trim() || !material.publicKey.trim()) throw new Error("Incomplete SSH credential");
    this.db.run("INSERT OR REPLACE INTO ssh_credentials VALUES (?,?,?,?)",memberId,material.privateKey,material.publicKey,material.config ?? null);
  }
}
