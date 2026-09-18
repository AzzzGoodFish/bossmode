// Chat attachments (agent tool path) — validate paths + copy into the chat's own attachment store.
import { knowledgeRoot } from "../files/layout.js";
import { basename } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkPath, type PathPolicy } from "../kernel/path.js";
import { copyToAttachment, copyToDmAttachment, copyToMemberChatAttachment, MAX_UPLOAD_SIZE } from "../files/attachment-store.js";
import * as roomStore from "../chat/conversations.js";
import { chatScopeAssetRoots, parseMmScopeId } from "../chat/conversations.js";

import { logger } from "../kernel/logger.js";

export interface AttachmentSuccess {
  ok: true;
  storedFilename: string;
  originalFilename: string;
  absolutePath: string;
  size: number;
}

export interface AttachmentError {
  ok: false;
  path: string;
  error: string;
}

export type AttachmentOutcome = AttachmentSuccess | AttachmentError;

/** Allowed source roots for any chat scope: participant member assets + tmp + knowledge. */
function buildPolicy(scope: string): PathPolicy {
  const roomId = roomStore.chatScopeRoomId(scope);
  if (roomId && !roomStore.getRoom(roomId)) throw new Error(`Room not found: ${scope}`);
  const allowedPrefixes: string[] = [];
  for (const root of chatScopeAssetRoots(scope)) {
    try { allowedPrefixes.push(realpathSync(root)); } catch { /* skip if unresolvable */ }
  }
  try { allowedPrefixes.push(realpathSync(tmpdir())); } catch { /* */ }
  try { allowedPrefixes.push(realpathSync(knowledgeRoot())); } catch { /* */ }
  return { allowedPrefixes, maxSizeBytes: MAX_UPLOAD_SIZE };
}

/** One store for every chat kind: rooms are room-owned; member chats are member-owned (dm) or pair-shared (mm). */
function copyToScope(absPath: string, scope: string, originalFilename: string) {
  const pair = parseMmScopeId(scope);
  if (pair) return copyToMemberChatAttachment(absPath, pair[0], pair[1], originalFilename);
  if (scope.startsWith("dm:")) return copyToDmAttachment(absPath, scope.slice(3), originalFilename);
  const roomId = roomStore.chatScopeRoomId(scope);
  if (!roomId) throw new Error(`Unknown chat scope: ${scope}`);
  return copyToAttachment(absPath, roomId, originalFilename);
}

/**
 * Process agent attachment paths: validate + copy to the chat's attachments store.
 * Returns one outcome per input path.
 */
export async function processAgentAttachments(
  scope: string,
  paths: string[],
): Promise<AttachmentOutcome[]> {
  if (!Array.isArray(paths) || paths.length === 0) return [];

  const policy = buildPolicy(scope);
  const results: AttachmentOutcome[] = [];

  for (const p of paths) {
    const check = checkPath(p, policy);
    if (!check.ok) {
      logger.warn("agent-attachment", "rejected", { scope, path: p, error: check.error });
      results.push({ ok: false, path: p, error: check.error });
      continue;
    }
    try {
      const stored = await copyToScope(check.absolutePath, scope, basename(check.absolutePath));
      results.push({ ok: true, ...stored });
    } catch (err: any) {
      results.push({ ok: false, path: p, error: err.message || String(err) });
    }
  }

  return results;
}
