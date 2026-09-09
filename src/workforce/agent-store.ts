import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import type { AgentDefinition } from "../shared/types.js";
import { logger } from "../foundation/logger.js";
import { getDatabase } from "../storage/database.js";
import { TemplateRepository, type TemplateMetadata } from "../storage/repositories/templates.js";
import { parseAgentDefinitionMarkdown, readTemplateBody, renderTemplateMarkdown, templateDefinition, writeTemplateBody } from "./template-files.js";

export function getAgentsDir(): string { return join(getBossmodeDir(), "agents"); }
export function ensureAgentsDir(): void { mkdirSync(getAgentsDir(), { recursive: true }); }

function repository(): TemplateRepository { return new TemplateRepository(getDatabase()); }
function definition(metadata: TemplateMetadata): AgentDefinition {
  return templateDefinition(metadata, readTemplateBody(getBossmodeDir(), metadata));
}
function parseAgentFile(content: string, slug: string): AgentDefinition {
  const parsed = parseAgentDefinitionMarkdown(slug, content);
  return templateDefinition(parsed.metadata, parsed.body);
}

/** Both list reads are strict: a broken body reference is never a partial successful list. */
export function loadAgentDefinitions(): AgentDefinition[] { return repository().list().map(definition); }
export function loadAgentDefinitionsStrict(): AgentDefinition[] { return loadAgentDefinitions(); }
export function loadAgentDefinition(name: string): AgentDefinition | null {
  const metadata = repository().get(name);
  return metadata ? definition(metadata) : null;
}

/** Use for API iteration when the lookup slug can differ from the display name. */
export function listAgentTemplateMetadata(): TemplateMetadata[] { return repository().list(); }
export function hasAgentDefinition(slug: string): boolean { return repository().has(slug); }
export function renderAgentDefinitionMarkdown(slug: string): string | null {
  const metadata = repository().get(slug);
  return metadata ? renderTemplateMarkdown(metadata, readTemplateBody(getBossmodeDir(), metadata)) : null;
}

export function saveAgentDefinition(name: string, markdownContent: string): AgentDefinition {
  const store = repository();
  const parsed = parseAgentDefinitionMarkdown(name, markdownContent);
  // Fail missing/unavailable schema before preparing a file, then publish only after durable file IO.
  store.has(name);
  const personaPath = writeTemplateBody(getBossmodeDir(), name, parsed.body);
  store.upsert({ ...parsed.metadata, personaPath });
  return templateDefinition(parsed.metadata, parsed.body);
}

/** Remove authority first. Unreferenced body cleanup must run outside caller transactions. */
export function deleteAgentDefinition(name: string): boolean { return repository().delete(name); }

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
