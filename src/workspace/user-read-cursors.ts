/**
 * User read cursors for Chats list unread/mentioned (0.20).
 * Single-user product: one map ScopeId → { messageId, seq }.
 * Contract v1.3: POST /api/conversations/:scope/read
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import type { ScopeId } from "../shared/conversation-ref.js";
import { parseScopeId } from "../shared/conversation-ref.js";

export interface UserReadCursor {
  messageId: string | null;
  seq: number | null;
  updatedAt: number;
}

type CursorMap = Record<string, UserReadCursor>;

function cursorsPath(): string {
  return join(getBossmodeDir(), "user-read-cursors.json");
}

function readAll(): CursorMap {
  const p = cursorsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CursorMap;
  } catch {
    return {};
  }
}

function writeAll(map: CursorMap): void {
  const dir = getBossmodeDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.user-read-cursors.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(map, null, 2) + "\n", "utf-8");
  renameSync(tmp, cursorsPath());
}

export function getUserReadCursor(scopeId: ScopeId): UserReadCursor | null {
  if (!parseScopeId(scopeId)) return null;
  return readAll()[scopeId] || null;
}

export function setUserReadCursor(
  scopeId: ScopeId,
  cursor: { messageId?: string | null; seq?: number | null },
): UserReadCursor {
  if (!parseScopeId(scopeId)) throw new Error("scope_not_found");
  const map = readAll();
  const next: UserReadCursor = {
    messageId: cursor.messageId ?? map[scopeId]?.messageId ?? null,
    seq: cursor.seq !== undefined ? cursor.seq : (map[scopeId]?.seq ?? null),
    updatedAt: Date.now(),
  };
  if (cursor.messageId === null) next.messageId = null;
  if (cursor.seq === null) next.seq = null;
  map[scopeId] = next;
  writeAll(map);
  return next;
}

export function listUserReadCursors(): CursorMap {
  return readAll();
}
