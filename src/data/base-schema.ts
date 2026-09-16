import type { StorageMigration } from "./database.js";

/** Shared cross-domain keys. Domain schemas must not redefine these tables.
 * 'topic' stays in the scopes CHECK for schema stability (fish #19358): the retired kind is
 * cleaned by core-topic-retirement-v1 and no runtime path creates new topic scopes. */
export const baseStorageMigration: StorageMigration = {
  id: "core-base-v1",
  sql: `
CREATE TABLE storage_meta (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE storage_upgrade_files (
  path TEXT NOT NULL PRIMARY KEY,
  backup_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  retire INTEGER NOT NULL CHECK (retire IN (0,1)),
  retired_at INTEGER
);
CREATE TABLE scopes (
  id TEXT NOT NULL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('room', 'dm', 'topic')),
  room_id TEXT,
  member_id TEXT,
  CHECK ((kind = 'dm' AND member_id IS NOT NULL AND room_id IS NULL)
    OR (kind IN ('room', 'topic') AND room_id IS NOT NULL AND member_id IS NULL))
);
CREATE INDEX scopes_room ON scopes(room_id);
CREATE TABLE scope_sequences (
  scope_id TEXT NOT NULL PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
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
