import type { StorageMigration } from "../database.js";

/** Run on the parent's staging database: the old tasks table was a projection. */
export const conversationsMigration: StorageMigration = {
  id: "core-conversations-v1",
  sql: `
CREATE TABLE rooms (
  id TEXT NOT NULL PRIMARY KEY REFERENCES scopes(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at INTEGER NOT NULL, legacy_cwd TEXT,
  docs_path TEXT, leader_member_id TEXT, leader_global_member_id TEXT,
  roster_kind TEXT NOT NULL CHECK (roster_kind IN ('global','local','names')),
  has_local_records INTEGER NOT NULL, has_rule_docs INTEGER NOT NULL,
  has_overrides INTEGER NOT NULL
);
CREATE INDEX rooms_created ON rooms(created_at DESC);
CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY(room_id, member_id), UNIQUE(room_id, position)
);
CREATE INDEX room_members_member ON room_members(member_id,room_id);
CREATE TABLE room_member_labels (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, label TEXT NOT NULL, PRIMARY KEY(room_id,position)
);
CREATE TABLE room_member_snapshots (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
  source_agent TEXT NOT NULL, source_member_id TEXT, avatar TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  migrated_name TEXT, migrated_id TEXT, config_json TEXT,
  model TEXT GENERATED ALWAYS AS (json_extract(config_json,'$.model')) VIRTUAL,
  credential_id TEXT GENERATED ALWAYS AS (json_extract(config_json,'$.credentialId')) VIRTUAL,
  thinking_level TEXT GENERATED ALWAYS AS (json_extract(config_json,'$.thinkingLevel')) VIRTUAL,
  context_limit INTEGER GENERATED ALWAYS AS (json_extract(config_json,'$.contextLimit')) VIRTUAL,
  PRIMARY KEY(room_id,position)
);
CREATE INDEX room_snapshots_source ON room_member_snapshots(source_member_id);
CREATE TABLE room_member_overrides (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  member_label TEXT NOT NULL, config_json TEXT NOT NULL,
  model TEXT GENERATED ALWAYS AS (json_extract(config_json,'$.model')) VIRTUAL,
  credential_id TEXT GENERATED ALWAYS AS (json_extract(config_json,'$.credentialId')) VIRTUAL,
  thinking_level TEXT GENERATED ALWAYS AS (json_extract(config_json,'$.thinkingLevel')) VIRTUAL,
  context_limit INTEGER GENERATED ALWAYS AS (json_extract(config_json,'$.contextLimit')) VIRTUAL,
  PRIMARY KEY(room_id,member_label)
);
CREATE TABLE room_rule_docs (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY(room_id,position)
);
-- Retired topic feature (fish #19358): tables remain for schema stability and are emptied by the
-- core-topic-retirement-v1 migration; no runtime path writes here anymore.
CREATE TABLE topics (
  id TEXT NOT NULL PRIMARY KEY,
  scope_id TEXT NOT NULL UNIQUE REFERENCES scopes(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title TEXT NOT NULL, anchor_message_id TEXT NOT NULL, anchor_seq INTEGER,
  created_by TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','closed')),
  created_at INTEGER NOT NULL, closed_at INTEGER,
  seed_mode TEXT NOT NULL CHECK(seed_mode IN ('fork','fresh')),
  summary TEXT, brief TEXT, guide_text TEXT, anchor_excerpt TEXT
);
CREATE INDEX topics_room_created ON topics(room_id,created_at DESC);
CREATE TABLE topic_participants (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, member_ref TEXT NOT NULL,
  PRIMARY KEY(topic_id,position)
);
CREATE INDEX topic_participants_member ON topic_participants(member_ref,topic_id);
DROP TABLE IF EXISTS tasks;
CREATE TABLE tasks (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('todo','in-progress','review','done')),
  priority TEXT NOT NULL CHECK(priority IN ('P0','P1','P2')),
  assignee TEXT, assignee_member_id TEXT, description TEXT,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  has_references INTEGER NOT NULL,
  PRIMARY KEY(room_id,task_id)
);
CREATE INDEX tasks_room_updated ON tasks(room_id,updated_at DESC,created_at DESC);
CREATE INDEX tasks_status_assignee ON tasks(room_id,status,assignee_member_id);
CREATE TABLE task_references (
  room_id TEXT NOT NULL, task_id TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(room_id,task_id,position),
  FOREIGN KEY(room_id,task_id) REFERENCES tasks(room_id,task_id) ON DELETE CASCADE
);
CREATE TABLE task_subscribers (
  room_id TEXT NOT NULL, task_id TEXT NOT NULL, position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('member','snapshot','human')), value TEXT NOT NULL,
  PRIMARY KEY(room_id,task_id,kind,position),
  FOREIGN KEY(room_id,task_id) REFERENCES tasks(room_id,task_id) ON DELETE CASCADE
);
CREATE INDEX task_subscribers_member ON task_subscribers(kind,value,room_id,task_id);
CREATE TABLE task_comments (
  room_id TEXT NOT NULL, task_id TEXT NOT NULL, position INTEGER NOT NULL,
  id TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(room_id,task_id,position),
  FOREIGN KEY(room_id,task_id) REFERENCES tasks(room_id,task_id) ON DELETE CASCADE
);
`,
};
