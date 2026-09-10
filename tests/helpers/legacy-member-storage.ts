// TEST ONLY: frozen fresh rc.1 member-storage-v1 fixture from ca0253d.
// Preserve the historical tables, indexes and markers, not a live bootstrap API.
// In particular this is NOT the current members schema and must not track it.
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Creates and closes a new historical DB on an explicit npm-test sandbox path.
 * No default path, binding, lazy cache, migration runner or production imports. */
export function createLegacyMemberStorageFixture(path: string): void {
  const root = process.env.BOSSMODE_TEST_ROOT;
  if (!root || !isAbsolute(root) || !isAbsolute(path)) throw new Error("Legacy fixture requires an absolute test sandbox path");
  const parent = relative(realpathSync(root), realpathSync(dirname(path)));
  if (isAbsolute(parent) || parent === ".." || parent.startsWith(`..${sep}`)) throw new Error("Legacy fixture must stay inside the test sandbox");
  if (existsSync(path)) throw new Error("Legacy fixture requires a new database");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
    db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS token_usage_daily (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, member_id, date, model)
);
CREATE INDEX IF NOT EXISTS idx_token_daily_room_date ON token_usage_daily(room_id, date);
CREATE INDEX IF NOT EXISTS idx_token_daily_room_model ON token_usage_daily(room_id, model);

CREATE TABLE IF NOT EXISTS activity_events (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  summary TEXT,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, member_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_activity_member_ts ON activity_events(room_id, member_id, ts DESC);

CREATE TABLE IF NOT EXISTS tasks (
  room_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  assignee TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  payload_json TEXT,
  PRIMARY KEY (room_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_room_status ON tasks(room_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_room_assignee ON tasks(room_id, assignee, updated_at DESC);

CREATE TABLE IF NOT EXISTS ingest_watermark (
  kind TEXT NOT NULL,
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL DEFAULT '',
  last_ts INTEGER,
  last_seq INTEGER,
  last_mtime_ms INTEGER,
  PRIMARY KEY (kind, room_id, member_id)
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  title TEXT,
  agent_template TEXT NOT NULL,
  global_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE projection_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_migrations(id, applied_at) VALUES
  ('sqlite-projection-v1', 1), ('member-storage-v1', 2);
`);
    // A fresh old openDb applied both migrations with an initially empty applied
    // set, so it left projection_state empty (unlike an upgraded projection DB).
  } finally { db.close(); }
}
