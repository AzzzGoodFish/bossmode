// User sequence values are TEXT in the shared cursor table; message IDs remain separate.
import { getDatabase } from "../data/database.js";
import { UserCursorRepository } from "../data/repositories/user-cursor-repository.js";
import type { ScopeId } from "./conversations.js";
import { parseMmScopeId, parseScopeId } from "./conversations.js";

export interface UserReadCursor {
  messageId: string | null;
  seq: number | null;
  updatedAt: number;
}

function repository(): UserCursorRepository { return new UserCursorRepository(getDatabase()); }
/** Room/DM scopes and member↔member pair scopes (⑤ B) carry user read cursors. */
function readCursorScopeOk(scopeId: string): boolean {
  return Boolean(parseScopeId(scopeId) || parseMmScopeId(scopeId));
}
export function getUserReadCursor(scopeId: ScopeId): UserReadCursor | null {
  if (!readCursorScopeOk(scopeId)) return null;
  return repository().get(scopeId);
}
export function setUserReadCursor(scopeId: ScopeId, cursor: {messageId?: string | null; seq?: number | null}): UserReadCursor {
  if (!readCursorScopeOk(scopeId)) throw new Error("scope_not_found");
  return repository().update(scopeId, cursor, Date.now());
}
export function listUserReadCursors(): Record<string, UserReadCursor> { return repository().list(); }
