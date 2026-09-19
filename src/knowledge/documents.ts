// Project-memory Knowledge store (identity batch 2.5)
// =========================================
// All documents live under the shared project-memory root:
//
//     ~/.bossmode/memory/projects/
//
// Document ID = path relative to that root, e.g. "bossmode/architecture/overview.md".
// Hierarchy is directory structure. Physical migrate from knowledge/docs is batch 3.

import { documentsRoot as docsRoot } from "../files/layout.js";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  rmdirSync, unlinkSync, renameSync, statSync, rmSync,
  type Dirent,
} from "node:fs";
import { join, dirname, sep, posix, extname, basename } from "node:path";

import { logger } from "../kernel/logger.js";
export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}
export interface KnowledgeTreeNode {
  path: string;
  name: string;
  kind: "file" | "folder";
  title?: string;
  children?: KnowledgeTreeNode[];
}

const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".html", ".htm", ".txt", ".json"]);
const BINARY_EXTENSIONS = new Set([".png"]);
const MAX_PNG_BYTES = 512 * 1024;

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

function extensionOf(pathRel: string): string {
  return extname(pathRel).toLowerCase();
}

function isAllowedFile(pathRel: string): boolean {
  const ext = extensionOf(pathRel);
  return TEXT_EXTENSIONS.has(ext) || BINARY_EXTENSIONS.has(ext);
}

function isTextFile(pathRel: string): boolean {
  const ext = extensionOf(pathRel);
  return TEXT_EXTENSIONS.has(ext);
}

function contentTypeForPath(pathRel: string): string {
  const ext = extensionOf(pathRel);
  if (ext === ".png") return "image/png";
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".md" || ext === ".markdown") return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function filenameTitle(pathRel: string): string {
  const base = basename(pathRel);
  return base.replace(/\.[^.]+$/i, "").replace(/[-_]/g, " ");
}

function deriveTitleFromContent(content: string, pathRel: string): string {
  const heading = content.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  return heading || filenameTitle(pathRel);
}
function describeEntry(rel: string, content: string, source = "user"): KnowledgeEntry {
  const stat = statSync(absDocPath(rel));
  return { id: rel, title: deriveTitleFromContent(content, rel), content, source, createdAt: stat.ctimeMs, updatedAt: stat.mtimeMs };
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
    } else if (e.isFile() && isAllowedFile(childRel)) {
      let title = filenameTitle(childRel);
      try {
        if (isTextFile(childRel)) title = deriveTitleFromContent(readFileSync(childAbs, "utf-8"), childRel);
      } catch { /* ignore */ }
      node.children!.push({ path: toPosix(childRel), name: e.name, kind: "file", title });
    }
  }
  return node;
}

/** Flat list of all documents (used for search and lists that need full content). */
export function listEntries(): KnowledgeEntry[] {
  ensureDocsRoot();
  const entries: KnowledgeEntry[] = [];
  for (const rel of collectDocPathsInFolder(docsRoot(), "")) {
    const abs = absDocPath(rel);
    try {
      const content = isTextFile(rel) ? readFileSync(abs, "utf-8") : "";
      entries.push(describeEntry(rel, content));
    } catch (err) {
      logger.error("knowledge-store", "read doc failed", { rel, error: String(err) });
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

export function getEntry(entryId: string): KnowledgeEntry | null {
  let rel: string;
  try { rel = normalizeDocPath(entryId); } catch { return null; }
  if (!isAllowedFile(rel) || !isTextFile(rel)) return null;
  const abs = absDocPath(rel);
  if (!existsSync(abs)) return null;
  try {
    const content = readFileSync(abs, "utf-8");
    return describeEntry(rel, content);
  } catch { return null; }
}

export function getRawEntry(entryId: string): { path: string; contentType: string; data: Buffer } | null {
  let rel: string;
  try { rel = normalizeDocPath(entryId); } catch { return null; }
  if (!isAllowedFile(rel)) return null;
  const abs = absDocPath(rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return { path: rel, contentType: contentTypeForPath(rel), data: readFileSync(abs) };
}

/**
 * Write/overwrite a text document. If no extension is provided, `.md` is appended.
 * Creates intermediate directories. Frontmatter is not injected or parsed.
 */
export function addEntry(
  title: string,
  content: string,
  source: string,
  path?: string,
  _extraFrontmatter?: Record<string, string>,
): KnowledgeEntry {
  ensureDocsRoot();

  const rel = path
    ? ensureDefaultExtension(normalizeDocPath(path))
    : `misc/${slugify(title)}.md`;
  if (!isTextFile(rel)) throw new Error("Only text documents can be edited as entries");
  const abs = absDocPath(rel);
  mkdirSync(dirname(abs), { recursive: true });

  writeFileSync(abs, content, "utf-8");
  return describeEntry(rel, content, source);
}

export function updateEntry(
  entryId: string,
  _title: string,
  content: string,
  _extraFrontmatter?: Record<string, string>,
): KnowledgeEntry | null {
  let rel: string;
  try { rel = normalizeDocPath(entryId); } catch { return null; }
  if (!isTextFile(rel)) return null;
  const abs = absDocPath(rel);
  if (!existsSync(abs)) return null;
  writeFileSync(abs, content, "utf-8");
  return describeEntry(rel, content);
}

export function writePngEntry(docPath: string, data: Buffer): KnowledgeEntry {
  ensureDocsRoot();
  const rel = normalizeDocPath(docPath);
  if (extensionOf(rel) !== ".png") throw new Error("Only .png uploads are supported");
  if (data.length === 0) throw new Error("PNG upload is empty");
  if (data.length > MAX_PNG_BYTES) throw new Error(`PNG upload too large (max ${MAX_PNG_BYTES} bytes)`);
  if (!data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("Invalid PNG file");
  }
  const abs = absDocPath(rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return describeEntry(rel, "");
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
    toRel = ensureMoveExtension(fromRel, normalizeDocPath(toId));
  } catch { return null; }
  if (!isAllowedFile(fromRel) || !isAllowedFile(toRel)) return null;
  const fromAbs = absDocPath(fromRel);
  const toAbs = absDocPath(toRel);
  if (!existsSync(fromAbs)) return null;
  if (existsSync(toAbs) && fromRel !== toRel) return null; // don't overwrite
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  cleanupEmptyParentDirs(dirname(fromAbs));
  return isTextFile(toRel) ? getEntry(toRel) : describeEntry(toRel, "");
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

// -- Helpers --

function ensureDefaultExtension(path: string): string {
  if (extensionOf(path)) return path;
  return `${path}.md`;
}

function ensureMoveExtension(fromPath: string, toPath: string): string {
  if (extensionOf(toPath)) return toPath;
  const ext = extensionOf(fromPath) || ".md";
  return `${toPath}${ext}`;
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
  let entries: Dirent[];
  try { entries = readdirSync(absFolder, { withFileTypes: true }) as Dirent[]; } catch { return []; }
  return entries.flatMap(entry => {
    if (entry.name.startsWith(".")) return [];
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return collectDocPathsInFolder(join(absFolder, entry.name), rel);
    return entry.isFile() && isAllowedFile(rel) ? [toPosix(rel)] : [];
  });
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
