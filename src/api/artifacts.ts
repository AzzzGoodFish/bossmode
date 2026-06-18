import { existsSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { addRoute, sendJson } from "./index.js";
import * as knowledgeStore from "../knowledge/store.js";
import * as roomStore from "../workspace/room-store.js";
import { checkPath } from "../shared/path-security.js";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

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

addRoute("GET", "/api/rooms/:id/artifact-preview", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }

  const url = new URL(req.url || "", "http://localhost");
  const rawPath = url.searchParams.get("path") || "";
  const originalPath = rawPath.trim();
  if (!originalPath) { sendJson(res, 400, { error: "path query parameter is required" }); return; }
  if (URL_SCHEME_RE.test(originalPath)) {
    sendJson(res, 400, { error: `Remote URLs are not previewable: ${originalPath}` });
    return;
  }

  const normalized = normalizeArtifactRef(originalPath);
  const ext = extname(normalized.path).toLowerCase();
  if (ext !== ".md" && ext !== ".html") {
    sendJson(res, 400, { error: `Unsupported artifact type: ${originalPath}` });
    return;
  }

  if (ext === ".md") {
    const entry = knowledgeStore.getEntry(normalized.path);
    if (entry) {
      sendJson(res, 200, {
        type: "md",
        originalPath,
        path: entry.id,
        title: entry.title,
        content: entry.content,
      });
      return;
    }
  }

  const allowedPrefixes = [
    safeRealpath(knowledgeStore._internal.docsRoot()),
    safeRealpath(resolve(room.cwd)),
  ].filter((p): p is string => !!p);

  const candidates: string[] = [];
  const docsCandidate = knowledgeStore._internal.absDocPath(normalized.path);
  candidates.push(docsCandidate);
  if (!originalPath.startsWith("/")) {
    candidates.push(resolve(room.cwd, originalPath));
    if (normalized.path !== originalPath) candidates.push(resolve(room.cwd, normalized.path));
  } else {
    candidates.push(originalPath);
  }

  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    const check = checkPath(candidate, { allowedPrefixes, maxSizeBytes: MAX_ARTIFACT_BYTES });
    if (!check.ok) {
      sendJson(res, 400, { error: `${check.error}: ${originalPath}` });
      return;
    }
    const content = readFileSync(check.absolutePath, "utf8");
    sendJson(res, 200, {
      type: ext === ".html" ? "html" : "md",
      originalPath,
      path: normalized.path,
      title: fileTitle(normalized.path),
      content,
    });
    return;
  }

  sendJson(res, 404, { error: `Artifact not found: ${originalPath}` });
});
