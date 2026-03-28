import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "./config.js";
import { parseFrontmatter, asStringArray, asString } from "./frontmatter.js";
import type { AgentDefinition } from "../shared/types.js";

const AGENTS_DIR = join(getBossmodeDir(), "agents");

export function getAgentsDir(): string {
  return AGENTS_DIR;
}

export function ensureAgentsDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

function parseAgentFile(content: string, fallbackName: string): AgentDefinition {
  const { meta, body } = parseFrontmatter(content);
  return {
    name: asString(meta.name, fallbackName),
    model: asString(meta.model, "claude-sonnet-4-6"),
    description: asString(meta.description),
    systemPrompt: body,
    skills: asStringArray(meta.skills),
    avatar: meta.avatar ? String(meta.avatar) : undefined,
    tags: asStringArray(meta.tags),
  };
}

export function loadAgentDefinitions(): AgentDefinition[] {
  ensureAgentsDir();

  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  const agents: AgentDefinition[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(AGENTS_DIR, file), "utf-8");
      agents.push(parseAgentFile(content, file.replace(/\.md$/, "")));
    } catch {
      // Skip corrupted files
    }
  }

  return agents;
}

export function loadAgentDefinition(name: string): AgentDefinition | null {
  const filePath = join(AGENTS_DIR, `${name}.md`);
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  return parseAgentFile(content, name);
}

export function saveAgentDefinition(name: string, markdownContent: string): AgentDefinition {
  ensureAgentsDir();
  const filePath = join(AGENTS_DIR, `${name}.md`);
  writeFileSync(filePath, markdownContent, "utf-8");
  return parseAgentFile(markdownContent, name);
}

export function deleteAgentDefinition(name: string): boolean {
  const filePath = join(AGENTS_DIR, `${name}.md`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// Load agent templates from templates/ directory
export function loadAgentTemplates(): AgentDefinition[] {
  const templatesDir = join(import.meta.dirname, "../../templates/agents");
  if (!existsSync(templatesDir)) return [];

  const files = readdirSync(templatesDir).filter((f) => f.endsWith(".md"));
  const templates: AgentDefinition[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(templatesDir, file), "utf-8");
      templates.push(parseAgentFile(content, file.replace(/\.md$/, "")));
    } catch {
      // Skip
    }
  }

  return templates;
}
