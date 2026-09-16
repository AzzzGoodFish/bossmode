/** File preparation only; no SQL mutation and no optional/suppressed keygen failures. */
import { syncPath } from "./io.js";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { SshCredentialMaterial } from "../data/repositories/workspace-settings.js";
export function prepareMemberSshCredential(memberId: string): SshCredentialMaterial {
  const dir = mkdtempSync(join(tmpdir(), "bossmode-member-birth-"));
  try {
    const path = join(dir, "id_ed25519");
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `bossmode-member-${memberId}`, "-f", path], { stdio: "ignore" });
    return { privateKey: readFileSync(path, "utf8"), publicKey: readFileSync(`${path}.pub`, "utf8").trim() };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Persist prepared birth assets and directory entries before committing identity metadata. */
export function syncMemberBirthAssets(path: string): void {
  function tree(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("birth_asset_symlink");
    if (stat.isDirectory()) for (const child of readdirSync(path)) tree(join(path, child));
    syncPath(path);
  }
  tree(path);
  syncPath(dirname(path));
  syncPath(dirname(dirname(path)));
}
