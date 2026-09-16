import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../../config/config.js";
import { parseFrontmatter, asStringArray, asString } from "../../kernel/frontmatter.js";
import { logger } from "../../kernel/logger.js";
import type { SkillDefinition } from "../../kernel/types.js";

const PRIMARY_SKILLS_DIR = join(getBossmodeDir(), "skills");

const SKILL_DIRS = [PRIMARY_SKILLS_DIR];

export function getSkillsDir(): string {
  return PRIMARY_SKILLS_DIR;
}

export function ensureSkillsDir(): void {
  if (!existsSync(PRIMARY_SKILLS_DIR)) {
    mkdirSync(PRIMARY_SKILLS_DIR, { recursive: true });
  }
}

function parseSkillFile(content: string, fallbackName: string, source?: string): SkillDefinition {
  const { meta, body } = parseFrontmatter(content);
  return {
    name: asString(meta.name, fallbackName),
    description: asString(meta.description),
    tags: asStringArray(meta.tags),
    content: body,
    source,
  };
}

function scanDir(dir: string): SkillDefinition[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const skills: SkillDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;

    try {
      const content = readFileSync(skillFile, "utf-8");
      skills.push(parseSkillFile(content, entry.name, dir));
    } catch (err) { logger.error("skill-store", "failed to parse skill", { name: entry.name, error: String(err) }); }
  }

  return skills;
}

export function loadSkillDefinitions(): SkillDefinition[] {
  ensureSkillsDir();

  const seen = new Set<string>();
  const all: SkillDefinition[] = [];

  for (const dir of SKILL_DIRS) {
    for (const skill of scanDir(dir)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }

  return all;
}

/** Authority read for user-facing lists: never return a silent partial result. */
export function loadSkillDefinitionsStrict(): SkillDefinition[] {
  ensureSkillsDir();
  const seen = new Set<string>();
  const all: SkillDefinition[] = [];
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      const skill = parseSkillFile(readFileSync(skillFile, "utf-8"), entry.name, dir);
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        all.push(skill);
      }
    }
  }
  return all;
}

export function loadSkillDefinition(name: string): SkillDefinition | null {
  for (const dir of SKILL_DIRS) {
    const skillFile = join(dir, name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const content = readFileSync(skillFile, "utf-8");
    return parseSkillFile(content, name, dir);
  }
  return null;
}

export function loadSkillsByNames(names: string[]): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  for (const name of names) {
    const skill = loadSkillDefinition(name);
    if (skill) skills.push(skill);
  }
  return skills;
}

/**
 * 0.20: resolve skill directory paths from the global skills pool only
 * (no room team/skills fallback — team layer removed).
 */
export function resolveGlobalSkillPaths(skillNames: string[]): string[] {
  ensureSkillsDir();
  return skillNames.map((name) => {
    const global = join(PRIMARY_SKILLS_DIR, name);
    if (existsSync(join(global, "SKILL.md"))) return global;
    return global; // path for error reporting even if missing
  });
}

export function saveSkillDefinition(name: string, markdownContent: string): SkillDefinition {
  ensureSkillsDir();
  const skillDir = join(PRIMARY_SKILLS_DIR, name);
  if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), markdownContent, "utf-8");
  return parseSkillFile(markdownContent, name, PRIMARY_SKILLS_DIR);
}

export function deleteSkillDefinition(name: string): boolean {
  const skillDir = join(PRIMARY_SKILLS_DIR, name);
  if (!existsSync(skillDir)) return false;
  rmSync(skillDir, { recursive: true, force: true });
  return true;
}

export function loadSkillTemplates(): SkillDefinition[] {
  const templatesDir = join(import.meta.dirname, "../../../templates/skills");
  return scanDir(templatesDir);
}
