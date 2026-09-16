/**
 * Skill directory summary for Environment segment (budget ~2% of context).
 * Spec 1.2 + rc.7 platform skills: under_budget → shortened → dropped → omitted
 * (protected platform skills never omitted).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../kernel/frontmatter.js";
import { memberSkillsDir } from "../workspace/member-profile.js";

export type SkillCatalogMode =
  | "under_budget"
  | "shortened_descriptions"
  | "dropped_descriptions"
  | "omitted_skills"
  | "absent";

export interface SkillCatalogEntry {
  /** Relative path for display, e.g. review/SKILL.md or bossmode-guide/SKILL.md */
  relPath: string;
  description: string;
  /** Absolute path for the read tool (platform skills live outside member dir). */
  absPath?: string;
  /** Platform-shipped skill (package assets); protected from omit ladder. */
  platform?: boolean;
}

export interface SkillCatalogResult {
  mode: SkillCatalogMode;
  /** Formatted lines for Environment (without the "Your skills:" header). Empty if absent. */
  lines: string[];
  entries: SkillCatalogEntry[];
  budgetTokens: number;
  usedTokens: number;
  /** Absolute dir of platform skills (for Environment pointer). */
  platformSkillsDir: string | null;
}

const DESC_FULL = 120;
const DESC_SHORT = 48;
const OMIT_KEEP = 3;

/** Never dropped in omitted_skills mode (grok-bot env-setup pattern). */
export const PROTECTED_PLATFORM_SKILLS = new Set(["bossmode-guide"]);

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** Package assets/skills — resolved from compiled dist/engine → ../../assets/skills. */
export function platformSkillsDir(): string {
  return join(import.meta.dirname, "../../assets/skills");
}

