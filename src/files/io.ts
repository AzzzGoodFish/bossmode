import { readdirSync, statSync, mkdirSync, closeSync, fsyncSync, openSync, lstatSync, chmodSync, existsSync, linkSync, unlinkSync, createReadStream, copyFileSync, writeFileSync, readFileSync, renameSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, parse, join, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { checkPath } from "../kernel/path.js";

/** Ensure a directory exists without consulting application configuration or SQL. */
export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}


/** Retry-visible entries may come from a failed earlier fsync, not durable state. */
export function syncDirectoryChain(path: string, boundary = parse(resolve(path)).root): void {
  let cursor = resolve(path);
  const stop = resolve(boundary);
  const rel = relative(stop, cursor);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Directory sync boundary does not contain path");
  for (;;) {
    syncPath(cursor);
    if (cursor === stop) return;
    cursor = dirname(cursor);
  }
}

/** Reject traversal and symlink parents before touching a managed destination. */
export function managedPath(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes("\0")) throw new Error("Invalid upgrade-relative path");
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith("../") || rel !== name) throw new Error("Upgrade path must be canonical and stay within data root");
  let cursor = root;
  for (const part of rel.split("/")) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Upgrade path contains a symlink: ${rel}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}

export function ensurePrivateDirectory(path: string): void {
  const missing: string[] = [];
  let cursor = resolve(path);
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe upgrade directory");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      cursor = dirname(cursor);
    }
  }
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { mode: 0o700 });
    syncPath(directory);
    syncPath(dirname(directory));
  }
  chmodSync(path, 0o700);
  syncDirectoryChain(path);
}

/** Publish a complete asset without ever replacing pre-existing user content. */
export function publishAssetDurably(source: string, destination: string): void {
  const directory = dirname(destination);
  ensurePrivateDirectory(directory);
  const temporary = join(directory, `.upgrade-${randomUUID()}.tmp`);
  try {
    copyDurably(source, temporary);
    // link is atomic and fails on an existing target; rename would overwrite it.
    linkSync(temporary, destination);
    syncPath(directory);
  } finally {
    if (existsSync(temporary)) { unlinkSync(temporary); syncPath(directory); }
  }
}

export function requireRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Upgrade source must be a regular file");
}

export async function hashFile(path: string): Promise<string> {
  requireRegularFile(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function copyDurably(source: string, destination: string): void {
  requireRegularFile(source);
  ensurePrivateDirectory(dirname(destination));
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  syncPath(destination);
  syncPath(dirname(destination));
}

export function writeDurably(path: string, bytes: Uint8Array): void {
  ensurePrivateDirectory(dirname(path));
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  syncPath(dirname(path));
}

export function moveDurably(source: string, destination: string): void {
  ensurePrivateDirectory(dirname(destination));
  renameSync(source, destination);
  syncPath(dirname(source));
  if (dirname(source) !== dirname(destination)) syncPath(dirname(destination));
}

export type DirectoryListing =
  | { ok: true; path: string; parent: string | null; segments: Array<{ name: string; path: string }>; dirs: Array<{ name: string; path: string }>; truncated: boolean }
  | { ok: false; code: "outside" | "not_found" | "not_directory"; error: string };

export function browseDirectories(root: string, requested = root, limit = 200): DirectoryListing {
  const boundary = resolve(root);
  const expanded = requested.replace(/^~(\/|$)/, boundary + "$1");
  const path = resolve(expanded), rel = relative(boundary, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { ok: false, code: "outside", error: "Path must be within home directory" };
  }
  if (!existsSync(path)) return { ok: false, code: "not_found", error: "Directory not found" };
  if (!statSync(path).isDirectory()) return { ok: false, code: "not_directory", error: "Path is not a directory" };
  const all = readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => ({ name: entry.name, path: join(path, entry.name) })).sort((a, b) => a.name.localeCompare(b.name));
  const segments = [{ name: boundary.slice(dirname(boundary).length + 1) || boundary, path: boundary }];
  let cursor = boundary;
  for (const part of rel.split(sep).filter(Boolean)) { cursor = join(cursor, part); segments.push({ name: part, path: cursor }); }
  return { ok: true, path, parent: path === boundary ? null : dirname(path), segments, dirs: all.slice(0, limit), truncated: all.length > limit };
}

export type LocatedFile =
  | { ok: true; path: string; size: number }
  | { ok: false; code: "not_found" | "invalid"; error: string };

/** Resolve the first existing candidate under an allowlisted real root. */
export function locateReadableFile(candidates: string[], allowedRoots: string[], maxSizeBytes?: number): LocatedFile {
  const roots = allowedRoots.flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } });
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    const checked = checkPath(candidate, { allowedPrefixes: roots, maxSizeBytes });
    if (!checked.ok) return { ok: false, code: "invalid", error: checked.error };
    return { ok: true, path: checked.absolutePath, size: checked.size };
  }
  return { ok: false, code: "not_found", error: "File not found" };
}

export function readFileBytes(path: string): Buffer { return readFileSync(path); }
export function openFileStream(path: string) { return createReadStream(path); }

/** Presence hint only; inaccessible entries do not become readable through this inspection. */
export function directoryHasReadableEntries(directory: string): boolean {
  try {
    return readdirSync(directory).some(name => {
      try { const entry = statSync(join(directory, name)); return entry.isFile() || entry.isDirectory(); }
      catch { return false; }
    });
  } catch { return false; }
}
