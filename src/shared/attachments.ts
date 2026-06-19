export type AttachmentPreviewType = "image" | "markdown" | "html" | "download";

export interface RoomMessageAttachment {
  id: string;
  storedFilename: string;
  originalFilename: string;
  size?: number;
  mime?: string;
  previewType: AttachmentPreviewType;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const MARKDOWN_EXTS = new Set([".md", ".markdown"]);
const HTML_EXTS = new Set([".html", ".htm"]);

export function filenameExt(filename: string): string {
  const clean = String(filename || "").split(/[\\/]/).pop() || "";
  const idx = clean.lastIndexOf(".");
  return idx >= 0 ? clean.slice(idx).toLowerCase() : "";
}

export function inferAttachmentPreviewType(filename: string): AttachmentPreviewType {
  const ext = filenameExt(filename);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  return "download";
}

export function displayFilename(filename: string): string {
  const clean = String(filename || "").split(/[\\/]/).pop() || "attachment";
  return clean.replace(/[\r\n]/g, " ").trim() || "attachment";
}
