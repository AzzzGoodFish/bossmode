/** Bossmode file-layout paths — the single authority for members/ and rooms/ paths.
 * Pure joins over the bossmode dir; no IO. */
import { join } from "node:path";
import { getBossmodeDir } from "../config/config.js";

export function membersRoot(): string {
  return join(getBossmodeDir(), "members");
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

/** Batch 6 §1.3: member-owned lightweight extensions. Directory present = loaded. */
export function memberExtensionsDir(memberId: string): string {
  return join(memberDir(memberId), "extensions");
}

export function memberArchiveDir(memberId: string): string {
  return join(memberDir(memberId), "archive");
}

function roomsRoot(): string {
  return join(getBossmodeDir(), "rooms");
}

export function getRoomsDir(): string {
  return roomsRoot();
}

export function roomDir(roomId: string): string {
  return join(roomsRoot(), roomId);
}
