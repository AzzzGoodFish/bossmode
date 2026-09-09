import type { StorageMigration } from "../database.js";

export const executionMigration: StorageMigration = {
  id: "core-execution-v1",
  sql: `
CREATE TABLE current_sessions (
  member_id TEXT NOT NULL REFERENCES members(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  runtime TEXT NOT NULL CHECK(length(runtime)>0),
  sdk_session_id TEXT,
  file_reference TEXT,
  reference_kind TEXT NOT NULL CHECK(reference_kind IN ('member-relative','legacy-absolute')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(member_id, scope_id)
);
CREATE TABLE runtime_checkpoints (
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  contract_fingerprint TEXT,
  contract_version INTEGER,
  drift_notified INTEGER,
  stale_since INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id, member_id)
);
CREATE TABLE runtime_stale_fields (
  scope_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  field TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(scope_id, member_id, field),
  FOREIGN KEY(scope_id, member_id) REFERENCES runtime_checkpoints(scope_id, member_id) ON DELETE CASCADE
);
CREATE TABLE user_cursor_messages (
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind='user'),
  actor_key TEXT NOT NULL DEFAULT 'user' CHECK(actor_key='user'),
  message_id TEXT,
  PRIMARY KEY(scope_id, kind, actor_key),
  FOREIGN KEY(scope_id, kind, actor_key) REFERENCES read_cursors(scope_id, kind, actor_key) ON DELETE CASCADE
);
CREATE TABLE background_tasks (
  task_id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  kind TEXT NOT NULL CHECK(kind IN ('generic','recall','memorize')),
  session_mode TEXT NOT NULL CHECK(session_mode IN ('new','fork')),
  prompt TEXT NOT NULL,
  model TEXT,
  credential_id TEXT,
  thinking_level TEXT,
  status TEXT NOT NULL CHECK(status IN ('starting','running','cancelling','done','failed','cancelled','interrupted')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT,
  error TEXT,
  session_dir TEXT NOT NULL UNIQUE,
  parent_session_ref TEXT,
  CHECK ((status IN ('starting','running','cancelling') AND ended_at IS NULL AND result IS NULL AND error IS NULL)
    OR (status='done' AND ended_at IS NOT NULL AND result IS NOT NULL)
    OR (status IN ('failed','cancelled','interrupted') AND ended_at IS NOT NULL AND error IS NOT NULL AND result IS NULL))
);
CREATE INDEX background_tasks_owner_started ON background_tasks(member_id, started_at, task_id);
CREATE INDEX background_tasks_status ON background_tasks(status);
CREATE TRIGGER background_terminal_immutable BEFORE UPDATE ON background_tasks
WHEN OLD.status IN ('done','failed','cancelled','interrupted')
BEGIN SELECT RAISE(ABORT, 'terminal background task is immutable'); END;
CREATE TRIGGER background_owner_immutable BEFORE UPDATE ON background_tasks
WHEN NEW.member_id != OLD.member_id OR NEW.scope_id != OLD.scope_id OR NEW.session_dir != OLD.session_dir
BEGIN SELECT RAISE(ABORT, 'background task ownership is immutable'); END;
CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  operation TEXT NOT NULL CHECK(operation IN ('input','session-create','session-fork','external')),
  external_reference TEXT,
  status TEXT NOT NULL CHECK(status IN ('prepared','dispatched','acknowledged','interrupted')),
  started_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  ended_at INTEGER,
  diagnosis TEXT
);
CREATE INDEX execution_attempts_status ON execution_attempts(status);
CREATE TABLE execution_import_ambiguities (
  source_path TEXT NOT NULL,
  source_key TEXT NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('session','runtime','background','cursor')),
  reason TEXT NOT NULL,
  record_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY(source_path, source_key, domain)
);
`,
};
