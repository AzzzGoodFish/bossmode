import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { getRoom, parseConversation, roomMemberAssetRoots } from "../chat/conversations.js";
import {
  attachmentExists,
  getAttachmentPath,
  inferAttachmentPreviewType,
  storeAttachment,
  type AttachmentLocation,
} from "../files/attachments.js";
import { checkPath } from "../kernel/path.js";
import * as knowledgeStore from "../knowledge/documents.js";
import { getMember } from "../member/identity.js";
import { addRoute, requestUrl, sendJson } from "./http.js";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain",
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".json": "application/json",
  ".csv": "text/csv", ".zip": "application/zip",
};
function mime(filename: string): string { return MIME[extname(filename).toLowerCase()] || "application/octet-stream"; }
function conversationLocation(raw: string): { scopeId: string; location: AttachmentLocation } | null {
  let scope: string;
  try { scope = decodeURIComponent(raw); } catch { return null; }
  const ref = parseConversation(scope);
  if (!ref) return null;
  if (ref.kind === "room") return getRoom(ref.roomId) ? { scopeId: ref.scopeId, location: { kind: "room", roomId: ref.roomId } } : null;
  if (ref.kind === "dm") return getMember(ref.memberId) ? { scopeId: ref.scopeId, location: { kind: "dm", memberId: ref.memberId } } : null;
  return ref.memberIds.every(id => getMember(id)) ? { scopeId: ref.scopeId, location: { kind: "mm", memberIds: ref.memberIds } } : null;
}
function attachmentUrl(scopeId: string, filename: string): string {
  return `/api/conversations/${encodeURIComponent(scopeId)}/attachments/${encodeURIComponent(filename)}`;
}
async function upload(request: Parameters<typeof requestUrl>[0] & NodeJS.ReadableStream, response: Parameters<typeof sendJson>[0], scopeId: string, location: AttachmentLocation): Promise<void> {
  const originalFilename = requestUrl(request).searchParams.get("filename");
  if (!originalFilename) return sendJson(response, 400, { error: "filename query parameter is required" });
  try {
    const stored = await storeAttachment(request as import("node:stream").Readable, location, originalFilename);
    if (!stored.size) return sendJson(response, 400, { error: "Empty file" });
    sendJson(response, 200, {
      filename: stored.storedFilename, originalFilename: stored.originalFilename, path: stored.storedFilename, size: stored.size,
      url: attachmentUrl(scopeId, stored.storedFilename), previewType: inferAttachmentPreviewType(stored.originalFilename),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, message.includes("too large") ? 413 : 500, { error: message });
  }
}
function download(response: Parameters<typeof sendJson>[0], location: AttachmentLocation, filename: string): void {
  if (!attachmentExists(location, filename)) return sendJson(response, 404, { error: "Attachment not found" });
  try {
    const path = getAttachmentPath(location, filename);
    response.writeHead(200, { "Content-Type": mime(filename), "Content-Length": statSync(path).size,
      "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
    createReadStream(path).pipe(response);
  } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
}
function preview(response: Parameters<typeof sendJson>[0], scopeId: string, location: AttachmentLocation, filename: string): void {
  if (!attachmentExists(location, filename)) return sendJson(response, 404, { error: "Attachment not found" });
  const type = inferAttachmentPreviewType(filename);
  if (type === "download") return sendJson(response, 400, { error: "Attachment is download-only" });
  const path = getAttachmentPath(location, filename);
  if (statSync(path).size > MAX_PREVIEW_BYTES) return sendJson(response, 413, { error: "Attachment preview is too large" });
  sendJson(response, 200, { type: type === "markdown" ? "md" : type, originalPath: filename, path: filename, title: filename,
    content: type === "image" ? attachmentUrl(scopeId, filename) : readFileSync(path, "utf8") });
}

addRoute("POST", "/api/conversations/:scope/attachments", async (request, response, params) => {
  const target = conversationLocation(params.scope);
  if (!target) return sendJson(response, 404, { error: "Conversation not found" });
  await upload(request, response, target.scopeId, target.location);
});
addRoute("GET", "/api/conversations/:scope/attachments/:filename", async (_request, response, params) => {
  const target = conversationLocation(params.scope);
  if (!target) return sendJson(response, 404, { error: "Conversation not found" });
  download(response, target.location, params.filename);
});
addRoute("GET", "/api/conversations/:scope/attachments/:filename/preview", async (_request, response, params) => {
  const target = conversationLocation(params.scope);
  if (!target) return sendJson(response, 404, { error: "Conversation not found" });
  preview(response, target.scopeId, target.location, params.filename);
});

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".bash", ".json", ".yaml", ".yml",
  ".toml", ".xml", ".css", ".scss", ".sql", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs",
  ".rb", ".php", ".swift", ".kt", ".vue", ".ini", ".conf", ".cfg", ".env", ".properties",
  ".diff", ".patch", ".csv", ".tsv", ".log", ".proto", ".txt",
]);
const TEXT_FILENAMES = new Set(["dockerfile", "makefile", ".gitignore", ".dockerignore"]);
type ArtifactType = "md" | "html" | "image" | "text";
function artifactType(path: string): ArtifactType | null {
  const extension = extname(path).toLowerCase();
  if ([".md", ".markdown"].includes(extension)) return "md";
  if ([".html", ".htm"].includes(extension)) return "html";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) return "image";
  if (TEXT_EXTENSIONS.has(extension) || TEXT_FILENAMES.has((path.split(/[\\/]/).pop() || "").toLowerCase())) return "text";
  return null;
}
function real(path: string): string | null { try { return realpathSync(path); } catch { return null; } }
function resolveArtifact(roomId: string, originalPath: string): { path: string; type: ArtifactType; size: number; normalized: string } | { error: string; status: number } {
  if (!originalPath) return { error: "path query parameter is required", status: 400 };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(originalPath)) return { error: "Remote URLs are not previewable", status: 400 };
  const normalized = originalPath.trim().replace(/^docs\//, "");
  const type = artifactType(normalized);
  if (!type) return { error: `Unsupported artifact type: ${originalPath}`, status: 400 };
  const roots = roomMemberAssetRoots(roomId);
  const allowed = [real(knowledgeStore._internal.docsRoot()), ...roots.map(real)].filter((value): value is string => Boolean(value));
  const candidates = [knowledgeStore._internal.absDocPath(normalized), ...roots.map((root) => resolve(root, originalPath))];
  if (originalPath.startsWith("/")) candidates.push(originalPath);
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    const checked = checkPath(candidate, { allowedPrefixes: allowed, maxSizeBytes: MAX_PREVIEW_BYTES });
    if (!checked.ok) return { error: checked.error, status: 400 };
    return { path: checked.absolutePath, size: checked.size, type, normalized };
  }
  return { error: `Artifact not found: ${originalPath}`, status: 404 };
}
addRoute("GET", "/api/rooms/:id/artifact-raw", async (request, response, params) => {
  if (!getRoom(params.id)) return sendJson(response, 404, { error: "Room not found" });
  const original = requestUrl(request).searchParams.get("path")?.trim() || "";
  const artifact = resolveArtifact(params.id, original);
  if ("error" in artifact) return sendJson(response, artifact.status, { error: artifact.error });
  response.writeHead(200, {
    "Content-Type": mime(artifact.path), "Content-Length": artifact.size,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  });
  createReadStream(artifact.path).pipe(response);
});
addRoute("GET", "/api/rooms/:id/artifact-preview", async (request, response, params) => {
  if (!getRoom(params.id)) return sendJson(response, 404, { error: "Room not found" });
  const original = requestUrl(request).searchParams.get("path")?.trim() || "";
  const normalized = original.replace(/^docs\//, "");
  const type = artifactType(normalized);
  if (type && type !== "image") {
    const entry = knowledgeStore.getEntry(normalized);
    if (entry) return sendJson(response, 200, { type, originalPath: original, path: entry.id, title: entry.title, content: entry.content });
  }
  const artifact = resolveArtifact(params.id, original);
  if ("error" in artifact) return sendJson(response, artifact.status, { error: artifact.error });
  sendJson(response, 200, {
    type: artifact.type,
    originalPath: original,
    path: artifact.normalized,
    title: artifact.normalized.split(/[\\/]/).pop() || artifact.normalized,
    content: artifact.type === "image" ? `data:${mime(artifact.path)};base64,${readFileSync(artifact.path).toString("base64")}` : readFileSync(artifact.path, "utf8"),
  });
});
