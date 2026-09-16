/**
 * persona.md — literal free-form Markdown. Member identity lives in the database.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { memberDir, memberProfilePath, memberSkillsDir, memberExtensionsDir, memberArchiveDir } from "../files/layout.js";
import { getDatabase } from "../data/database.js";
import { logger } from "../kernel/logger.js";

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
export function formatMemberPromptSegment(profile: MemberProfile, currentName: string, description?: string): string {
  const identity = `# Persona\n\nI am ${currentName}${description ? ` (${description})` : ""}, an AI teammate in Bossmode.`;
  // Match the previous prompt boundary without changing stored Markdown or
  // interpreting any of its content as metadata.
  const body = profile.body.trim();
  return body ? `${identity}\n\n${body}` : identity;
}

export function isBlankPersona(profile: MemberProfile): boolean {
  return !profile.body.trim();
}
