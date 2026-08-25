/**
 * member.md — frontmatter (name/title/description) + free body (persona).
 * Spec: docs/bossmode/architecture/spec-member-identity-three-memory-impl-v1.md
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { asString, parseFrontmatter } from "../shared/frontmatter.js";
import { logger } from "../foundation/logger.js";

function memberDir(memberId: string): string {
  return join(getBossmodeDir(), "members", memberId);
}

export const MEMBER_PROFILE_BUDGET_CHARS = 4000;

export interface MemberProfileFrontmatter {
  name: string;
  title?: string;
  description?: string;
}

export interface MemberProfile {
  frontmatter: MemberProfileFrontmatter;
  /** Free body after frontmatter (persona). Empty at birth. */
  body: string;
  /** Raw file text (for diagnostics). */
  raw: string;
  path: string;
  exists: boolean;
  overBudget: boolean;
}

export function memberProfilePath(memberId: string): string {
  return join(memberDir(memberId), "member.md");
}

export function memberSkillsDir(memberId: string): string {
  return join(memberDir(memberId), "skills");
}

export function memberArchiveDir(memberId: string): string {
  return join(memberDir(memberId), "archive");
}

export function sharedUserMemoryDir(): string {
  return join(getBossmodeDir(), "memory", "user");
}

export function sharedProjectsMemoryDir(): string {
  return join(getBossmodeDir(), "memory", "projects");
}

/** Ensure shared memory roots exist (idempotent). */
export function ensureSharedMemoryDirs(): void {
  mkdirSync(sharedUserMemoryDir(), { recursive: true });
  mkdirSync(sharedProjectsMemoryDir(), { recursive: true });
}

/**
 * Birth skeleton: frontmatter name only, empty body.
 * Spec 1.3:
 * ---
 * name: New Member
 * ---
 */
export function writeMemberProfileSkeleton(
  memberId: string,
  fields: { name: string; title?: string; description?: string },
): string {
  const dir = memberDir(memberId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(memberSkillsDir(memberId), { recursive: true });
  ensureSharedMemoryDirs();
  const lines = ["---", `name: ${yamlEscape(fields.name)}`];
  if (fields.title?.trim()) lines.push(`title: ${yamlEscape(fields.title.trim())}`);
  if (fields.description?.trim()) lines.push(`description: ${yamlEscape(fields.description.trim())}`);
  lines.push("---", "");
  const path = memberProfilePath(memberId);
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  return path;
}

function yamlEscape(value: string): string {
  // Quote if special YAML chars.
  if (/[:#{}[\],&*!|>'"%@`]/.test(value) || value !== value.trim() || value === "") {
    return JSON.stringify(value);
  }
  return value;
}

export function readMemberProfile(memberId: string, fallbackName: string): MemberProfile {
  const path = memberProfilePath(memberId);
  if (!existsSync(path)) {
    return {
      frontmatter: { name: fallbackName },
      body: "",
      raw: "",
      path,
      exists: false,
      overBudget: false,
    };
  }
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    logger.warn("member-profile", "read failed", { memberId, error: String(err) });
    return {
      frontmatter: { name: fallbackName },
      body: "",
      raw: "",
      path,
      exists: false,
      overBudget: false,
    };
  }
  let meta: Record<string, unknown> = {};
  let body = raw;
  try {
    const parsed = parseFrontmatter(raw);
    meta = parsed.meta || {};
    body = parsed.body || "";
  } catch (err) {
    // Parse failure: keep body as full file, fall back name — never crash the session.
    logger.warn("member-profile", "frontmatter parse failed; using registry name", {
      memberId,
      error: String(err),
    });
    meta = {};
    body = raw;
  }
  const name = asString(meta.name, "").trim() || fallbackName;
  const title = asString(meta.title, "").trim() || undefined;
  const description = asString(meta.description, "").trim() || undefined;
  const overBudget = raw.length > MEMBER_PROFILE_BUDGET_CHARS;
  if (overBudget) {
    logger.warn("member-profile", "member.md over budget", {
      memberId,
      chars: raw.length,
      budget: MEMBER_PROFILE_BUDGET_CHARS,
    });
  }
  return {
    frontmatter: { name, title, description },
    body: body.replace(/^\uFEFF/, "").replace(/^\n+/, ""),
    raw,
    path,
    exists: true,
    overBudget,
  };
}

/** Build segment ① injection text (frontmatter not injected). */
export function formatMemberPromptSegment(profile: MemberProfile, fallbackName: string): string {
  const name = profile.frontmatter.name || fallbackName;
  const parts = [`# Member`, ``, `I am ${name}.`];
  const body = profile.body.trim();
  if (body) {
    parts.push(``, body);
  }
  return parts.join("\n");
}

/** True when body is empty — used for birth icebreaker. */
export function isBlankPersona(profile: MemberProfile): boolean {
  return !profile.body.trim();
}

function serializeProfile(
  fields: { name: string; title?: string; description?: string },
  body: string,
): string {
  const lines = ["---", `name: ${yamlEscape(fields.name)}`];
  if (fields.title?.trim()) lines.push(`title: ${yamlEscape(fields.title.trim())}`);
  if (fields.description?.trim()) lines.push(`description: ${yamlEscape(fields.description.trim())}`);
  lines.push("---", "");
  const trimmedBody = body.replace(/^\uFEFF/, "").replace(/^\n+/, "").replace(/\s+$/, "");
  if (trimmedBody) {
    return `${lines.join("\n")}\n${trimmedBody}\n`;
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Patch member.md frontmatter fields while preserving body.
 * - name always written when provided (sync with registry rename)
 * - title/description: undefined = leave; null/"" = clear from frontmatter
 * Creates the file (skeleton + body) if missing.
 */
export function updateMemberProfileFrontmatter(
  memberId: string,
  patch: { name?: string; title?: string | null; description?: string | null },
  fallbackName: string,
): MemberProfile {
  const current = readMemberProfile(memberId, fallbackName);
  const name =
    patch.name !== undefined
      ? (patch.name.trim() || fallbackName)
      : current.frontmatter.name || fallbackName;

  let title = current.frontmatter.title;
  if (patch.title !== undefined) {
    const t = (patch.title ?? "").trim();
    title = t || undefined;
  }

  let description = current.frontmatter.description;
  if (patch.description !== undefined) {
    const d = (patch.description ?? "").trim();
    description = d || undefined;
  }

  mkdirSync(memberDir(memberId), { recursive: true });
  const path = memberProfilePath(memberId);
  const raw = serializeProfile({ name, title, description }, current.body);
  writeFileSync(path, raw, "utf-8");
  return readMemberProfile(memberId, fallbackName);
}
