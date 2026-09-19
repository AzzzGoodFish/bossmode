import { getDatabase, type Database } from "../data/database.js";
import { storageScopeId } from "./conversations.js";

export interface UserReadCursor {
  messageId: string | null;
  seq: number | null;
  updatedAt: number;
}

export interface MemberCursorConfirmation {
  scopeId: string;
  memberId: string;
  messageId: string;
  messageSeq: number | null;
}

interface UserCursorRow {
  scope_id: string;
  value: string | null;
  message_id: string | null;
  updated_at: number;
}

const USER_CURSOR_SELECT = `SELECT c.scope_id,c.value,c.updated_at,m.message_id FROM read_cursors c
  LEFT JOIN user_cursor_messages m ON m.scope_id=c.scope_id AND m.kind=c.kind AND m.actor_key=c.actor_key
  WHERE c.kind='user' AND c.actor_key='user'`;

function userCursor(row: UserCursorRow): UserReadCursor {
  const seq = row.value === null ? null : Number(row.value);
  if (seq !== null && !Number.isFinite(seq)) throw new Error(`Invalid stored user cursor: ${row.scope_id}`);
  return { seq, messageId: row.message_id, updatedAt: row.updated_at };
}

export function getUserReadCursor(scope: string, db: Database = getDatabase()): UserReadCursor | null {
  const row = db.get<UserCursorRow>(`${USER_CURSOR_SELECT} AND c.scope_id=?`, storageScopeId(scope));
  return row ? userCursor(row) : null;
}

export function setUserReadCursor(
  scope: string,
  patch: { messageId?: string | null; seq?: number | null },
  db: Database = getDatabase(),
  updatedAt = Date.now(),
): UserReadCursor {
  if (patch.messageId !== undefined && patch.messageId !== null && typeof patch.messageId !== "string") throw new Error("Invalid user cursor message id");
  if (patch.seq !== undefined && patch.seq !== null && !Number.isFinite(patch.seq)) throw new Error("Invalid numeric user cursor");
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error("Invalid cursor timestamp");
  const scopeId = storageScopeId(scope);
  return db.transaction((tx) => {
    const current = getUserReadCursor(scopeId, tx);
    const next: UserReadCursor = {
      messageId: patch.messageId !== undefined ? patch.messageId : current?.messageId ?? null,
      seq: patch.seq !== undefined ? patch.seq : current?.seq ?? null,
      updatedAt,
    };
    tx.run(`INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES(?,'user','user',?,?)
      ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
    scopeId, next.seq === null ? null : String(next.seq), updatedAt);
    tx.run(`INSERT INTO user_cursor_messages(scope_id,message_id) VALUES(?,?)
      ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET message_id=excluded.message_id`, scopeId, next.messageId);
    return next;
  });
}

export function getMemberCursor(scope: string, memberId: string, db: Database = getDatabase()): string | null {
  const scopeId = storageScopeId(scope);
  return db.get<{ value: string | null }>(
    "SELECT value FROM read_cursors WHERE scope_id=? AND kind='member' AND actor_key=?",
    scopeId, memberId,
  )?.value ?? null;
}

export function setMemberCursor(
  scope: string,
  memberId: string,
  messageId: string | null,
  db: Database = getDatabase(),
  updatedAt = Date.now(),
): void {
  const scopeId = storageScopeId(scope);
  if (!memberId) throw new Error("Member cursor requires member id");
  if (messageId !== null && typeof messageId !== "string") throw new Error("Invalid member cursor message id");
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error("Invalid cursor timestamp");
  db.run(`INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES(?,'member',?,?,?)
    ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
  scopeId, memberId, messageId, updatedAt);
}

export function deleteMemberCursor(scope: string, memberId: string, db: Database = getDatabase()): void {
  db.run("DELETE FROM read_cursors WHERE scope_id=? AND kind='member' AND actor_key=?", storageScopeId(scope), memberId);
}

/** Commit-time cursor confirmation. It is idempotent and never moves backwards;
 * a dangling historical cursor may be replaced by the accepted current fact. */
export function confirmMemberCursor(token: MemberCursorConfirmation, db: Database = getDatabase()): boolean {
  const scopeId = storageScopeId(token.scopeId);
  const target = db.get<{ position: number; seq: number | null }>(
    "SELECT position,seq FROM messages WHERE scope_id=? AND id=?",
    scopeId, token.messageId,
  );
  if (!target || target.seq !== token.messageSeq) throw new Error("Cursor confirmation message changed");
  const currentId = getMemberCursor(scopeId, token.memberId, db);
  if (currentId === token.messageId) return false;
  const current = currentId ? db.get<{ position: number }>(
    "SELECT position FROM messages WHERE scope_id=? AND id=?",
    scopeId, currentId,
  ) : undefined;
  if (current && current.position > target.position) return false;
  setMemberCursor(scopeId, token.memberId, token.messageId, db);
  return true;
}

export interface DmMemberCursor { messageId: string | null; seq: number | null }

export function setDmMemberCursor(
  memberId: string,
  cursor: DmMemberCursor,
  db: Database = getDatabase(),
  updatedAt = Date.now(),
): void {
  if ((cursor.messageId !== null && typeof cursor.messageId !== "string") ||
    (cursor.seq !== null && !Number.isSafeInteger(cursor.seq))) throw new Error("Invalid DM cursor");
  const scopeId = `dm:${memberId}`;
  db.transaction((tx) => {
    setMemberCursor(scopeId, memberId, cursor.messageId, tx, updatedAt);
    tx.run("INSERT INTO dm_member_cursor_sequences VALUES(?,?) ON CONFLICT(scope_id) DO UPDATE SET seq=excluded.seq", scopeId, cursor.seq);
  });
}

