import { createReadStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { addRoute, sendJson } from "./index.js";
import * as knowledgeStore from "../knowledge/store.js";
import * as roomStore from "../chat/conversations.js";
import { roomMemberAssetRoots } from "../chat/conversations.js";
import { checkPath } from "../kernel/path.js";
import type { Room } from "../kernel/types.js";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const TEXT_ARTIFACT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".bash", ".json", ".yaml", ".yml",
  ".toml", ".xml", ".css", ".scss", ".sql", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs",
  ".rb", ".php", ".swift", ".kt", ".vue", ".ini", ".conf", ".cfg", ".env", ".properties",
  ".diff", ".patch", ".csv", ".tsv", ".log", ".proto", ".txt",
]);
const TEXT_ARTIFACT_FILENAMES = new Set(["dockerfile", "makefile", ".gitignore", ".dockerignore"]);
const ARTIFACT_MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".png": "image/png",
};

function normalizeArtifactRef(input: string): { originalPath: string; path: string; changed: boolean } {
  const originalPath = input;
  const trimmed = input.trim();
  const path = trimmed.replace(/^docs\//, "");
  return { originalPath, path, changed: path !== originalPath };
}

function safeRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function fileTitle(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

type ArtifactFileType = "md" | "html" | "image" | "text";

type ResolvedArtifactFile = {
  originalPath: string;
  path: string;
  ext: string;
  type: ArtifactFileType;
  absolutePath: string;
  size: number;
};

type ArtifactResolveResult =
  | { ok: true; file: ResolvedArtifactFile }
  | { ok: false; status: number; error: string };

function artifactTypeForExt(ext: string): ArtifactFileType | null {
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".png") return "image";
  if (TEXT_ARTIFACT_EXTS.has(ext)) return "text";
  return null;
}

/** Resolve artifact type including special filenames (Dockerfile, Makefile, etc). */
function artifactTypeForFile(filename: string, ext: string): ArtifactFileType | null {
  const byExt = artifactTypeForExt(ext);
  if (byExt) return byExt;
  const base = (filename.split(/[\\/]/).pop() || "").toLowerCase();
  if (TEXT_ARTIFACT_FILENAMES.has(base)) return "text";
  return null;
}

function resolveArtifactFile(room: Room, originalPath: string): ArtifactResolveResult {
  if (!originalPath) return { ok: false, status: 400, error: "path query parameter is required" };
  if (URL_SCHEME_RE.test(originalPath)) return { ok: false, status: 400, error: `Remote URLs are not previewable: ${originalPath}` };

  const normalized = normalizeArtifactRef(originalPath);
  const ext = extname(normalized.path).toLowerCase();
  const type = artifactTypeForFile(normalized.path, ext);
  if (!type) return { ok: false, status: 400, error: `Unsupported artifact type: ${originalPath}` };
  // text type resolves MIME via fallback, not the static ARTIFACT_MIME map.
  if (!ARTIFACT_MIME[ext] && type !== "text") return { ok: false, status: 400, error: `Unsupported artifact type: ${originalPath}` };

  // Batch 7 P3: rooms no longer bind a cwd — relative artifact paths resolve
  // against each room member's home + workspace roots (first hit wins).
  const allowedPrefixes = [
    safeRealpath(knowledgeStore._internal.docsRoot()),
    ...roomMemberAssetRoots(room.id).map((r) => safeRealpath(r)),
  ].filter((p): p is string => !!p);

  const candidates: string[] = [];
  candidates.push(knowledgeStore._internal.absDocPath(normalized.path));
  if (!originalPath.startsWith("/")) {
    for (const root of roomMemberAssetRoots(room.id)) {
      candidates.push(resolve(root, originalPath));
      if (normalized.path !== originalPath) candidates.push(resolve(root, normalized.path));
    }
  } else {
    candidates.push(originalPath);
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    const check = checkPath(candidate, { allowedPrefixes, maxSizeBytes: MAX_ARTIFACT_BYTES });
    if (!check.ok) return { ok: false, status: 400, error: `${check.error}: ${originalPath}` };
    return {
      ok: true,
      file: {
        originalPath,
        path: normalized.path,
        ext,
        type,
        absolutePath: check.absolutePath,
        size: check.size,
      },
    };
  }

  return { ok: false, status: 404, error: `Artifact not found: ${originalPath}` };
}

addRoute("GET", "/api/rooms/:id/artifact-raw", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }

  const url = new URL(req.url || "", "http://localhost");
  const originalPath = (url.searchParams.get("path") || "").trim();
  const resolved = resolveArtifactFile(room, originalPath);
  if (!resolved.ok) { sendJson(res, resolved.status, { error: resolved.error }); return; }

  res.writeHead(200, {
    "Content-Type": ARTIFACT_MIME[resolved.file.ext] || (resolved.file.type === "text" ? "text/plain; charset=utf-8" : "application/octet-stream"),
    "Content-Length": resolved.file.size,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  createReadStream(resolved.file.absolutePath).pipe(res);
});

addRoute("GET", "/api/rooms/:id/artifact-preview", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }

  const url = new URL(req.url || "", "http://localhost");
  const originalPath = (url.searchParams.get("path") || "").trim();
  const normalized = normalizeArtifactRef(originalPath);
  const normalizedType = artifactTypeForFile(normalized.path, extname(normalized.path).toLowerCase());

  if (normalizedType && normalizedType !== "image") {
    const entry = knowledgeStore.getEntry(normalized.path);
    if (entry) {
      sendJson(res, 200, {
        type: normalizedType,
        originalPath,
        path: entry.id,
        title: entry.title,
        content: entry.content,
      });
      return;
    }
  }

  const resolved = resolveArtifactFile(room, originalPath);
  if (!resolved.ok) { sendJson(res, resolved.status, { error: resolved.error }); return; }

  const content = resolved.file.type === "image"
    ? `data:${ARTIFACT_MIME[resolved.file.ext]};base64,${readFileSync(resolved.file.absolutePath).toString("base64")}`
    : readFileSync(resolved.file.absolutePath, "utf8");
  sendJson(res, 200, {
    type: resolved.file.type,
    originalPath,
    path: resolved.file.path,
    title: fileTitle(resolved.file.path),
    content,
  });
});
