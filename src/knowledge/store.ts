// Single-namespace Knowledge store (0.8.0)
// =========================================
// All documents live under a single global root:
//
//     ~/.bossmode/knowledge/docs/
//         ├── rules/dev-team-protocol.md      (seeded default)
//         ├── bossmode/
//         │   ├── rules/...
//         │   ├── architecture/...
//         │   └── ...
//         ├── freeu/
//         │   └── ...
//         └── ...
//
// The previous per-KB container (0.7.0) has been removed. Users organize
// projects by top-level folders. Rooms reference documents by path via
// `ruleDocs: string[]` to control which are injected as rules.
//
// Each document is a Markdown file with optional YAML frontmatter:
//
//     ---
//     title: Nice Display Title
//     author: architect
//     created: 2026-04-20T10:00:00Z
//     ---
//
//     # Markdown body...
//
// Document ID = path relative to docs/, e.g. "bossmode/architecture/overview.md".
// Hierarchy is expressed by directory structure — no type field, no flat list.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  rmdirSync, unlinkSync, renameSync, statSync, rmSync,
  type Dirent,
} from "node:fs";
import { join, dirname, sep, posix } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import type { KnowledgeEntry, KnowledgeTreeNode } from "../shared/types.js";

/** Resolved at call time so tests can override BOSSMODE_DIR. */
function knowledgeDir(): string { return join(getBossmodeDir(), "knowledge"); }
function docsRoot(): string { return join(knowledgeDir(), "docs"); }

// -- Path helpers --

function ensureDocsRoot(): void {
  const root = docsRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

/**
 * Normalize an incoming document path. Prevents path traversal and returns a
 * path RELATIVE to docs/, using POSIX separators for stable IDs.
 */
function normalizeDocPath(docPath: string): string {
  if (typeof docPath !== "string" || docPath.length === 0) {
    throw new Error("Document path is required");
  }
  const p = docPath.trim().replace(/\\/g, "/");
  if (p.startsWith("/")) throw new Error("Absolute paths are not allowed");
  const parts = p.split("/").filter((x) => x.length > 0);
  if (parts.length === 0) throw new Error("Document path cannot be empty");
  for (const seg of parts) {
    if (seg === "..") throw new Error("Path traversal not allowed");
    if (seg === ".") continue;
    if (!/^[\w\-. ()+,'\u4e00-\u9fff]+$/u.test(seg)) {
      throw new Error(`Invalid path segment: ${seg}`);
    }
  }
  return parts.filter((s) => s !== ".").join("/");
}

function toPosix(p: string): string { return p.split(sep).join(posix.sep); }

/** Resolve a normalized relative path to an absolute filesystem path inside docs/. */
function absDocPath(relativeDocPath: string): string {
  return join(docsRoot(), ...relativeDocPath.split("/"));
}

// -- Frontmatter --

interface ParsedDoc {
  frontmatter: Record<string, string | number>;
  body: string;
}

function parseFrontmatter(raw: string): ParsedDoc {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { frontmatter: {}, body: raw };
  }
  const endIdx = raw.indexOf("\n---", 4);
  if (endIdx < 0) return { frontmatter: {}, body: raw };
  const fmBlock = raw.slice(4, endIdx);
  const rest = raw.slice(endIdx + 4);
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;

  const fm: Record<string, string | number> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val: string | number = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    const asNum = Number(val);
    if (val !== "" && !Number.isNaN(asNum) && /^[0-9]+$/.test(val)) val = asNum;
    fm[key] = val;
  }
  return { frontmatter: fm, body };
}

function serializeFrontmatter(fm: Record<string, string | number>, body: string): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    const val = typeof v === "string" && /[:#]/.test(v) ? JSON.stringify(v) : String(v);
    lines.push(`${k}: ${val}`);
  }
  lines.push("---", "", body.trimStart());
  return lines.join("\n");
}

function deriveTitle(fmTitle: string | number | undefined, pathRel: string): string {
  if (fmTitle !== undefined && String(fmTitle).length > 0) return String(fmTitle);
  const base = pathRel.split("/").pop() || pathRel;
  return base.replace(/\.md$/i, "").replace(/[-_]/g, " ");
}

// -- Document tree --

export function getDocumentTree(): KnowledgeTreeNode {
  ensureDocsRoot();
  return walkDir(docsRoot(), "");
}

