/**
 * Skill directory summary for Environment segment (budget ~2% of context).
 * Spec 1.2: under_budget → shortened_descriptions → dropped_descriptions → omitted_skills
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../shared/frontmatter.js";
import { memberSkillsDir } from "../workspace/member-profile.js";

export type SkillCatalogMode =
  | "under_budget"
  | "shortened_descriptions"
  | "dropped_descriptions"
  | "omitted_skills"
  | "absent";

export interface SkillCatalogEntry {
  /** Relative path under skills/, e.g. pi-subagents/SKILL.md */
  relPath: string;
  description: string;
}

export interface SkillCatalogResult {
  mode: SkillCatalogMode;
  /** Formatted lines for Environment (without the "Your skills:" header). Empty if absent. */
  lines: string[];
  entries: SkillCatalogEntry[];
  budgetTokens: number;
  usedTokens: number;
}

const DESC_FULL = 120;
const DESC_SHORT = 48;
const OMIT_KEEP = 3;

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

/** List member skills for panel API (full descriptions, no budget ladder). */
export function listMemberSkills(memberId: string): Array<{ name: string; path: string; description: string }> {
  const skillsDir = memberSkillsDir(memberId);
  return scanSkills(skillsDir).map((e) => ({
    name: e.relPath.replace(/\/SKILL\.md$/, ""),
    path: e.relPath,
    description: e.description,
  }));
}

function scanSkills(skillsDir: string): SkillCatalogEntry[] {
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
      out.push({
        relPath: `${name}/SKILL.md`,
        description: truncate(description, DESC_FULL),
      });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

function formatLines(entries: SkillCatalogEntry[], mode: Exclude<SkillCatalogMode, "absent">, skillsDir: string): string[] {
  if (mode === "under_budget") {
    return entries.map((e) => `  - ${e.relPath} — ${e.description || "(no description)"}`);
  }
  if (mode === "shortened_descriptions") {
    return entries.map((e) => `  - ${e.relPath} — ${truncate(e.description, DESC_SHORT) || "(no description)"}`);
  }
  if (mode === "dropped_descriptions") {
    return entries.map((e) => `  - ${e.relPath}`);
  }
  // omitted_skills
  const kept = entries.slice(0, OMIT_KEEP);
  const more = entries.length - kept.length;
  const lines = kept.map((e) => `  - ${e.relPath}`);
  if (more > 0) {
    lines.push(`  (${more} more under ${skillsDir} — ls to list them.)`);
  }
  return lines;
}

function linesTokens(lines: string[]): number {
  return estimateTokens(lines.join("\n").length);
}

/**
 * Build skill catalog lines for a member.
 * @param contextWindowTokens model context window (tokens); budget = 2%
 */
export function buildSkillCatalog(memberId: string, contextWindowTokens: number): SkillCatalogResult {
  const skillsDir = memberSkillsDir(memberId);
  const entries = scanSkills(skillsDir);
  if (entries.length === 0) {
    return { mode: "absent", lines: [], entries: [], budgetTokens: 0, usedTokens: 0 };
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
      return { mode, lines, entries, budgetTokens, usedTokens: used };
    }
  }
  // unreachable
  return { mode: "omitted_skills", lines: formatLines(entries, "omitted_skills", skillsDir), entries, budgetTokens, usedTokens: 0 };
}
