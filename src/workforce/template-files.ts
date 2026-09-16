// Historical template import and body inspection only; never a live member source.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { asString, asStringArray } from "../kernel/frontmatter.js";
import type { Database } from "../storage/database.js";
import { TemplateRepository, templateMetadataKeys, validateTemplatePath, validateTemplateSlug, type TemplateMetadata } from "../storage/repositories/templates.js";

export interface ParsedTemplate {
  metadata: Omit<TemplateMetadata, "personaPath">;
  body: string;
}

/** Split only the YAML envelope; retain every persona byte after the closing delimiter. */
export function parseAgentDefinitionMarkdown(slug: string, markdown: string): ParsedTemplate {
  validateTemplateSlug(slug);
  // Zero YAML lines is a valid empty envelope; the closing delimiter owns its newline.
  const match = markdown.match(/^---\r?\n((?:[^\n]*\n)*?)---(?:\r?\n|$)([\s\S]*)$/);
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

export interface TemplateSource {
  /** Historical inventory path; never opened here. */
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
