// User sequence values are TEXT in the shared cursor table; message IDs remain separate.
import { getDatabase } from "../storage/database.js";
import { UserCursorRepository } from "../storage/repositories/user-cursor-repository.js";
import type { ScopeId } from "../shared/conversation-ref.js";
import { parseScopeId } from "../shared/conversation-ref.js";

export interface UserReadCursor {
  messageId: string | null;
  seq: number | null;
  updatedAt: number;
}

function repository(): UserCursorRepository { return new UserCursorRepository(getDatabase()); }
export function getUserReadCursor(scopeId: ScopeId): UserReadCursor | null {
  if (!parseScopeId(scopeId)) return null;
  return repository().get(scopeId);
}
export function setUserReadCursor(scopeId: ScopeId, cursor: {messageId?: string | null; seq?: number | null}): UserReadCursor {
  if (!parseScopeId(scopeId)) throw new Error("scope_not_found");
  return repository().update(scopeId, cursor, Date.now());
}
export function listUserReadCursors(): Record<string, UserReadCursor> { return repository().list(); }
