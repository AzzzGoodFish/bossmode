import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { parseFrontmatter, asStringArray, asString } from "../shared/frontmatter.js";
import type { AgentDefinition } from "../shared/types.js";
import { logger } from "../foundation/logger.js";

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
    description: asString(meta.description),
    systemPrompt: body,
    avatar: meta.avatar ? String(meta.avatar) : undefined,
    tags: asStringArray(meta.tags),
    // Backward compat: read model/skills if present, but they're optional now
    model: meta.model ? asString(meta.model) : undefined,
    skills: meta.skills ? asStringArray(meta.skills) : undefined,
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
    } catch (err) {
      logger.error("agent-store", "failed to parse agent file", { file, error: String(err) });
    }
  }

  return agents;
}

/** Authority read for user-facing lists: never return a silent partial result. */
export function loadAgentDefinitionsStrict(): AgentDefinition[] {
  ensureAgentsDir();
  return readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => parseAgentFile(readFileSync(join(AGENTS_DIR, file), "utf-8"), file.replace(/\.md$/, "")));
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

/** Package factory agents directory (shipped with the npm package). */
export function getFactoryAgentsDir(): string {
  return join(import.meta.dirname, "../../templates/agents");
}

/** Names of factory-shipped agent templates (immutable set for 0.20). */
export function listFactoryTemplateNames(): string[] {
  const templatesDir = getFactoryAgentsDir();
  if (!existsSync(templatesDir)) return [];
  return readdirSync(templatesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

export function loadAgentTemplates(): AgentDefinition[] {
  const templatesDir = getFactoryAgentsDir();
  if (!existsSync(templatesDir)) return [];

  const files = readdirSync(templatesDir).filter((f) => f.endsWith(".md"));
  const templates: AgentDefinition[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(templatesDir, file), "utf-8");
      templates.push(parseAgentFile(content, file.replace(/\.md$/, "")));
    } catch (err) {
      logger.error("agent-store", "failed to parse template", { file, error: String(err) });
    }
  }

  return templates;
}
