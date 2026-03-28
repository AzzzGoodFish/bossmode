import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getBossmodeDir } from "./config.js";
import { parseFrontmatter, asStringArray, asString } from "./frontmatter.js";
import type { SkillDefinition } from "../shared/types.js";

const PRIMARY_SKILLS_DIR = join(getBossmodeDir(), "skills");

// Multi-directory scan: bossmode > ~/.agents > ~/.pi/agent
const SKILL_DIRS = [
  PRIMARY_SKILLS_DIR,
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".pi", "agent", "skills"),
];

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
    } catch { /* skip */ }
  }

  return skills;
}

export function loadSkillDefinitions(): SkillDefinition[] {
  ensureSkillsDir();

  const seen = new Set<string>();
  const all: SkillDefinition[] = [];

  // Scan in priority order — first dir wins on name conflict
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

export function loadSkillDefinition(name: string): SkillDefinition | null {
  // Search in priority order
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
  const templatesDir = join(import.meta.dirname, "../../templates/skills");
  return scanDir(templatesDir);
}