function scanSkillsDir(
  skillsDir: string,
  opts: { platform?: boolean; pathPrefix?: string } = {},
): SkillCatalogEntry[] {
  if (!existsSync(skillsDir)) return [];
  let names: string[] = [];
  try {
    names = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const out: SkillCatalogEntry[] = [];
  for (const name of names) {
    const skillMd = join(skillsDir, name, "SKILL.md");
    try {
      if (!statSync(join(skillsDir, name)).isDirectory()) continue;
      if (!existsSync(skillMd)) continue;
      const raw = readFileSync(skillMd, "utf-8");
      let description = "";
      try {
        const { meta, body } = parseFrontmatter(raw);
        const fmDesc = typeof meta.description === "string" ? meta.description : "";
        description = firstNonEmptyLine(fmDesc) || firstNonEmptyLine(body);
      } catch {
        description = firstNonEmptyLine(raw);
      }
      const rel = opts.pathPrefix ? `${opts.pathPrefix}${name}/SKILL.md` : `${name}/SKILL.md`;
      out.push({
        relPath: rel,
        description: truncate(description, DESC_FULL),
        absPath: skillMd,
        platform: opts.platform === true,
      });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function scanMemberSkills(skillsDir: string): SkillCatalogEntry[] {
  return scanSkillsDir(skillsDir, { platform: false });
}

function scanPlatformSkills(): SkillCatalogEntry[] {
  return scanSkillsDir(platformSkillsDir(), { platform: true });
}

/** List member + platform skills for panel API (full descriptions, no budget ladder). */
export function listMemberSkills(memberId: string): Array<{
  name: string;
  path: string;
  description: string;
  platform?: boolean;
  absPath?: string;
}> {
  const member = scanMemberSkills(memberSkillsDir(memberId)).map((e) => ({
    name: e.relPath.replace(/\/SKILL\.md$/, ""),
    path: e.relPath,
    description: e.description,
    platform: false as boolean | undefined,
    absPath: undefined as string | undefined,
  }));
  const platform = scanPlatformSkills().map((e) => ({
    name: e.relPath.replace(/\/SKILL\.md$/, ""),
    path: e.relPath,
    description: e.description,
    platform: true as boolean | undefined,
    absPath: e.absPath,
  }));
  return [...platform, ...member];
}

function formatLines(
  entries: SkillCatalogEntry[],
  mode: Exclude<SkillCatalogMode, "absent">,
  memberSkillsPath: string,
): string[] {
  const desc = (e: SkillCatalogEntry, max: number) => {
    const tag = e.platform ? " [platform]" : "";
    const d = truncate(e.description, max);
    return d ? `${d}${tag}` : e.platform ? "[platform]" : "(no description)";
  };

  if (mode === "under_budget") {
    return entries.map((e) => {
      const where = e.platform && e.absPath ? e.absPath : e.relPath;
      return `  - ${where} — ${desc(e, DESC_FULL)}`;
    });
  }
  if (mode === "shortened_descriptions") {
    return entries.map((e) => {
      const where = e.platform && e.absPath ? e.absPath : e.relPath;
      return `  - ${where} — ${desc(e, DESC_SHORT)}`;
    });
  }
  if (mode === "dropped_descriptions") {
    return entries.map((e) => {
      const where = e.platform && e.absPath ? e.absPath : e.relPath;
      return `  - ${where}${e.platform ? " [platform]" : ""}`;
    });
  }
  // omitted_skills: keep protected platform skills + first OMIT_KEEP member skills
  const protectedEntries = entries.filter(
    (e) => e.platform && PROTECTED_PLATFORM_SKILLS.has(e.relPath.replace(/\/SKILL\.md$/, "")),
  );
  const rest = entries.filter((e) => !protectedEntries.includes(e));
  const keptRest = rest.slice(0, OMIT_KEEP);
  const more = rest.length - keptRest.length;
  const kept = [...protectedEntries, ...keptRest];
  const lines = kept.map((e) => {
    const where = e.platform && e.absPath ? e.absPath : e.relPath;
    return `  - ${where}${e.platform ? " [platform]" : ""}`;
  });
  if (more > 0) {
    lines.push(`  (${more} more under ${memberSkillsPath} — ls to list them.)`);
  }
  return lines;
}

function linesTokens(lines: string[]): number {
  return estimateTokens(lines.join("\n").length);
}

/**
 * Build skill catalog lines for a member (member dir + platform assets).
 * @param contextWindowTokens model context window (tokens); budget = 2%
 */
export function buildSkillCatalog(memberId: string, contextWindowTokens: number): SkillCatalogResult {
  const skillsDir = memberSkillsDir(memberId);
  const platformDir = platformSkillsDir();
  const platform = scanPlatformSkills();
  const member = scanMemberSkills(skillsDir);
  // Platform first so protected skills stay visible; then member skills.
  const entries = [...platform, ...member];
  if (entries.length === 0) {
    return {
      mode: "absent",
      lines: [],
      entries: [],
      budgetTokens: 0,
      usedTokens: 0,
      platformSkillsDir: existsSync(platformDir) ? platformDir : null,
    };
  }
  const budgetTokens = Math.max(1, Math.floor(contextWindowTokens * 0.02));
  const modes: Array<Exclude<SkillCatalogMode, "absent">> = [
    "under_budget",
    "shortened_descriptions",
    "dropped_descriptions",
    "omitted_skills",
  ];
  for (const mode of modes) {
    const lines = formatLines(entries, mode, skillsDir);
    const used = linesTokens(lines);
    if (used <= budgetTokens || mode === "omitted_skills") {
      return {
        mode,
        lines,
        entries,
        budgetTokens,
        usedTokens: used,
        platformSkillsDir: existsSync(platformDir) ? platformDir : null,
      };
    }
  }
  return {
    mode: "omitted_skills",
    lines: formatLines(entries, "omitted_skills", skillsDir),
    entries,
    budgetTokens,
    usedTokens: 0,
    platformSkillsDir: existsSync(platformDir) ? platformDir : null,
  };
}
