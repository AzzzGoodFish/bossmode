import type { UserReadCursor } from "../../workspace/user-read-cursors.js";
import type { Database } from "../database.js";
import { executionScopeId } from "./execution-identity.js";

interface Row { scope_id: string; value: string | null; message_id: string | null; updated_at: number }
const SELECT = `SELECT c.scope_id,c.value,c.updated_at,m.message_id FROM read_cursors c
  LEFT JOIN user_cursor_messages m ON m.scope_id=c.scope_id AND m.kind=c.kind AND m.actor_key=c.actor_key
  WHERE c.kind='user' AND c.actor_key='user'`;
function map(r: Row): UserReadCursor {
  return {seq: r.value === null ? null : Number(r.value), messageId: r.message_id, updatedAt: r.updated_at};
}
export class UserCursorRepository {
  constructor(private readonly db: Database) {}
  get(scope: string): UserReadCursor | null {
    const row = this.db.get<Row>(`${SELECT} AND c.scope_id=?`, executionScopeId(scope));
    return row ? map(row) : null;
  }
  list(): Record<string, UserReadCursor> {
    return Object.fromEntries(this.db.all<Row>(SELECT).map(r => [r.scope_id.includes(":") ? r.scope_id : `room:${r.scope_id}`, map(r)]));
  }
  importCursor(scope: string, cursor: UserReadCursor): void {
    if (cursor.seq !== null && (typeof cursor.seq !== "number" || !Number.isFinite(cursor.seq))) throw new Error("Invalid numeric user cursor");
    const scopeId = executionScopeId(scope);
    this.db.transaction(tx => {
      tx.run(`INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES(?,'user','user',?,?)
        ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      scopeId, cursor.seq === null ? null : String(cursor.seq), cursor.updatedAt);
      tx.run(`INSERT INTO user_cursor_messages(scope_id,message_id) VALUES(?,?)
        ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET message_id=excluded.message_id`, scopeId, cursor.messageId);
    });
  }
  update(scope: string, patch: {messageId?: string | null; seq?: number | null}, updatedAt: number): UserReadCursor {
    return this.db.transaction(() => {
      const current = this.get(scope);
      const next = {messageId: patch.messageId !== undefined ? patch.messageId : current?.messageId ?? null,
        seq: patch.seq !== undefined ? patch.seq : current?.seq ?? null, updatedAt};
      this.importCursor(scope, next);
      return next;
    });
  }
}
