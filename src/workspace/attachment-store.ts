// Attachment storage — stream-based write with hash naming
import { createHash, randomBytes } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createWriteStream, createReadStream,
  existsSync, mkdirSync, renameSync, unlinkSync,
} from "node:fs";
import { extname, basename, join } from "node:path";
import type { Readable } from "node:stream";
import * as roomStore from "./room-store.js";
import { logger } from "../foundation/logger.js";

export const ATTACHMENT_DIR_NAME = ".bossmode-attachments";
export const MAX_UPLOAD_SIZE = 1024 * 1024 * 1024; // 1 GB

export interface StoredAttachment {
  storedFilename: string;
  originalFilename: string;
  absolutePath: string;
  size: number;
}

function getAttachDir(roomId: string): string {
  const room = roomStore.getRoom(roomId);
  if (!room) throw new Error(`Room not found: ${roomId}`);
  const dir = join(room.cwd, ATTACHMENT_DIR_NAME);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function tempPath(): string {
  return join("/tmp", `bossmode-upload-${Date.now()}-${randomBytes(4).toString("hex")}`);
}

/**
 * Stream a Readable into the room's attachments dir, hashing as it flows.
 * - Writes to temp file first; renames after pipeline completes
 * - On error/abort, temp file is cleaned up
 * - Enforces maxSize via Transform guard
 */
export async function streamToAttachment(
  source: Readable,
  roomId: string,
  originalFilename: string,
  maxSize: number = MAX_UPLOAD_SIZE,
): Promise<StoredAttachment> {
  const tmp = tempPath();
  const hash = createHash("sha256");
  let total = 0;

  const sizeGuard = new Transform({
    transform(chunk, _, cb) {
      total += chunk.length;
      if (total > maxSize) {
        cb(new Error(`Upload too large (max ${Math.round(maxSize / 1024 / 1024)}MB)`));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  const writeStream = createWriteStream(tmp);

  try {
    await pipeline(source, sizeGuard, writeStream);
  } catch (err) {
    if (existsSync(tmp)) {
      try { unlinkSync(tmp); } catch { /* best-effort */ }
    }
    throw err;
  }

  const hex = hash.digest("hex").slice(0, 12);
  const ext = extname(originalFilename) || ".bin";
  const storedFilename = `${hex}${ext}`;
  const absolutePath = join(getAttachDir(roomId), storedFilename);

  if (existsSync(absolutePath)) {
    // Hash collision — file already exists, reuse
    try { unlinkSync(tmp); } catch { /* */ }
  } else {
    renameSync(tmp, absolutePath);
  }

  logger.info("attachment-store", "stored", { roomId, storedFilename, originalFilename, size: total });
  return { storedFilename, originalFilename, absolutePath, size: total };
}

/**
 * Copy a local file into the room's attachments dir (streaming).
 * Used by agent chat attachments after path validation.
 */
export async function copyToAttachment(
  sourceAbsPath: string,
  roomId: string,
  originalFilename?: string,
): Promise<StoredAttachment> {
  const name = originalFilename || basename(sourceAbsPath);
  return streamToAttachment(createReadStream(sourceAbsPath), roomId, name);
}

/** Get absolute path for a stored attachment (with path traversal protection). */
export function getAttachmentPath(roomId: string, storedFilename: string): string {
  const safe = basename(storedFilename);
  if (safe !== storedFilename || safe.includes("..")) {
    throw new Error("Invalid filename");
  }
  return join(getAttachDir(roomId), safe);
}

/** Check if an attachment file exists. */
export function attachmentExists(roomId: string, storedFilename: string): boolean {
  try {
    return existsSync(getAttachmentPath(roomId, storedFilename));
  } catch {
    return false;
  }
}
