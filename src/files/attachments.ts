import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logger } from "../kernel/logger.js";
import { checkPath } from "../kernel/path.js";
import { memberChatDir, memberDir, roomDir } from "./layout.js";
import { locateReadableFile, type LocatedFile } from "./io.js";

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
  ".diff", ".patch", ".csv", ".tsv", ".log", ".proto", ".txt",
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

export const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024;

export type AttachmentLocation =
  | { kind: "room"; roomId: string }
  | { kind: "dm"; memberId: string }
  | { kind: "mm"; memberIds: [string, string] };

export interface StoredAttachment {
  storedFilename: string;
  originalFilename: string;
  absolutePath: string;
  size: number;
}

export type AttachmentImportOutcome =
  | ({ ok: true } & StoredAttachment)
  | { ok: false; path: string; error: string };

function attachmentDirectory(location: AttachmentLocation): string {
  if (location.kind === "room") return join(roomDir(location.roomId), "attachments");
  if (location.kind === "dm") return join(memberDir(location.memberId), "dm-attachments");
  return join(memberChatDir(location.memberIds[0], location.memberIds[1]), "attachments");
}

function ensureAttachmentDirectory(location: AttachmentLocation): string {
  const directory = attachmentDirectory(location);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  return directory;
}

function safeStoredFilename(filename: string): string {
  const safe = basename(filename);
  if (safe !== filename || safe.includes("..")) throw new Error("Invalid filename");
  return safe;
}

export async function storeAttachment(
  source: Readable,
  location: AttachmentLocation,
  originalFilename: string,
  maxSize = MAX_UPLOAD_SIZE,
): Promise<StoredAttachment> {
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new Error("Invalid attachment size limit");
  const temporary = join("/tmp", `bossmode-upload-${Date.now()}-${randomBytes(4).toString("hex")}`);
  const hash = createHash("sha256");
  let size = 0;
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxSize) return callback(new Error(`Upload too large (max ${Math.round(maxSize / 1024 / 1024)}MB)`));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, guard, createWriteStream(temporary));
  } catch (error) {
    if (existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* best effort */ } }
    throw error;
  }
  const storedFilename = `${hash.digest("hex").slice(0, 12)}${extname(originalFilename) || ".bin"}`;
  const absolutePath = join(ensureAttachmentDirectory(location), storedFilename);
  if (existsSync(absolutePath)) {
    try { unlinkSync(temporary); } catch { /* best effort */ }
  } else renameSync(temporary, absolutePath);
  logger.info("attachments", "stored", { location, storedFilename, originalFilename, size });
  return { storedFilename, originalFilename, absolutePath, size };
}

/** Validate local paths against host-authorized roots, then copy each file into one attachment store. */
export async function importAttachments(
  paths: string[], location: AttachmentLocation, allowedRoots: string[], maxSize = MAX_UPLOAD_SIZE,
): Promise<AttachmentImportOutcome[]> {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  const allowedPrefixes = allowedRoots.flatMap(root => { try { return [realpathSync(root)]; } catch { return []; } });
  const outcomes: AttachmentImportOutcome[] = [];
  for (const path of paths) {
    const check = checkPath(path, { allowedPrefixes, maxSizeBytes: maxSize });
    if (!check.ok) {
      logger.warn("attachments", "rejected", { path, error: check.error });
      outcomes.push({ ok: false, path, error: check.error });
      continue;
    }
    try {
      outcomes.push({ ok: true, ...await storeAttachment(
        createReadStream(check.absolutePath), location, basename(check.absolutePath), maxSize) });
    } catch (error) {
      outcomes.push({ ok: false, path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

export function getAttachmentPath(location: AttachmentLocation, storedFilename: string): string {
  return join(attachmentDirectory(location), safeStoredFilename(storedFilename));
}

export function locateAttachment(location: AttachmentLocation, storedFilename: string, maxSizeBytes?: number): LocatedFile {
  try {
    return locateReadableFile([getAttachmentPath(location, storedFilename)], [attachmentDirectory(location)], maxSizeBytes);
  } catch (error) {
    return { ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

export function attachmentExists(location: AttachmentLocation, storedFilename: string): boolean {
  return locateAttachment(location, storedFilename).ok;
}
