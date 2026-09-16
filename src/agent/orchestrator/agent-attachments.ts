// Agent attachment processing — validate paths + copy to room attachments
import { knowledgeRoot } from "../../files/layout.js";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkPath, type PathPolicy } from "../../kernel/path.js";
import { copyToAttachment, MAX_UPLOAD_SIZE } from "../../files/attachment-store.js";
import * as roomStore from "../../chat/room-store.js";

import { readWorkspaces } from "../../member/workspaces/workspace-registry.js";
import { getRoomMembersFromRoom, roomMemberAssetRoots } from "../../chat/room-store.js";
import { chatScopeRoomId } from "../../chat/conversation-ref.js";

import { logger } from "../../kernel/logger.js";

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

/** Build path policy for a room — defines allowed attachment source directories. */
function buildPolicy(roomId: string): PathPolicy {
  const parentId = chatScopeRoomId(roomId) || roomId;
  if (!roomStore.getRoom(parentId)) throw new Error(`Room not found: ${roomId}`);
  const allowedPrefixes: string[] = [];
  for (const root of roomMemberAssetRoots(parentId)) {
    try { allowedPrefixes.push(realpathSync(root)); } catch { /* skip if unresolvable */ }
  }
  try { allowedPrefixes.push(realpathSync(tmpdir())); } catch { /* */ }
  try { allowedPrefixes.push(realpathSync(knowledgeRoot())); } catch { /* */ }
  return { allowedPrefixes, maxSizeBytes: MAX_UPLOAD_SIZE };
}

/**
 * Process agent attachment paths: validate + copy to room's attachments dir.
 * Returns one outcome per input path.
 */
export async function processAgentAttachments(
  roomId: string,
  paths: string[],
): Promise<AttachmentOutcome[]> {
  if (!Array.isArray(paths) || paths.length === 0) return [];

  const policy = buildPolicy(roomId);
  const results: AttachmentOutcome[] = [];

  for (const p of paths) {
    const check = checkPath(p, policy);
    if (!check.ok) {
      logger.warn("agent-attachment", "rejected", { roomId, path: p, error: check.error });
      results.push({ ok: false, path: p, error: check.error });
      continue;
    }
    try {
      const stored = await copyToAttachment(check.absolutePath, chatScopeRoomId(roomId) || roomId);
      results.push({ ok: true, ...stored });
    } catch (err: any) {
      results.push({ ok: false, path: p, error: err.message || String(err) });
    }
  }

  return results;
}
