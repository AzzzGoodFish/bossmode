import { getDatabase, type Database } from "../data/database.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, rmSync, constants } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getBossmodeDir, installationRoot } from "../files/layout.js";
import { logger } from "../kernel/logger.js";

interface TemplateFile { category: "skill" | "rule"; relativePath: string; name: string; sourcePath: string; localPath: string }
const legacyRules = ["rules/dev-team-protocol.md", "rules/lite-team-protocol.md", "rules/ssot.md", "rules/universal-agent-principles.md"];

/** Package files only: hidden entries and symlinks are not installation inputs. */
function templateFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  };
  walk(root);
  return files;
}
export function toRulePath(templatePath: string): string {
  const parts = templatePath.replace(/\\/g, "/").split("/");
  if (parts.at(-1) === "team-prompt.md" && parts.length > 1) return `rules/team-${parts.at(-2)!.replace(/-team$/, "")}-protocol.md`;
  return `rules/member-${parts.at(-1)!}`;
}
function enumerateTemplates(): TemplateFile[] {
  const root = join(installationRoot, "templates"), result = new Map<string, TemplateFile>();
  const skills = join(root, "skills");
  if (existsSync(skills)) for (const name of readdirSync(skills)) {
    const sourcePath = join(skills, name);
    if (existsSync(join(sourcePath, "SKILL.md"))) result.set(`skills/${name}`, {
      category: "skill", relativePath: `skills/${name}`, name, sourcePath, localPath: join(getBossmodeDir(), "skills", name),
    });
  }
  const teams = join(root, "teams");
  for (const sourcePath of templateFiles(teams)) {
    if (!sourcePath.toLowerCase().endsWith(".md")) continue;
    const relativePath = toRulePath(relative(teams, sourcePath));
    if (!result.has(relativePath)) result.set(relativePath, { category: "rule", relativePath, name: basename(relativePath, ".md"),
      sourcePath, localPath: join(getBossmodeDir(), "memory", "projects", ...relativePath.split("/")) });
  }
  return [...result.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
/** Preserve the original builtin-ownership marker grammar; do not reclassify local files. */
function parseBuiltin(raw: string): { meta: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return match ? { meta: (parseYaml(match[1]) || {}) as Record<string, unknown>, body: match[2].trimStart() } : { meta: {}, body: raw };
}
function frontmatter(meta: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(meta).trim()}\n---\n\n${body.trimStart()}`;
}
function renderSkill(raw: string, version: string): string {
  const { meta, body } = parseBuiltin(raw);
  return frontmatter({ ...meta, source: "builtin", version }, body);
}
function renderRule(template: TemplateFile, version: string): string {
  const parsed = parseBuiltin(readFileSync(template.sourcePath, "utf8"));
  let body = parsed.body, title = typeof parsed.meta.title === "string" ? parsed.meta.title : "";
  if (!title) {
    const heading = body.match(/^#\s+(.+)\n/);
    title = heading ? heading[1].trim() : basename(template.relativePath, ".md").replace(/[-_]/g, " ");
    if (heading) body = body.slice(heading[0].length).trimStart();
  }
  const now = Date.now();
  return frontmatter({ title, type: "rule", source: "builtin", version, author: "builtin", created: now, updated: now }, body);
}
function seedTemplate(template: TemplateFile, version: string): boolean {
  if (existsSync(template.localPath)) return false;
  mkdirSync(dirname(template.localPath), { recursive: true });
  if (template.category === "rule") {
    try { writeFileSync(template.localPath, renderRule(template, version), { encoding: "utf8", flag: "wx" }); }
    catch (error: any) { if (error.code === "EEXIST") return false; throw error; }
  } else {
    try { mkdirSync(template.localPath); }
    catch (error: any) { if (error.code === "EEXIST") return false; throw error; }
    for (const file of templateFiles(template.sourcePath)) {
      const name = relative(template.sourcePath, file), target = join(template.localPath, name);
      mkdirSync(dirname(target), { recursive: true });
      if (name === "SKILL.md") writeFileSync(target, renderSkill(readFileSync(file, "utf8"), version), { encoding: "utf8", flag: "wx" });
      else copyFileSync(file, target, constants.COPYFILE_EXCL);
    }
  }
  return true;
}
function cleanupDeletedSkills(templates: TemplateFile[]): string[] {
  const root = join(getBossmodeDir(), "skills");
  if (!existsSync(root)) return [];
  const active = new Set(templates.filter(template => template.category === "skill").map(template => template.name));
  const removed: string[] = [];
  for (const name of readdirSync(root)) {
    if (active.has(name)) continue;
    const dir = join(root, name), file = join(dir, "SKILL.md");
    try { if (!existsSync(file) || parseBuiltin(readFileSync(file, "utf8")).meta.source !== "builtin") continue; }
    catch { continue; }
    rmSync(dir, { recursive: true, force: true });
    removed.push(`skills/${name}`);
  }
  return removed;
}
/** Fresh-install seeding; existing local content is never updated by this operation. */
export function seedBuiltinAssets(): void {
  const version = JSON.parse(readFileSync(join(installationRoot, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !version) throw new Error("Installed package version is missing");
  const templates = enumerateTemplates();
  let seeded = 0, cleaned = 0;
  for (const template of templates) {
    try { if (seedTemplate(template, version)) seeded++; }
    catch (error) { logger.error("team-updates", "seed failed", { path: template.relativePath, error: String(error) }); }
  }
  for (const path of legacyRules) {
    const absolute = join(getBossmodeDir(), "memory", "projects", ...path.split("/"));
    if (!existsSync(absolute)) continue;
    try { unlinkSync(absolute); cleaned++; logger.info("team-updates", "removed legacy rule file", { path }); }
    catch (error) { logger.error("team-updates", "failed to remove legacy rule", { path, error: String(error) }); }
  }
  const removedSkills = cleanupDeletedSkills(templates);
  if (seeded || cleaned || removedSkills.length) logger.info("team-updates", "seeded missing builtin assets", { seeded, cleaned, removedSkills: removedSkills.length });
}

export const templateMetadataKeys = ["name", "description", "avatar", "tags", "model", "skills"] as const;

/** Lookup identity is never inferred from the editable display name. No persona bytes in SQL. */
export interface TemplateMetadata {
  slug: string;
  name: string;
  description: string;
  avatar?: string;
  model?: string;
  tags?: string[];
  skills?: string[];
  personaPath: string;
  /** Unrecognized YAML metadata, including source/version, retained for explicit exports. */
  extensions: Record<string, unknown>;
}

interface Row {
  slug: string; display_name: string; description: string; avatar: string | null; model: string | null;
  tags_present: number; skills_present: number; persona_path: string; extensions_json: string;
}

export function validateTemplateSlug(slug: string): void {
  if (!slug || slug === "." || slug === ".." || /[\\/\0]/.test(slug)) throw new Error("Invalid agent template slug");
}

export function validateTemplatePath(slug: string, path: string): void {
  validateTemplateSlug(slug);
  const parts = path.split("/");
  if (parts.length < 3 || parts[0] !== "agents" || parts[1] !== slug || parts.at(-1) !== "persona.md"
    || parts.some(p => !p || p === "." || p === ".." || /[\\\0]/.test(p))) throw new Error("Invalid agent persona path");
}

/** Explicit initialized Database only; never opens, binds, migrates, or reads legacy files. */
export function hasTemplateMetadata(slug: string, db: Database = getDatabase()): boolean {
    validateTemplateSlug(slug);
    return !!db.get("SELECT 1 FROM agent_templates WHERE slug=?", slug);
  }

export function readTemplateMetadata(slug: string, db: Database = getDatabase()): TemplateMetadata | null {
    validateTemplateSlug(slug);
    const row = db.get<Row>("SELECT * FROM agent_templates WHERE slug=?", slug);
    return row ? decodeTemplateMetadata(row, db) : null;
  }

export function listTemplateMetadata(db: Database = getDatabase()): TemplateMetadata[] {
    return db.all<Row>("SELECT * FROM agent_templates ORDER BY slug").map(row => decodeTemplateMetadata(row, db));
  }

export function importTemplateMetadata(template: TemplateMetadata, db: Database = getDatabase()): void {
    validateTemplatePath(template.slug, template.personaPath);
    for (const key of templateMetadataKeys) {
      if (Object.hasOwn(template.extensions, key)) throw new Error(`Known template metadata cannot be duplicated in extensions: ${key}`);
    }
    const extensions = JSON.stringify(template.extensions);
    db.transaction(tx => {
      tx.run(`INSERT INTO agent_templates
        (slug,display_name,description,avatar,model,tags_present,skills_present,persona_path,extensions_json)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET
        display_name=excluded.display_name, description=excluded.description, avatar=excluded.avatar,
        model=excluded.model, tags_present=excluded.tags_present, skills_present=excluded.skills_present,
        persona_path=excluded.persona_path, extensions_json=excluded.extensions_json`,
      template.slug, template.name, template.description, template.avatar ?? null, template.model ?? null,
      Number(template.tags !== undefined), Number(template.skills !== undefined), template.personaPath, extensions);
      for (const [table, values] of [["agent_template_tags", template.tags], ["agent_template_skills", template.skills]] as const) {
        tx.run(`DELETE FROM ${table} WHERE slug=?`, template.slug);
        values?.forEach((value, position) => tx.run(`INSERT INTO ${table} (slug,position,value) VALUES (?,?,?)`, template.slug, position, value));
      }
    });
  }

export function deleteTemplateMetadata(slug: string, db: Database = getDatabase()): boolean {
    return db.transaction(tx => {
      if (!hasTemplateMetadata(slug, tx)) return false;
      tx.run("DELETE FROM agent_templates WHERE slug=?", slug);
      return true;
    });
  }

function decodeTemplateMetadata(row: Row, db: Database = getDatabase()): TemplateMetadata {
    const values = (table: string) => db.all<{value: string}>(`SELECT value FROM ${table} WHERE slug=? ORDER BY position`, row.slug).map(v => v.value);
    return {
      slug: row.slug, name: row.display_name, description: row.description,
      avatar: row.avatar ?? undefined, model: row.model ?? undefined,
      tags: row.tags_present ? values("agent_template_tags") : undefined,
      skills: row.skills_present ? values("agent_template_skills") : undefined,
      personaPath: row.persona_path, extensions: JSON.parse(row.extensions_json),
    };
  }
