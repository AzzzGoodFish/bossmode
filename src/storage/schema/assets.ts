import type { StorageMigration } from "../database.js";

/** Document bodies (including historical snapshots) remain Markdown assets. */
export const assetsMigration: StorageMigration = {
  id: "core-assets-v1",
  sql: `
CREATE TABLE memory_documents (
  path TEXT NOT NULL PRIMARY KEY,
  layer TEXT NOT NULL CHECK (layer IN ('persona', 'principles', 'mainline')),
  member_id TEXT,
  scope_id TEXT REFERENCES scopes(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  content_hash TEXT NOT NULL,
  content_length INTEGER NOT NULL CHECK (content_length >= 0),
  updated_at INTEGER,
  updated_by TEXT CHECK (updated_by IN ('user', 'member')),
  updated_by_member_id TEXT,
  updated_by_name TEXT
);
CREATE INDEX memory_documents_owner ON memory_documents(member_id, scope_id, layer);
CREATE TABLE memory_document_history (
  document_path TEXT NOT NULL REFERENCES memory_documents(path),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  scope_id TEXT REFERENCES scopes(id),
  ts INTEGER,
  actor_type TEXT CHECK (actor_type IN ('user', 'member')),
  actor_member_id TEXT,
  actor_name TEXT,
  operation TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_length INTEGER NOT NULL CHECK (content_length >= 0),
  snapshot_path TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0),
  PRIMARY KEY (document_path, ordinal)
);
CREATE INDEX memory_document_history_actor ON memory_document_history(actor_member_id, ts);
CREATE INDEX memory_document_history_revision ON memory_document_history(document_path, revision);
`,
};
