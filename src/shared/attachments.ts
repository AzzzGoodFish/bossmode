export type AttachmentPreviewType = "image" | "markdown" | "html" | "text" | "download";

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
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh", ".bash", ".json", ".yaml", ".yml",
  ".toml", ".xml", ".css", ".scss", ".sql", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs",
  ".rb", ".php", ".swift", ".kt", ".vue", ".ini", ".conf", ".cfg", ".env", ".properties",
  ".diff", ".patch", ".csv", ".tsv", ".log", ".proto", ".txt
]);
const TEXT_FILENAMES = new Set([
  "dockerfile", "makefile", ".gitignore", ".dockerignore",
]);

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
  if (TEXT_EXTS.has(ext)) return "text";
  // Special-case files with no extension or dotfile names.
  const base = (String(filename || "").split(/[\\/]/).pop() || "").toLowerCase();
  if (TEXT_FILENAMES.has(base)) return "text";
  return "download";
}

export function displayFilename(filename: string): string {
  const clean = String(filename || "").split(/[\\/]/).pop() || "attachment";
  return clean.replace(/[\r\n]/g, " ").trim() || "attachment";
}
