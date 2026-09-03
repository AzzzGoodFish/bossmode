/**
 * Batch 7 P1 (spec §1): member-owned SSH key pair. Generated at birth so the
 * first ssh workspace is never blocked on keygen; also generated on demand
 * if a pre-batch-7 member has none. The private key never enters chat or
 * leaves the member folder (guide skill states the rule; mechanism does not
 * fence — the member owns the asset).
 */
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { memberDir } from "./member-profile.js";

export function memberSshDir(memberId: string): string {
  return join(memberDir(memberId), "ssh");
}

export function memberSshKeyPath(memberId: string): string {
  return join(memberSshDir(memberId), "id_ed25519");
}

export function memberSshPublicKeyPath(memberId: string): string {
  return `${memberSshKeyPath(memberId)}.pub`;
}

export function memberSshConfigPath(memberId: string): string {
  return join(memberSshDir(memberId), "config");
}

/** Ensure the member key pair exists. Returns the public key text (or null on
 * failure — ssh workspaces surface the error at use time, not at birth). */
export function ensureMemberSshKeyPair(memberId: string): string | null {
  const keyPath = memberSshKeyPath(memberId);
  const pubPath = memberSshPublicKeyPath(memberId);
  if (existsSync(keyPath) && existsSync(pubPath)) {
    try {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      return readFileSync(pubPath, "utf-8").trim();
    } catch {
      return null;
    }
  }
  try {
    mkdirSync(memberSshDir(memberId), { recursive: true });
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `bossmode-member-${memberId}`, "-f", keyPath], { stdio: "ignore" });
    try { chmodSync(keyPath, 0o600); } catch { /* best effort */ }
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(pubPath, "utf-8").trim();
  } catch {
    return null;
  }
}

/** The public key for the assets API / UI display. Null when not generated. */
export function readMemberSshPublicKey(memberId: string): string | null {
  try {
    if (!existsSync(memberSshPublicKeyPath(memberId))) return null;
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    return readFileSync(memberSshPublicKeyPath(memberId), "utf-8").trim();
  } catch {
    return null;
  }
}
