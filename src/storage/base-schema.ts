import type { StorageMigration } from "./database.js";

/** Shared cross-domain keys. Domain schemas must not redefine these tables. */
export const baseStorageMigration: StorageMigration = {
  id: "core-base-v1",
  sql: `
CREATE TABLE storage_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE scopes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('room', 'dm', 'topic')),
  room_id TEXT,
  member_id TEXT,
  CHECK ((kind = 'dm' AND member_id IS NOT NULL AND room_id IS NULL)
    OR (kind IN ('room', 'topic') AND room_id IS NOT NULL AND member_id IS NULL))
);
CREATE INDEX scopes_room ON scopes(room_id);
CREATE TABLE scope_sequences (
  scope_id TEXT PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1)
);
CREATE TABLE read_cursors (
  scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('member', 'user')),
  actor_key TEXT NOT NULL,
  value TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_id, kind, actor_key)
);
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  scope_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX outbox_pending ON outbox(delivered_at, id);
`,
};
