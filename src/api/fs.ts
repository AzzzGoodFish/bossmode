// Filesystem API — safe directory listing for the FolderPicker UI component
//
// Endpoints:
//   GET /api/fs/list-dirs?path=<absolute-path>
//     Returns immediate subdirectories of the given path (folders only).
//     The path must reside within the user's home directory.
//
// Response:
//   {
//     "path": "/home/fish/dev",
//     "parent": "/home/fish",
//     "segments": [{ "name": "fish", "path": "/home/fish" }, ...],
//     "dirs": [{ "name": "bossmode", "path": "/home/fish/dev/bossmode" }, ...]
//   }

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { addRoute, sendJson } from "./index.js";
import { logger } from "../foundation/logger.js";

const HOME = homedir();

/** Build path segments for breadcrumb (from home down to currentPath). */
function buildSegments(absPath: string): Array<{ name: string; path: string }> {
  // Only show segments from home downward
  if (!absPath.startsWith(HOME)) return [];

  const segments: Array<{ name: string; path: string }> = [];

  // Build from home to current
  let cursor = HOME;
  const homeParent = dirname(HOME);
  const homeName = HOME.slice(homeParent.length + 1) || HOME;
  segments.push({ name: homeName, path: HOME });

  const relative = absPath.slice(HOME.length);
  const parts = relative.split(sep).filter(Boolean);
  for (const part of parts) {
    cursor = join(cursor, part);
    segments.push({ name: part, path: cursor });
  }

  return segments;
}

addRoute("GET", "/api/fs/list-dirs", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const rawPath = (url.searchParams.get("path") || HOME).replace(/^~(\/|$)/, HOME + "$1");

  // Resolve to absolute and validate it's inside home
  const absPath = resolve(rawPath);
  if (!absPath.startsWith(HOME + sep) && absPath !== HOME) {
    logger.warn("fs-api", "path outside home rejected", { path: rawPath, absPath });
    sendJson(res, 403, { error: "Path must be within home directory" });
    return;
  }

  if (!existsSync(absPath)) {
    sendJson(res, 404, { error: "Directory not found" });
    return;
  }

  const stat = statSync(absPath);
  if (!stat.isDirectory()) {
    sendJson(res, 400, { error: "Path is not a directory" });
    return;
  }

  const parentPath = absPath === HOME ? null : dirname(absPath);

  // List immediate subdirectories (skip hidden by default unless explicitly showing dotfiles)
  const dirs: Array<{ name: string; path: string }> = [];
  const LIMIT = 200;

  try {
    const entries = readdirSync(absPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      dirs.push({ name: entry.name, path: join(absPath, entry.name) });
      if (dirs.length >= LIMIT) break;
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err: any) {
    logger.warn("fs-api", "readdir failed", { path: absPath, error: String(err) });
    sendJson(res, 500, { error: "Failed to read directory" });
    return;
  }

  sendJson(res, 200, {
    path: absPath,
    parent: parentPath,
    segments: buildSegments(absPath),
    dirs,
    truncated: dirs.length >= LIMIT,
  });
});
