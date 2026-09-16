import type { StorageMigration } from "../database.js";

/** Initial cutover only: rebuild the rc.1 identity table before new domain FKs. */
export const membersMigration: StorageMigration = {
  id: "core-members-v1",
  sql: `
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
  title TEXT, agent_template TEXT NOT NULL, global_json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE core_members_import (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  name_key TEXT NOT NULL,
  archived_at INTEGER,
  archive_path TEXT,
  title TEXT,
  agent_template TEXT NOT NULL,
  global_json TEXT NOT NULL CHECK (json_valid(global_json) AND json_type(global_json)='object'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  model TEXT GENERATED ALWAYS AS (json_extract(global_json, '$.model')) VIRTUAL,
  credential_id TEXT GENERATED ALWAYS AS (json_extract(global_json, '$.credentialId')) VIRTUAL,
  thinking_level TEXT GENERATED ALWAYS AS (json_extract(global_json, '$.thinkingLevel')) VIRTUAL,
  CHECK ((archived_at IS NULL AND archive_path IS NULL) OR (archived_at IS NOT NULL AND archive_path IS NOT NULL))
);
INSERT INTO core_members_import (id,name,name_key,title,agent_template,global_json,created_at,updated_at)
  SELECT id,name,name_key,title,agent_template,global_json,created_at,updated_at FROM members;
DROP TABLE members;
ALTER TABLE core_members_import RENAME TO members;
CREATE UNIQUE INDEX members_active_name_key ON members(name_key) WHERE archived_at IS NULL;
`,
};
