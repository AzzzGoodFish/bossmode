import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { asString, asStringArray } from "../shared/frontmatter.js";
import type { AgentDefinition } from "../shared/types.js";
import type { Database } from "../storage/database.js";
import { TemplateRepository, templateMetadataKeys, validateTemplatePath, validateTemplateSlug, type TemplateMetadata } from "../storage/repositories/templates.js";

export interface ParsedTemplate {
  metadata: Omit<TemplateMetadata, "personaPath">;
  body: string;
}

/** Split only the YAML envelope; retain every persona byte after the closing delimiter. */
export function parseAgentDefinitionMarkdown(slug: string, markdown: string): ParsedTemplate {
  validateTemplateSlug(slug);
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (/^---\r?\n/.test(markdown) && !match) throw new Error("Unterminated agent frontmatter");
  const meta = match ? (parse(match[1]) ?? {}) : {};
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("Agent frontmatter must be a mapping");
  const extensions = Object.fromEntries(Object.entries(meta).filter(([key]) => !templateMetadataKeys.includes(key as typeof templateMetadataKeys[number])));
  return {
    metadata: {
      slug, name: asString(meta.name, slug), description: asString(meta.description),
      avatar: meta.avatar == null ? undefined : asString(meta.avatar),
      model: meta.model == null ? undefined : asString(meta.model),
      tags: meta.tags === undefined ? undefined : asStringArray(meta.tags),
      skills: meta.skills === undefined ? undefined : asStringArray(meta.skills),
      extensions,
    },
    body: match ? match[2] : markdown,
  };
}

export function templateDefinition(metadata: TemplateMetadata | ParsedTemplate["metadata"], body: string): AgentDefinition {
  return { name: metadata.name, description: metadata.description, avatar: metadata.avatar,
    model: metadata.model, tags: metadata.tags ?? [], skills: metadata.skills, systemPrompt: body };
}

/** Explicit editor/export reconstruction, not a live legacy-file fallback. */
export function renderTemplateMarkdown(metadata: TemplateMetadata, body: string): string {
  const meta = { ...metadata.extensions, name: metadata.name, description: metadata.description,
    avatar: metadata.avatar, tags: metadata.tags, model: metadata.model, skills: metadata.skills };
  return `---\n${stringify(meta).trimEnd()}\n---\n${body}`;
}

function sync(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function assetPath(root: string, slug: string, relativePath: string): string {
  if (!isAbsolute(root)) throw new Error("Agent asset root must be absolute");
  validateTemplatePath(slug, relativePath);
  let path = root;
  // Managed data root is supplied by bootstrap. Reject symlinks within it, including root itself.
  for (const part of ["", ...relativePath.split("/")]) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Agent asset path contains a symlink"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path;
}

export function readTemplateBody(root: string, metadata: TemplateMetadata): string {
  const path = assetPath(root, metadata.slug, metadata.personaPath);
  if (!lstatSync(path).isFile()) throw new Error("Agent persona must be a regular file");
  return readFileSync(path, "utf8");
}

/** Complete, fsynced, unique body first; SQL reference publication is a separate operation.
 * Unique paths keep the previously committed body intact on SQL failure/outer rollback.
 * Unreferenced files are deliberate recoverable orphans, not an application history store.
 */
export function writeTemplateBody(root: string, slug: string, body: string): string {
  const relativePath = `agents/${slug}/${randomUUID()}/persona.md`;
  const path = assetPath(root, slug, relativePath);
  const directory = dirname(path);
  const missing: string[] = [];
  for (let cursor = directory; ; cursor = dirname(cursor)) {
    try {
      if (!lstatSync(cursor).isDirectory()) throw new Error("Agent asset parent is not a directory");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
    }
  }
  for (const dir of missing.reverse()) { mkdirSync(dir, { mode: 0o700 }); sync(dir); sync(dirname(dir)); }
  const temporary = join(directory, ".persona.tmp");
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, body, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    sync(directory);
  } finally { rmSync(temporary, { force: true }); }
  return relativePath;
}

export interface TemplateSource {
  /** Legacy inventory path or immutable package source identifier; never opened here. */
  path: string;
  slug: string;
  markdown: string;
}
export interface TemplateImportContext {
  db: Database;
  stageAsset(relativePath: string, bytes: Uint8Array): void;
}

/** Pure source-inventory filter for parent's backup/retirement coordinator. */
export function legacyAgentTemplateSources(sourceFiles: readonly string[]): {path: string; retire: true}[] {
  return sourceFiles.filter(path => /^agents\/[^/\\]+\.md$/.test(path)).map(path => ({ path, retire: true }));
}

/** Parent reads its explicit backup inventory and supplies bytes. No filesystem discovery or lifecycle. */
export function importAgentTemplates(ctx: TemplateImportContext, sources: readonly TemplateSource[]): void {
  const seen = new Set<string>();
  const prepared = sources.map(source => {
    if (seen.has(source.slug)) throw new Error(`Duplicate agent template slug: ${source.slug}`);
    seen.add(source.slug);
    const parsed = parseAgentDefinitionMarkdown(source.slug, source.markdown);
    const hash = createHash("sha256").update(parsed.body).digest("hex");
    return { ...parsed, personaPath: `agents/${source.slug}/import-${hash}/persona.md` };
  });
  // No SQL transaction spans staging file IO. A staging failure publishes no metadata.
  for (const item of prepared) ctx.stageAsset(item.personaPath, Buffer.from(item.body, "utf8"));
  ctx.db.transaction(tx => {
    const repository = new TemplateRepository(tx);
    for (const item of prepared) repository.upsert({ ...item.metadata, personaPath: item.personaPath });
  });
}

/** Call after legacy import. Installed presence is SQL-only, including absent/retired mixed files. */
export function seedAgentTemplates(ctx: TemplateImportContext, sources: readonly TemplateSource[], version: string): number {
  const repository = new TemplateRepository(ctx.db);
  const missing = sources.filter(source => !repository.has(source.slug));
  const augmented = missing.map(source => {
    const parsed = parseAgentDefinitionMarkdown(source.slug, source.markdown);
    const metadata = { ...parsed.metadata, personaPath: "", extensions: { ...parsed.metadata.extensions, source: "builtin", version } };
    return { ...source, markdown: renderTemplateMarkdown(metadata, parsed.body) };
  });
  importAgentTemplates(ctx, augmented);
  return augmented.length;
}
