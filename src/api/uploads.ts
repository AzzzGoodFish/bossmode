// Attachment upload + download routes (extracted from workspace.ts)
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { addRoute, sendJson } from "./index.js";
import * as roomStore from "../workspace/room-store.js";
import * as attachmentStore from "../workspace/attachment-store.js";
import { inferAttachmentPreviewType } from "../shared/attachments.js";

const MAX_ATTACHMENT_PREVIEW_BYTES = 2 * 1024 * 1024;

const ATTACHMENT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
};

// POST /api/rooms/:id/upload — stream-based upload (no memory buffering)
addRoute("POST", "/api/rooms/:id/upload", async (req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }

  const url = new URL(req.url || "", "http://localhost");
  const originalFilename = url.searchParams.get("filename");
  if (!originalFilename) {
    sendJson(res, 400, { error: "filename query parameter is required" });
    return;
  }

  try {
    const stored = await attachmentStore.streamToAttachment(req, params.id, originalFilename);
    if (stored.size === 0) {
      sendJson(res, 400, { error: "Empty file" });
      return;
    }
    sendJson(res, 200, {
      filename: stored.storedFilename,
      originalFilename: stored.originalFilename,
      path: stored.storedFilename,
      size: stored.size,
      url: `/api/rooms/${params.id}/attachments/${stored.storedFilename}`,
      previewType: inferAttachmentPreviewType(stored.storedFilename),
    });
  } catch (err: any) {
    const isSize = String(err?.message || "").includes("too large");
    sendJson(res, isSize ? 413 : 500, { error: err.message || String(err) });
  }
});

// POST /api/dm/:memberId/upload — DM attachment upload (member-owned storage).
addRoute("POST", "/api/dm/:memberId/upload", async (req, res, params) => {
  const { resolveMemberRef } = await import("../workspace/member-registry.js");
  const member = resolveMemberRef(params.memberId);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }

  const url = new URL(req.url || "", "http://localhost");
  const originalFilename = url.searchParams.get("filename");
  if (!originalFilename) {
    sendJson(res, 400, { error: "filename query parameter is required" });
    return;
  }

  try {
    const stored = await attachmentStore.streamToDmAttachment(req, member.id, originalFilename);
    if (stored.size === 0) {
      sendJson(res, 400, { error: "Empty file" });
      return;
    }
    sendJson(res, 200, {
      filename: stored.storedFilename,
      originalFilename: stored.originalFilename,
      path: stored.storedFilename,
      size: stored.size,
      url: `/api/dm/${member.id}/attachments/${stored.storedFilename}`,
      previewType: inferAttachmentPreviewType(stored.storedFilename),
    });
  } catch (err: any) {
    const isSize = String(err?.message || "").includes("too large");
    sendJson(res, isSize ? 413 : 500, { error: err.message || String(err) });
  }
});

// GET /api/dm/:memberId/attachments/:filename — DM attachment download.
addRoute("GET", "/api/dm/:memberId/attachments/:filename", async (_req, res, params) => {
  const { resolveMemberRef } = await import("../workspace/member-registry.js");
  const member = resolveMemberRef(params.memberId);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }

  if (!attachmentStore.dmAttachmentExists(member.id, params.filename)) {
    sendJson(res, 404, { error: "Attachment not found" });
    return;
  }

  let absPath: string;
  try {
    absPath = attachmentStore.getDmAttachmentPath(member.id, params.filename);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const ext = extname(params.filename).toLowerCase();
  const mime = ATTACHMENT_MIME[ext] || "application/octet-stream";
  const size = statSync(absPath).size;

  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": size,
    "Cache-Control": "public, max-age=86400",
  });
  createReadStream(absPath).pipe(res);
});

// GET /api/rooms/:id/attachments/:filename — stream-based download
addRoute("GET", "/api/rooms/:id/attachments/:filename", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }

  if (!attachmentStore.attachmentExists(params.id, params.filename)) {
    sendJson(res, 404, { error: "Attachment not found" });
    return;
  }

  let absPath: string;
  try {
    absPath = attachmentStore.getAttachmentPath(params.id, params.filename);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const ext = extname(params.filename).toLowerCase();
  const mime = ATTACHMENT_MIME[ext] || "application/octet-stream";
  const size = statSync(absPath).size;

  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": size,
    "Cache-Control": "public, max-age=86400",
  });
  createReadStream(absPath).pipe(res);
});

// GET /api/rooms/:id/attachments/:filename/preview — md/html/image read-only preview payload.
// Images use the raw attachment URL; all other types are download-only in v1.
addRoute("GET", "/api/rooms/:id/attachments/:filename/preview", async (_req, res, params) => {
  const room = roomStore.getRoom(params.id);
  if (!room) { sendJson(res, 404, { error: "Room not found" }); return; }

  if (!attachmentStore.attachmentExists(params.id, params.filename)) {
    sendJson(res, 404, { error: "Attachment not found" });
    return;
  }

  let absPath: string;
  try {
    absPath = attachmentStore.getAttachmentPath(params.id, params.filename);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const ext = extname(params.filename).toLowerCase();
  const type = ext === ".md" || ext === ".markdown" ? "md" : ext === ".html" || ext === ".htm" ? "html" : [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext) ? "image" : null;
  if (!type) {
    sendJson(res, 400, { error: "Attachment is download-only" });
    return;
  }

  const size = statSync(absPath).size;
  if (size > MAX_ATTACHMENT_PREVIEW_BYTES) {
    sendJson(res, 413, { error: "Attachment preview is too large" });
    return;
  }

  sendJson(res, 200, {
    type,
    originalPath: params.filename,
    path: params.filename,
    title: params.filename,
    content: type === "image" ? `/api/rooms/${params.id}/attachments/${params.filename}` : readFileSync(absPath, "utf8"),
  });
});
