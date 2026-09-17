// Shared physical paths. Importing this module performs no I/O.
import { join, posix } from "node:path";
import { homedir } from "node:os";

export const installationRoot = join(import.meta.dirname, "../..");

const root = process.env.BOSSMODE_DIR || join(homedir(), ".bossmode");

export function getBossmodeDir(): string {
  return root;
}

export function membersRoot(): string {
  return join(root, "members");
}

export function memberDir(memberId: string): string {
  return join(membersRoot(), memberId);
}

export function memberProfilePath(memberId: string): string {
  return join(memberDir(memberId), "persona.md");
}

export function memberSkillsDir(memberId: string): string {
  return join(memberDir(memberId), "skills");
}

export function memberExtensionsDir(memberId: string): string {
  return join(memberDir(memberId), "extensions");
}

export function memberArchiveDir(memberId: string): string {
  return join(memberDir(memberId), "archive");
}

export function getRoomsDir(): string {
  return join(root, "rooms");
}

export function roomDir(roomId: string): string {
  return join(getRoomsDir(), roomId);
}

/** Member↔member chat data dir; pair order is canonicalized (same dir for both members). */
export function memberChatDir(memberA: string, memberB: string): string {
  const [a, b] = memberA < memberB ? [memberA, memberB] : [memberB, memberA];
  return join(root, "member-chats", `${a}-${b}`);
}

export function documentsRoot(): string {
  return join(root, "memory", "projects");
}

export function knowledgeRoot(): string {
  return join(root, "knowledge");
}

/** One member-owned main session across all chats; preserve the established UTC-day layout. */
export function mainSessionDirectory(memberId: string, startedAt = new Date()): string {
  return join(memberDir(memberId), "sessions", startedAt.toISOString().slice(0, 10), "main");
}

export function validateArchivePath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("backups/") || path === "backups/" ||
    path.includes("\\") || path.includes("\0") || posix.normalize(path) !== path || path.split("/").includes("..")) {
    throw new Error("invalid_archive_path");
  }
}