function walkDir(absDir: string, relDir: string): KnowledgeTreeNode {
  const name = relDir === "" ? "docs" : relDir.split("/").pop()!;
  const node: KnowledgeTreeNode = { path: relDir, name, kind: "folder", children: [] };
  let entries: Dirent[];
  try { entries = readdirSync(absDir, { withFileTypes: true }) as Dirent[]; } catch { return node; }
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const childAbs = join(absDir, e.name);
    const childRel = relDir === "" ? e.name : `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      node.children!.push(walkDir(childAbs, toPosix(childRel)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      let title = e.name.replace(/\.md$/i, "");
      try {
        const raw = readFileSync(childAbs, "utf-8");
        const { frontmatter } = parseFrontmatter(raw);
        title = deriveTitle(frontmatter.title, childRel);
      } catch { /* ignore */ }
      node.children!.push({ path: toPosix(childRel), name: e.name, kind: "file", title });
    }
  }
  return node;
}

/** Flat list of all documents (used for search and lists that need full content). */
export function listEntries(): KnowledgeEntry[] {
  ensureDocsRoot();
  const root = docsRoot();
  const files: string[] = [];
  (function recur(dir: string, rel: string) {
    let es: Dirent[];
    try { es = readdirSync(dir, { withFileTypes: true }) as Dirent[]; } catch { return; }
    for (const e of es) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) recur(abs, r);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) files.push(toPosix(r));
    }
  })(root, "");

  const entries: KnowledgeEntry[] = [];
  for (const rel of files) {
    const abs = absDocPath(rel);
    try {
      const raw = readFileSync(abs, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const st = statSync(abs);
      entries.push({
        id: rel,
        title: deriveTitle(frontmatter.title, rel),
        content: body,
        source: String(frontmatter.author || frontmatter.source || "user"),
        createdAt: frontmatter.created
          ? typeof frontmatter.created === "number"
            ? frontmatter.created
            : Date.parse(String(frontmatter.created)) || st.ctimeMs
          : st.ctimeMs,
        updatedAt: frontmatter.updated
          ? typeof frontmatter.updated === "number"
            ? frontmatter.updated
            : Date.parse(String(frontmatter.updated)) || st.mtimeMs
          : st.mtimeMs,
      });
    } catch (err) {
      logger.error("knowledge-store", "parse doc failed", { rel, error: String(err) });
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

export function getEntry(entryId: string): KnowledgeEntry | null {
  let rel: string;
  try { rel = normalizeDocPath(entryId); } catch { return null; }
  const abs = absDocPath(rel);
  if (!existsSync(abs)) return null;
  try {
    const raw = readFileSync(abs, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const st = statSync(abs);
    return {
      id: rel,
      title: deriveTitle(frontmatter.title, rel),
      content: body,
      source: String(frontmatter.author || frontmatter.source || "user"),
      createdAt: frontmatter.created
        ? typeof frontmatter.created === "number" ? frontmatter.created : Date.parse(String(frontmatter.created)) || st.ctimeMs
        : st.ctimeMs,
      updatedAt: frontmatter.updated
        ? typeof frontmatter.updated === "number" ? frontmatter.updated : Date.parse(String(frontmatter.updated)) || st.mtimeMs
        : st.mtimeMs,
    };
  } catch { return null; }
}

export function entryExists(docPath: string): boolean {
  try {
    const rel = normalizeDocPath(docPath);
    return existsSync(absDocPath(rel));
  } catch {
    return false;
  }
}

/**
 * Write/overwrite a document. If no extension provided, `.md` is appended.
 * Creates intermediate directories.
 */
export function addEntry(
  title: string,
  content: string,
  source: string,
  path?: string,
  extraFrontmatter?: Record<string, string>,
): KnowledgeEntry {
  ensureDocsRoot();

  const rel = path
    ? ensureMdExtension(normalizeDocPath(path))
    : `misc/${slugify(title)}.md`;
  const abs = absDocPath(rel);
  mkdirSync(dirname(abs), { recursive: true });

  const now = Date.now();
  const fm: Record<string, string | number> = {
    title,
    author: source,
    created: now,
    updated: now,
  };
  if (extraFrontmatter) Object.assign(fm, extraFrontmatter);
  writeFileSync(abs, serializeFrontmatter(fm, content), "utf-8");

  return { id: rel, title, content, source, createdAt: now, updatedAt: now };
}

export function updateEntry(
  entryId: string,
  title: string,
  content: string,
  extraFrontmatter?: Record<string, string>,
): KnowledgeEntry | null {
  let rel: string;
  try { rel = normalizeDocPath(entryId); } catch { return null; }
  const abs = absDocPath(rel);
  if (!existsSync(abs)) return null;
  const raw = readFileSync(abs, "utf-8");
  const { frontmatter } = parseFrontmatter(raw);
  const now = Date.now();
  frontmatter.title = title;
  frontmatter.updated = now;
  if (!frontmatter.created) frontmatter.created = now;
  if (extraFrontmatter) Object.assign(frontmatter, extraFrontmatter);
  writeFileSync(abs, serializeFrontmatter(frontmatter, content), "utf-8");
  return {
    id: rel,
    title,
    content,
    source: String(frontmatter.author || frontmatter.source || "user"),
    createdAt: typeof frontmatter.created === "number"
      ? frontmatter.created
      : Date.parse(String(frontmatter.created)) || now,
    updatedAt: now,
  };
}

export function deleteEntry(entryId: string): boolean {
  let rel: string;
  try { rel = normalizeDocPath(entryId); } catch { return false; }
  const abs = absDocPath(rel);
  if (!existsSync(abs)) return false;
  unlinkSync(abs);
  cleanupEmptyParentDirs(dirname(abs));
  return true;
}

/** Move/rename a document. Updates timestamps. */
export function moveEntry(fromId: string, toId: string): KnowledgeEntry | null {
  let fromRel: string, toRel: string;
  try {
    fromRel = normalizeDocPath(fromId);
    toRel = ensureMdExtension(normalizeDocPath(toId));
  } catch { return null; }
  const fromAbs = absDocPath(fromRel);
  const toAbs = absDocPath(toRel);
  if (!existsSync(fromAbs)) return null;
  if (existsSync(toAbs) && fromRel !== toRel) return null; // don't overwrite
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  cleanupEmptyParentDirs(dirname(fromAbs));
  return getEntry(toRel);
}

export function moveFolder(
  fromPath: string,
  toPath: string,
): { ok: boolean; movedFiles: Array<[string, string]>; error?: string } {
  let fromRel: string, toRel: string;
  try {
    fromRel = normalizeDocPath(fromPath);
    toRel = normalizeDocPath(toPath);
  } catch (err: any) {
    return { ok: false, movedFiles: [], error: String(err?.message || err) };
  }

  if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
    return { ok: false, movedFiles: [], error: "Cannot move folder into itself or its subfolder" };
  }

  const fromAbs = absDocPath(fromRel);
  const toAbs = absDocPath(toRel);
  if (!existsSync(fromAbs) || !statSync(fromAbs).isDirectory()) {
    return { ok: false, movedFiles: [], error: "Source folder not found" };
  }
  if (existsSync(toAbs)) {
    return { ok: false, movedFiles: [], error: "Destination already exists" };
  }

  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);

  const movedFiles: Array<[string, string]> = [];
  for (const newPath of collectDocPathsInFolder(toAbs, toRel)) {
    const suffix = newPath.startsWith(`${toRel}/`) ? newPath.slice(toRel.length + 1) : "";
    const oldPath = suffix ? `${fromRel}/${suffix}` : fromRel;
    movedFiles.push([oldPath, newPath]);
  }

  cleanupEmptyParentDirs(dirname(fromAbs));
  return { ok: true, movedFiles };
}

export function deleteFolder(
  folderPath: string,
): { ok: boolean; deletedCount: number; deletedPaths: string[] } {
  let rel: string;
  try {
    rel = normalizeDocPath(folderPath);
  } catch {
    return { ok: false, deletedCount: 0, deletedPaths: [] };
  }

  const abs = absDocPath(rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    return { ok: false, deletedCount: 0, deletedPaths: [] };
  }

  const deletedPaths = collectDocPathsInFolder(abs, rel);
  rmSync(abs, { recursive: true, force: true });
  cleanupEmptyParentDirs(dirname(abs));

  return { ok: true, deletedCount: deletedPaths.length, deletedPaths };
}

/**
 * Search documents by substring (case-insensitive) in title or content.
 * Returns matches with full content.
 */
export function searchEntries(query: string): KnowledgeEntry[] {
  const q = query.toLowerCase();
  return listEntries().filter((e) =>
    e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q),
  );
}

// -- Helpers --

function ensureMdExtension(path: string): string {
  if (path.toLowerCase().endsWith(".md")) return path;
  return `${path}.md`;
}

function cleanupEmptyParentDirs(startDir: string): void {
  try {
    const root = docsRoot();
    let d = startDir;
    while (d !== root && d !== dirname(d)) {
      const remaining = readdirSync(d);
      if (remaining.length > 0) break;
      rmdirSync(d);
      d = dirname(d);
    }
  } catch {
    // best-effort cleanup only
  }
}

function collectDocPathsInFolder(absFolder: string, relPrefix: string): string[] {
  const out: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }

    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childAbs = join(absDir, e.name);
      const childRel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(childAbs, childRel);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        out.push(toPosix(childRel));
      }
    }
  };

  walk(absFolder, relPrefix);
  return out;
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "-")
    .replace(/[^\w\-.\u4e00-\u9fff]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || `doc-${Date.now()}`;
}

/** Re-export path helpers for migration / external callers. */
export const _internal = { normalizeDocPath, docsRoot, absDocPath };
