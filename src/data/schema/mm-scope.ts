import type { StorageMigration } from "../database.js";

/**
 * Member↔member private chats (⑤ B, fish #20135): new scope kind `mm`.
 *
 * `scopes.kind` is CHECK-constrained, so extending it rebuilds the table in place.
 * Messages, cursors, sequences and archives reference `scopes` by name; the runner
 * disables foreign_keys around this rebuild (the pragma is a no-op inside a
 * transaction) so dropping the old table is safe, then re-enables it and the
 * `foreign_key_check` below guards the swap. The new CHECK records the mm shape:
 * member_id = canonical "a|b" pair (sorted), room_id NULL.
 */
export const mmScopeMigration: StorageMigration = {
  id: "core-mm-scope-v1",
  foreignKeysOff: true,
  sql: `
CREATE TABLE scopes_rebuild (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('room', 'dm', 'topic', 'mm')),
  room_id TEXT,
  member_id TEXT,
  CHECK ((kind = 'dm' AND member_id IS NOT NULL AND room_id IS NULL)
    OR (kind IN ('room', 'topic') AND room_id IS NOT NULL AND member_id IS NULL)
    OR (kind = 'mm' AND member_id IS NOT NULL AND room_id IS NULL))
);
INSERT INTO scopes_rebuild(id, kind, room_id, member_id) SELECT id, kind, room_id, member_id FROM scopes;
DROP TABLE scopes;
ALTER TABLE scopes_rebuild RENAME TO scopes;
CREATE INDEX scopes_room ON scopes(room_id);
CREATE INDEX scopes_member ON scopes(member_id);
PRAGMA foreign_key_check;
`,
};
