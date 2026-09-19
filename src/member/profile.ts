import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { memberDir, memberProfilePath, memberSkillsDir } from "../files/layout.js";
import { getDatabase } from "../data/database.js";
import { logger } from "../kernel/logger.js";
import { getMember, updateMember, MemberNotFoundError } from "./identity.js";
export const MEMBER_PROFILE_BUDGET_CHARS = 4000;
export interface MemberProfile {
  /** Literal Markdown, with no metadata parsing or required headings. Empty at birth. */
  body: string;
  /** Raw file text (for diagnostics). */
  raw: string;
  path: string;
  exists: boolean;
  overBudget: boolean;
}
/** Birth creates an empty persona and its skills directory. */
export function writeMemberProfileSkeleton(memberId: string): string {
  getDatabase().assertOutsideTransaction();
  mkdirSync(memberDir(memberId), { recursive: true });
  mkdirSync(memberSkillsDir(memberId), { recursive: true });
  const path = memberProfilePath(memberId);
  if (!existsSync(path)) writeFileSync(path, "", "utf-8");
  return path;
}
export function readMemberProfile(memberId: string): MemberProfile {
  getDatabase().assertOutsideTransaction();
  const path = memberProfilePath(memberId);
  let raw: string;
  try { raw = readFileSync(path, "utf-8"); }
  catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    return { body: "", raw: "", path, exists: false, overBudget: false };
  }
  const overBudget = raw.length > MEMBER_PROFILE_BUDGET_CHARS;
  if (overBudget) {
    logger.warn("member-profile", "persona.md over budget", {
      memberId, chars: raw.length, budget: MEMBER_PROFILE_BUDGET_CHARS,
    });
  }
  return { body: raw, raw, path, exists: true, overBudget };
}
/** Identity is supplied by the registry, never parsed from persona text. */
export function isBlankPersona(profile: MemberProfile): boolean {
  return !profile.body.trim();
}
export class InvalidProfileError extends Error {
  readonly code = "invalid_profile";
}
/** Validate before committing either field. The API adapter may convert title=null to "". */
export function validateProfilePatch(input: unknown): { name?: string; title?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidProfileError("Expected name and/or title.");
  const patch = input as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length) throw new InvalidProfileError("Provide at least one of name or title.");
  for (const key of keys) {
    if (key !== "name" && key !== "title") throw new InvalidProfileError(`Unknown profile field: ${key}. Only name and title are editable.`);
    if (typeof patch[key] !== "string") throw new InvalidProfileError(`${key} must be a string.`);
  }
  return patch as { name?: string; title?: string };
}

/** One committed identity update, shared by the self-only tool and global API. */
export function updateProfileForMember(memberId: string, input: unknown) {
  const patch = validateProfilePatch(input);
  const before = getMember(memberId);
  if (!before) throw new MemberNotFoundError(memberId);
  let member;
  try { member = updateMember(memberId, patch); }
  catch (error) {
    if ((error as Error).message === "reserved_member_name") throw new InvalidProfileError("all, user and system are reserved for group mentions, the human user and system messages.");
    if ((error as Error).message === "invalid_member_name") {
      throw new InvalidProfileError("Name must be non-empty, at most 64 characters, and contain no slash or NUL.");
    }
    throw error;
  }
  const changed=member.name!==before.name||member.title!==before.title;
  return {memberId,name:member.name,title:member.title??null,changed};
}
