import { homedir } from "node:os";
import { extname } from "node:path";
import { attachmentLocation, resolveConversation } from "../chat/conversations.js";
import {
  inferAttachmentPreviewType,
  locateAttachment,
  storeAttachment,
  type AttachmentLocation,
} from "../files/attachments.js";
import { browseDirectories, openFileStream, readFileBytes } from "../files/io.js";
import { readArtifactPreview, resolveArtifact } from "../app/artifact-actions.js";
import { addRoute, requestUrl, sendJson } from "./http.js";

const HOME = homedir();
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".txt": "text/plain",
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".json": "application/json",
  ".csv": "text/csv", ".zip": "application/zip",
};
function mime(filename: string): string { return MIME[extname(filename).toLowerCase()] || "application/octet-stream"; }
addRoute("GET", "/api/fs/list-dirs", async (request, response) => {
  const result = browseDirectories(HOME, requestUrl(request).searchParams.get("path") || HOME);
  if (!result.ok) {
    const status = result.code === "outside" ? 403 : result.code === "not_found" ? 404 : 400;
    return sendJson(response, status, { error: result.error });
  }
  const { ok: _ok, ...listing } = result;
  sendJson(response, 200, listing);
});

function conversationLocation(scope: string): { scopeId: string; location: AttachmentLocation } | null {
  const ref = resolveConversation(scope);
  if (!ref) return null;
  return { scopeId: ref.scopeId, location: attachmentLocation(ref) };
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
      storedFilename: stored.storedFilename, originalFilename: stored.originalFilename, size: stored.size,
      url: attachmentUrl(scopeId, stored.storedFilename), previewType: inferAttachmentPreviewType(stored.originalFilename),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, message.includes("too large") ? 413 : 500, { error: message });
  }
}
function download(response: Parameters<typeof sendJson>[0], location: AttachmentLocation, filename: string): void {
  const file = locateAttachment(location, filename);
  if (!file.ok) return sendJson(response, file.code === "not_found" ? 404 : 400, { error: file.code === "not_found" ? "Attachment not found" : file.error });
  response.writeHead(200, { "Content-Type": mime(filename), "Content-Length": file.size,
    "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
  openFileStream(file.path).pipe(response);
}
function preview(response: Parameters<typeof sendJson>[0], scopeId: string, location: AttachmentLocation, filename: string): void {
  const file = locateAttachment(location, filename);
  if (!file.ok) return sendJson(response, file.code === "not_found" ? 404 : 400, { error: file.code === "not_found" ? "Attachment not found" : file.error });
  const type = inferAttachmentPreviewType(filename);
  if (type === "download") return sendJson(response, 400, { error: "Attachment is download-only" });
  if (file.size > MAX_PREVIEW_BYTES) return sendJson(response, 413, { error: "Attachment preview is too large" });
  sendJson(response, 200, { type: type === "markdown" ? "md" : type, originalPath: filename, path: filename, title: filename,
    content: type === "image" ? attachmentUrl(scopeId, filename) : readFileBytes(file.path).toString("utf8") });
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

addRoute("GET", "/api/rooms/:id/artifact-raw", async (request, response, params) => {
  const original = requestUrl(request).searchParams.get("path")?.trim() || "";
  const artifact = resolveArtifact(params.id, original);
  if (!artifact.ok) return sendJson(response, artifact.status, { error: artifact.error });
  response.writeHead(200, {
    "Content-Type": mime(artifact.path), "Content-Length": artifact.size,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  });
  openFileStream(artifact.path).pipe(response);
});
addRoute("GET", "/api/rooms/:id/artifact-preview", async (request, response, params) => {
  const original = requestUrl(request).searchParams.get("path")?.trim() || "";
  const artifact = readArtifactPreview(params.id, original);
  if (!artifact.ok) return sendJson(response, artifact.status, { error: artifact.error });
  const { ok: _ok, content, ...preview } = artifact;
  sendJson(response, 200, { ...preview,
    content: Buffer.isBuffer(content) ? `data:${mime(artifact.path)};base64,${content.toString("base64")}` : content });
});
