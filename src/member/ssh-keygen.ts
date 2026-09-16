/** Bossmode-owned SSH material is authoritative only in the credential repository. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { memberDir } from "../files/layout.js";
import { getDatabase } from "../data/database.js";
import { SshCredentialsRepository } from "../data/repositories/workspace-settings.js";
function repository(): SshCredentialsRepository { return new SshCredentialsRepository(getDatabase()); }

/** Legacy/default path references only. These helpers never materialize or read a key. */
export function memberSshDir(memberId: string): string { return join(memberDir(memberId), "ssh"); }
export function memberSshKeyPath(memberId: string): string { return join(memberSshDir(memberId), "id_ed25519"); }
export function memberSshPublicKeyPath(memberId: string): string { return `${memberSshKeyPath(memberId)}.pub`; }
export function memberSshConfigPath(memberId: string): string { return join(memberSshDir(memberId), "config"); }

export function ensureMemberSshKeyPair(memberId: string): string | null {
  const repo = repository();
  const existing = repo.read(memberId);
  if (existing) return existing.publicKey.trim();
  const dir = mkdtempSync(join(tmpdir(), "bossmode-ssh-keygen-"));
  try {
    const path = join(dir,"id_ed25519");
    try {
      execFileSync("ssh-keygen", ["-t","ed25519","-N","","-C",`bossmode-member-${memberId}`,"-f",path], {stdio:"ignore"});
    } catch { return null; }
    const material = {privateKey:readFileSync(path,"utf8"),publicKey:readFileSync(`${path}.pub`,"utf8").trim()};
    repo.importKey(memberId,material);
    return material.publicKey;
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
export function readMemberSshPublicKey(memberId: string): string | null { return repository().read(memberId)?.publicKey.trim() ?? null; }

/** Native SSH adapters use this; explicit external key references stay external. */
export function readWorkspaceSshPrivateKey(memberId: string, keyPath: string): Buffer {
  if (resolve(keyPath) !== resolve(memberSshKeyPath(memberId))) return readFileSync(keyPath);
  const material = repository().read(memberId);
  if (!material) throw new Error("Member SSH credential is missing");
  return Buffer.from(material.privateKey);
}

export interface MaterializedSshCredential { keyPath: string; configPath?: string; dispose(): void }
/** File-only callers must dispose after the SSH process/connection ends. Never read back. */
export function materializeMemberSshCredential(memberId: string): MaterializedSshCredential {
  const material = repository().read(memberId);
  if (!material) throw new Error("Member SSH credential is missing");
  const dir = mkdtempSync(join(tmpdir(),"bossmode-ssh-runtime-"));
  try {
    const keyPath = join(dir,"id_ed25519");
    writeFileSync(keyPath,material.privateKey,{mode:0o600});
    writeFileSync(`${keyPath}.pub`,material.publicKey,{mode:0o600});
    const configPath = material.config === undefined ? undefined : join(dir,"config");
    if (configPath) writeFileSync(configPath,material.config!,{mode:0o600});
    return {keyPath,...(configPath ? {configPath}:{}),dispose:()=>rmSync(dir,{recursive:true,force:true})};
  } catch (error) { rmSync(dir,{recursive:true,force:true}); throw error; }
}
