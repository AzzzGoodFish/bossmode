import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { memberSkillsDir, installationRoot } from "../files/layout.js";
import { parseFrontmatter, asStringArray, asString } from "../kernel/markdown.js";
import { logger } from "../kernel/logger.js";
export interface SkillDefinition {
  name: string;
  description: string;
  tags: string[];
  content: string;
  source?: string; // directory this skill was loaded from
}

export function platformSkillsDir(): string { return join(installationRoot, "assets", "skills"); }

function parseSkill(content: string, name: string, source: string, summary = false): SkillDefinition {
  try {
    const { meta, body } = parseFrontmatter(content);
    return { name: asString(meta.name, name), description: asString(meta.description), tags: asStringArray(meta.tags), content: body, source };
  } catch (error) {
    if (!summary) throw error;
    return { name, description: "", tags: [], content, source };
  }
}
interface SkillFile { folder: string; file: string; definition: SkillDefinition }
/** One discovery/parser path; list authority is strict, while prompt summaries tolerate unreadable entries. */
function scanSkills(dir:string,summary=false):SkillFile[]{
  if (!existsSync(dir)) return [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if(summary)return [];throw error; }
  const result: SkillFile[] = [];
  for (const entry of entries) {
    try {
      if (!entry.isDirectory() && (!summary || !statSync(join(dir, entry.name)).isDirectory())) continue;
      const file = join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      result.push({ folder: entry.name, file, definition: parseSkill(readFileSync(file, "utf8"), entry.name, dir, summary) });
    } catch (error) {
      if (!summary) logger.error("skill-store", "failed to parse skill", { name: entry.name, error: String(error) });
    }
  }
  return result;
}
export type SkillCatalogMode = "under_budget" | "shortened_descriptions" | "dropped_descriptions" | "omitted_skills" | "absent";
export interface SkillCatalogEntry { relPath: string; description: string; absPath?: string; platform?: boolean }
export interface SkillCatalogResult {
  mode: SkillCatalogMode; lines: string[]; entries: SkillCatalogEntry[];
  budgetTokens: number; usedTokens: number; platformSkillsDir: string | null;
}
export const PROTECTED_PLATFORM_SKILLS = new Set(["bossmode-guide"]);
function firstLine(text: string): string { return text.split("\n").map(line => line.trim()).find(Boolean) || ""; }
function truncate(text: string, length: number): string {
  const value = text.trim();
  return value.length <= length ? value : value.slice(0, Math.max(0, length - 1)).trimEnd() + "…";
}
function summaries(dir: string, platform: boolean): SkillCatalogEntry[] {
  return scanSkills(dir,true).map(entry => ({
    relPath: entry.folder + "/SKILL.md", absPath: entry.file, platform,
    description: truncate(firstLine(entry.definition.description) || firstLine(entry.definition.content), 120),
  })).sort((a, b) => a.relPath.localeCompare(b.relPath));
}
function memberCatalog(memberId: string): SkillCatalogEntry[] {
  return [...summaries(platformSkillsDir(), true), ...summaries(memberSkillsDir(memberId), false)];
}
export function listMemberSkills(memberId: string): Array<{ name: string; path: string; description: string; platform?: boolean; absPath?: string }> {
  return memberCatalog(memberId).map(entry => ({ name: entry.relPath.slice(0, -9), path: entry.relPath,
    description: entry.description, platform: entry.platform, absPath: entry.platform ? entry.absPath : undefined }));
}
function formatLines(entries: SkillCatalogEntry[], mode: Exclude<SkillCatalogMode, "absent">, memberPath: string): string[] {
  let visible = entries, more = 0;
  if (mode === "omitted_skills") {
    const protectedEntries = entries.filter(entry => entry.platform && PROTECTED_PLATFORM_SKILLS.has(entry.relPath.slice(0, -9)));
    const rest = entries.filter(entry => !protectedEntries.includes(entry));
    visible = [...protectedEntries, ...rest.slice(0, 3)];
    more = rest.length - Math.min(3, rest.length);
  }
  const descriptions = mode === "under_budget" || mode === "shortened_descriptions";
  const lines = visible.map(entry => {
    const where = entry.platform && entry.absPath ? entry.absPath : entry.relPath;
    const tag = entry.platform ? " [platform]" : "";
    if (!descriptions) return `  - ${where}${tag}`;
    const description = truncate(entry.description, mode === "under_budget" ? 120 : 48);
    return `  - ${where} — ${description ? description + tag : entry.platform ? "[platform]" : "(no description)"}`;
  });
  if (more) lines.push(`  (${more} more under ${memberPath} — ls to list them.)`);
  return lines;
}
export function buildSkillCatalog(memberId: string, contextWindowTokens: number): SkillCatalogResult {
  const entries = memberCatalog(memberId), dir = platformSkillsDir();
  const budgetTokens = entries.length ? Math.max(1, Math.floor(contextWindowTokens * 0.02)) : 0;
  let mode: SkillCatalogMode = "absent", lines: string[] = [], usedTokens = 0;
  if (entries.length) for (const candidate of ["under_budget", "shortened_descriptions", "dropped_descriptions", "omitted_skills"] as const) {
    mode = candidate;
    lines = formatLines(entries, candidate, memberSkillsDir(memberId));
    usedTokens = Math.ceil(lines.join("\n").length / 4);
    if (usedTokens <= budgetTokens) break;
  }
  return { mode, lines, entries, budgetTokens, usedTokens, platformSkillsDir: existsSync(dir) ? dir : null };
}
