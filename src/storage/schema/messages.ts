import type { StorageMigration } from "../database.js";

export const messagesMigration: StorageMigration = {
  id: "core-messages-v1",
  sql: `
CREATE TABLE messages (
  position INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  id TEXT NOT NULL,
  seq INTEGER CHECK(seq IS NULL OR seq >= 1),
  ts INTEGER NOT NULL,
  sender TEXT NOT NULL,
  sender_member_id TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('member','user','system','unresolved')),
  content TEXT NOT NULL,
  content_lower TEXT NOT NULL,
  type TEXT,
  extra_json TEXT NOT NULL,
  UNIQUE(scope_id,id), UNIQUE(scope_id,seq)
);
CREATE INDEX messages_history ON messages(scope_id,position);
CREATE INDEX messages_search ON messages(scope_id,ts DESC,position);
CREATE TABLE message_mentions (
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('mention','urgent','response')),
  value_kind TEXT NOT NULL CHECK(value_kind IN ('label','id')),
  ordinal INTEGER NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(scope_id,message_id,kind,value_kind,ordinal),
  FOREIGN KEY(scope_id,message_id) REFERENCES messages(scope_id,id) ON DELETE CASCADE
);
CREATE INDEX message_mention_targets ON message_mentions(value_kind,value,scope_id);
CREATE TABLE message_replies (
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_seq INTEGER NOT NULL,
  PRIMARY KEY(scope_id,message_id),
  FOREIGN KEY(scope_id,message_id) REFERENCES messages(scope_id,id) ON DELETE CASCADE
);
CREATE TABLE dm_member_cursor_sequences (
  scope_id TEXT PRIMARY KEY REFERENCES scopes(id),
  seq INTEGER
);
CREATE TABLE message_archive_entries (
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  archive_ts INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  message_id TEXT NOT NULL,
  seq INTEGER,
  ts INTEGER NOT NULL,
  sender TEXT NOT NULL,
  sender_member_id TEXT,
  content TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(scope_id,archive_ts,ordinal)
);
CREATE INDEX message_archives_list ON message_archive_entries(scope_id,archive_ts DESC);
CREATE TABLE agent_events (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  owner_key TEXT NOT NULL,
  member_id TEXT,
  seq INTEGER NOT NULL CHECK(seq >= 1),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(scope_id,owner_key,seq)
);
CREATE INDEX agent_events_history ON agent_events(scope_id,owner_key,seq DESC);
CREATE INDEX agent_events_member ON agent_events(member_id,type,ts);
DROP TABLE IF EXISTS activity_events;
DROP TABLE IF EXISTS token_usage_daily;
CREATE TABLE token_usage_daily (
  room_id TEXT NOT NULL, member_id TEXT NOT NULL, date TEXT NOT NULL, model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id,member_id,date,model)
);
CREATE INDEX idx_token_daily_room_date ON token_usage_daily(room_id,date);
CREATE TABLE event_usage_receipts (
  event_id TEXT PRIMARY KEY REFERENCES agent_events(id) ON DELETE CASCADE,
  total_tokens INTEGER NOT NULL
);
CREATE TABLE member_statistics (
  scope_id TEXT NOT NULL REFERENCES scopes(id), owner_key TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  active_ms INTEGER NOT NULL DEFAULT 0, open_start_ts INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0, updated_at INTEGER,
  PRIMARY KEY(scope_id,owner_key)
);
`,
};
