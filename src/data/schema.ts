import type { StorageMigration } from "./database.js";

// The sole schema and format authority. Importing it performs no I/O.
// Applied SQL bytes, IDs, order and foreign-key mode are immutable history.
export const CORE_STORAGE_FORMAT = 1;
export const coreStorageMigrations: readonly StorageMigration[] = Object.freeze([
  {
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
},
  {
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
},
  {
  id: "core-settings-v1",
  sql: `
CREATE TABLE app_settings (
 id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), host TEXT NOT NULL, port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
 session_resume INTEGER NOT NULL CHECK(session_resume IN (0,1)), topic_seed_mode TEXT NOT NULL CHECK(topic_seed_mode IN ('fork','fresh')),
 codex_transport TEXT, websocket_connect_timeout_ms INTEGER, http_idle_timeout_ms INTEGER,
 mcp_enabled INTEGER CHECK(mcp_enabled IN (0,1)), persona_budget INTEGER, member_principles_budget INTEGER,
 mainline_budget INTEGER, room_principles_budget INTEGER, catalog_interval_days REAL
);
CREATE TABLE login_credentials (id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE provider_api_keys (provider TEXT NOT NULL PRIMARY KEY, api_key TEXT NOT NULL);
CREATE TABLE auth_sessions (token_hash TEXT NOT NULL PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE credential_revision (id INTEGER NOT NULL PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT INTO credential_revision VALUES (1,0);
CREATE TABLE model_profiles (
 id TEXT NOT NULL PRIMARY KEY, position INTEGER NOT NULL, profile_kind TEXT, name TEXT NOT NULL, provider_slug TEXT NOT NULL,
 protocol TEXT NOT NULL, base_url TEXT, auth_type TEXT NOT NULL CHECK(auth_type IN ('api_key','oauth','none','ambient')),
 oauth_provider_id TEXT, request_profile TEXT NOT NULL, auth_header INTEGER CHECK(auth_header IN (0,1)),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), is_default INTEGER NOT NULL CHECK(is_default IN (0,1)),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX model_profiles_provider ON model_profiles(provider_slug);
CREATE TABLE model_secrets (profile_id TEXT NOT NULL PRIMARY KEY REFERENCES model_profiles(id) ON DELETE CASCADE,
 api_key TEXT, oauth_json TEXT CHECK(oauth_json IS NULL OR (json_valid(oauth_json) AND json_type(oauth_json)='object')));
CREATE TABLE model_headers (profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(profile_id,name));
CREATE TABLE model_definitions (
 profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('model','added')),
 id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT, context_window INTEGER, max_tokens INTEGER, reasoning INTEGER CHECK(reasoning IN (0,1)),
 input_text INTEGER CHECK(input_text IN (0,1)), input_image INTEGER CHECK(input_image IN (0,1)),
 thinking_json TEXT CHECK(thinking_json IS NULL OR (json_valid(thinking_json) AND json_type(thinking_json)='object')),
 compat_json TEXT CHECK(compat_json IS NULL OR (json_valid(compat_json) AND json_type(compat_json)='object')), metadata_source TEXT,
 PRIMARY KEY(profile_id,kind,id)
);
CREATE TABLE model_customizations (profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE CASCADE, model_id TEXT NOT NULL,
 disabled INTEGER NOT NULL CHECK(disabled IN (0,1)), context_window INTEGER, PRIMARY KEY(profile_id,model_id));
CREATE TABLE credential_migrations (id TEXT NOT NULL PRIMARY KEY);
CREATE TABLE catalog_snapshots (id TEXT NOT NULL PRIMARY KEY, fetched_at INTEGER, last_modified INTEGER, checked_at INTEGER, etag TEXT);
CREATE TABLE catalog_models (
 snapshot_id TEXT NOT NULL REFERENCES catalog_snapshots(id) ON DELETE CASCADE, provider TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
 name TEXT, api TEXT, base_url TEXT, context_window INTEGER, max_tokens INTEGER, reasoning INTEGER CHECK(reasoning IN (0,1)),
 input_json TEXT CHECK(input_json IS NULL OR (json_valid(input_json) AND json_type(input_json)='array')),
 extension_json TEXT NOT NULL CHECK(json_valid(extension_json) AND json_type(extension_json)='object'), PRIMARY KEY(snapshot_id,provider,id)
);
CREATE TABLE mcp_config (
 owner_id TEXT NOT NULL PRIMARY KEY, extension_json TEXT NOT NULL CHECK(json_valid(extension_json) AND json_type(extension_json)='object'),
 settings_extension_json TEXT CHECK(settings_extension_json IS NULL OR (json_valid(settings_extension_json) AND json_type(settings_extension_json)='object')),
 tool_prefix TEXT, idle_timeout REAL, request_timeout_ms INTEGER, direct_tools INTEGER, disable_proxy_tool INTEGER, auto_auth INTEGER,
 sampling INTEGER, sampling_auto_approve INTEGER, elicitation INTEGER, auth_required_message TEXT,
 output_guard TEXT, output_guard_max_bytes INTEGER, output_guard_max_lines INTEGER, output_guard_details_max_bytes INTEGER
);
CREATE TABLE mcp_imports (owner_id TEXT NOT NULL REFERENCES mcp_config(owner_id) ON DELETE CASCADE, position INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(owner_id,position));
CREATE TABLE mcp_servers (
 owner_id TEXT NOT NULL REFERENCES mcp_config(owner_id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL,
 command TEXT, url TEXT, cwd TEXT, auth TEXT, bearer_token TEXT, bearer_token_env TEXT, lifecycle TEXT, idle_timeout REAL, request_timeout_ms INTEGER,
 expose_resources INTEGER, debug INTEGER, direct_tools TEXT,
 extension_json TEXT NOT NULL CHECK(json_valid(extension_json) AND json_type(extension_json)='object'), PRIMARY KEY(owner_id,name)
);
CREATE TABLE mcp_server_args (owner_id TEXT NOT NULL, server_name TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id,server_name,position), FOREIGN KEY(owner_id,server_name) REFERENCES mcp_servers(owner_id,name) ON DELETE CASCADE);
CREATE TABLE mcp_server_tools (owner_id TEXT NOT NULL, server_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('direct','exclude')), position INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(owner_id,server_name,kind,position), FOREIGN KEY(owner_id,server_name) REFERENCES mcp_servers(owner_id,name) ON DELETE CASCADE);
CREATE TABLE mcp_server_values (owner_id TEXT NOT NULL, server_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('env','headers')), name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_id,server_name,kind,name), FOREIGN KEY(owner_id,server_name) REFERENCES mcp_servers(owner_id,name) ON DELETE CASCADE);
CREATE TABLE mcp_oauth_config (
 owner_id TEXT NOT NULL, server_name TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 grant_type TEXT, client_id TEXT, client_secret TEXT, scope TEXT, redirect_uri TEXT, client_name TEXT, client_uri TEXT,
 extension_json TEXT NOT NULL CHECK(json_valid(extension_json) AND json_type(extension_json)='object'),
 PRIMARY KEY(owner_id,server_name), FOREIGN KEY(owner_id,server_name) REFERENCES mcp_servers(owner_id,name) ON DELETE CASCADE
);
CREATE TABLE mcp_status (server_name TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, checked_at INTEGER, tool_count INTEGER, resource_count INTEGER, error TEXT, config_hash TEXT);
CREATE TABLE workspace_registries (member_id TEXT NOT NULL PRIMARY KEY, active TEXT NOT NULL);
CREATE TABLE workspaces (member_id TEXT NOT NULL REFERENCES workspace_registries(member_id) ON DELETE CASCADE, id TEXT NOT NULL,
 position INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('original','ssh')), description TEXT NOT NULL, root TEXT NOT NULL,
 host TEXT, port INTEGER, user TEXT, key_path TEXT, PRIMARY KEY(member_id,id));
CREATE TABLE ssh_credentials (member_id TEXT NOT NULL PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL, config TEXT);
`,
},
  {
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
},
  {
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
},
  {
  id: "core-event-source-v1",
  sql: `
CREATE TABLE event_source_receipts (
  event_id TEXT PRIMARY KEY REFERENCES agent_events(id) ON DELETE CASCADE,
  input_fingerprint TEXT NOT NULL
);
`,
},
  {
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
},
  {
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
},
  {
  id: "core-templates-v1",
  sql: `
    CREATE TABLE agent_templates (
      slug TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      avatar TEXT,
      model TEXT,
      tags_present INTEGER NOT NULL CHECK (tags_present IN (0,1)),
      skills_present INTEGER NOT NULL CHECK (skills_present IN (0,1)),
      persona_path TEXT NOT NULL UNIQUE,
      extensions_json TEXT NOT NULL CHECK (json_valid(extensions_json) AND json_type(extensions_json) = 'object')
    );
    CREATE TABLE agent_template_tags (
      slug TEXT NOT NULL REFERENCES agent_templates(slug) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      value TEXT NOT NULL,
      PRIMARY KEY (slug, position)
    );
    CREATE TABLE agent_template_skills (
      slug TEXT NOT NULL REFERENCES agent_templates(slug) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      value TEXT NOT NULL,
      PRIMARY KEY (slug, position)
    );
    CREATE INDEX agent_template_skill_value ON agent_template_skills(value, slug);
  `,
},
  {
  id: "core-member-archives-v1",
  sql: `
CREATE TABLE member_archive_intents (
 member_id TEXT PRIMARY KEY REFERENCES members(id),
 source_path TEXT NOT NULL UNIQUE, archive_path TEXT NOT NULL UNIQUE,
 source_device TEXT NOT NULL, source_inode TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','completed')),
 created_at INTEGER NOT NULL, completed_at INTEGER,
 CHECK((state='pending' AND completed_at IS NULL) OR (state='completed' AND completed_at IS NOT NULL))
);
CREATE TABLE member_archives (
 archive_path TEXT NOT NULL, source_name TEXT NOT NULL,
 member_id TEXT REFERENCES members(id), kind TEXT NOT NULL CHECK(kind IN ('legacy','fired')),
 template TEXT NOT NULL, title TEXT, global_json TEXT NOT NULL CHECK(json_valid(global_json) AND json_type(global_json)='object'),
 persona_path TEXT, persona_format TEXT NOT NULL CHECK(persona_format IN ('plain','frontmatter')),
 has_persona INTEGER NOT NULL CHECK(has_persona IN (0,1)),
 PRIMARY KEY(archive_path,source_name)
);
CREATE UNIQUE INDEX member_archives_identity ON member_archives(member_id) WHERE member_id IS NOT NULL;
CREATE TABLE member_archive_rooms (
 archive_path TEXT NOT NULL, source_name TEXT NOT NULL, position INTEGER NOT NULL,
 room TEXT NOT NULL, has_principles INTEGER NOT NULL, has_mainline INTEGER NOT NULL,
 PRIMARY KEY(archive_path,source_name,position),
 FOREIGN KEY(archive_path,source_name) REFERENCES member_archives(archive_path,source_name)
);
CREATE TABLE member_archive_conflicts (
 archive_path TEXT NOT NULL, source_name TEXT NOT NULL, position INTEGER NOT NULL, conflict TEXT NOT NULL,
 PRIMARY KEY(archive_path,source_name,position),
 FOREIGN KEY(archive_path,source_name) REFERENCES member_archives(archive_path,source_name)
);
`,
},
  {
  id: "core-mcp-oauth-v1",
  sql: `
    CREATE TABLE mcp_oauth_entries (
      server_key TEXT PRIMARY KEY NOT NULL CHECK(length(server_key) = 64 AND server_key NOT GLOB '*[^0-9a-f]*'),
      server_url TEXT,
      code_verifier TEXT,
      oauth_state TEXT
    );
    CREATE TABLE mcp_oauth_tokens (
      server_key TEXT PRIMARY KEY NOT NULL REFERENCES mcp_oauth_entries(server_key) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at REAL,
      scope TEXT
    );
    CREATE TABLE mcp_oauth_clients (
      server_key TEXT PRIMARY KEY NOT NULL REFERENCES mcp_oauth_entries(server_key) ON DELETE CASCADE,
      client_id TEXT NOT NULL,
      client_secret TEXT,
      client_id_issued_at REAL,
      client_secret_expires_at REAL,
      has_redirect_uris INTEGER NOT NULL CHECK(has_redirect_uris IN (0, 1))
    );
    CREATE TABLE mcp_oauth_redirect_uris (
      server_key TEXT NOT NULL REFERENCES mcp_oauth_clients(server_key) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position >= 0),
      uri TEXT NOT NULL,
      PRIMARY KEY(server_key, position)
    );
  `,
},
  {
  id: "core-delivery-v1",
  sql: `
CREATE TABLE delivery_captures (
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  message_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  captured_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,message_id)
);
CREATE TRIGGER delivery_capture_immutable BEFORE UPDATE ON delivery_captures
BEGIN SELECT RAISE(ABORT,'Captured delivery is immutable'); END;
CREATE TABLE captured_deliveries (
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_actor_key TEXT NOT NULL,
  target_member_id TEXT,
  delivery_kind TEXT NOT NULL CHECK(delivery_kind IN ('ordinary','urgent','dm')),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,message_id,target_actor_key,delivery_kind),
  FOREIGN KEY(scope_id,message_id) REFERENCES delivery_captures(scope_id,message_id)
);
CREATE TRIGGER captured_delivery_immutable BEFORE UPDATE ON captured_deliveries
BEGIN SELECT RAISE(ABORT,'Delivery acceptance is immutable'); END;
CREATE TABLE reply_obligations (
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  member_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('user','explicit')),
  opened_at INTEGER NOT NULL,
  settled_at INTEGER,
  settled_by_message_id TEXT,
  PRIMARY KEY(scope_id,message_id,actor_key),
  FOREIGN KEY(scope_id,message_id) REFERENCES delivery_captures(scope_id,message_id),
  CHECK((settled_at IS NULL) = (settled_by_message_id IS NULL))
);
CREATE INDEX reply_obligations_pending ON reply_obligations(scope_id,actor_key,opened_at,message_id) WHERE settled_at IS NULL;
CREATE TRIGGER reply_obligation_guard BEFORE UPDATE ON reply_obligations
WHEN OLD.settled_at IS NOT NULL OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.message_id IS NOT OLD.message_id OR NEW.actor_key IS NOT OLD.actor_key
  OR NEW.member_id IS NOT OLD.member_id OR NEW.reason IS NOT OLD.reason
  OR NEW.opened_at IS NOT OLD.opened_at OR NEW.settled_at IS NULL
BEGIN SELECT RAISE(ABORT,'Invalid reply obligation transition'); END;
CREATE TABLE reply_settlements (
  scope_id TEXT NOT NULL,
  reply_message_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
  settled_count INTEGER NOT NULL,
  settled_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,reply_message_id,actor_key),
  FOREIGN KEY(scope_id,reply_message_id) REFERENCES delivery_captures(scope_id,message_id)
);
CREATE TRIGGER reply_settlement_immutable BEFORE UPDATE ON reply_settlements
BEGIN SELECT RAISE(ABORT,'Reply settlement is immutable'); END;
CREATE TABLE queued_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_actor_key TEXT NOT NULL,
  delivery_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  trigger TEXT NOT NULL CHECK(length(trigger)>0),
  status TEXT NOT NULL CHECK(status IN ('pending','dispatched','settled','interrupted','uncertain')),
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  ended_at INTEGER,
  dispatch_token TEXT,
  execution_attempt_id TEXT,
  outcome TEXT CHECK(outcome IN ('completed','failed','cancelled')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  diagnosis TEXT,
  UNIQUE(scope_id,message_id,target_actor_key,delivery_kind),
  FOREIGN KEY(scope_id,message_id,target_actor_key,delivery_kind)
    REFERENCES captured_deliveries(scope_id,message_id,target_actor_key,delivery_kind),
  CHECK((dispatch_token IS NULL) = (dispatched_at IS NULL)),
  CHECK(execution_attempt_id IS NULL OR dispatch_token IS NOT NULL),
  CHECK((status='pending' AND dispatched_at IS NULL AND ended_at IS NULL)
    OR (status='dispatched' AND dispatched_at IS NOT NULL AND ended_at IS NULL)
    OR (status='settled' AND dispatched_at IS NOT NULL AND ended_at IS NOT NULL AND outcome IS NOT NULL)
    OR (status='interrupted' AND dispatched_at IS NULL AND ended_at IS NOT NULL AND diagnosis IS NOT NULL)
    OR (status='uncertain' AND dispatched_at IS NOT NULL AND ended_at IS NOT NULL AND diagnosis IS NOT NULL)),
  CHECK(status='settled' OR (outcome IS NULL AND result_json IS NULL))
);
CREATE INDEX queued_inputs_pending ON queued_inputs(status,id);
CREATE INDEX queued_inputs_actor_pending ON queued_inputs(scope_id,target_actor_key,status,id);
CREATE TRIGGER queued_input_guard BEFORE UPDATE ON queued_inputs
WHEN NEW.id IS NOT OLD.id OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.message_id IS NOT OLD.message_id OR NEW.target_actor_key IS NOT OLD.target_actor_key
  OR NEW.delivery_kind IS NOT OLD.delivery_kind OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.trigger IS NOT OLD.trigger OR NEW.created_at IS NOT OLD.created_at
  OR NOT ((OLD.status='pending' AND NEW.status IN ('dispatched','interrupted'))
    OR (OLD.status='dispatched' AND NEW.status IN ('settled','uncertain')))
  OR (OLD.status='dispatched' AND (NEW.dispatch_token IS NOT OLD.dispatch_token
    OR NEW.execution_attempt_id IS NOT OLD.execution_attempt_id OR NEW.dispatched_at IS NOT OLD.dispatched_at))
BEGIN SELECT RAISE(ABORT,'Invalid queued input transition'); END;
`,
},
  {id:"core-message-archives-v1",sql:`
CREATE TABLE message_archives (
 scope_id TEXT NOT NULL REFERENCES scopes(id),
 archive_ts INTEGER NOT NULL,
 has_messages INTEGER NOT NULL DEFAULT 0 CHECK(has_messages IN (0,1)),
 summary_json TEXT,
 PRIMARY KEY(scope_id,archive_ts)
);
INSERT INTO message_archives(scope_id,archive_ts,has_messages)
 SELECT DISTINCT scope_id,archive_ts,1 FROM message_archive_entries;
`},
  {
  id:"core-runtime-inputs-v1",
  sql:`
ALTER TABLE queued_inputs ADD COLUMN placement TEXT NOT NULL DEFAULT 'tail' CHECK(placement IN ('front','tail'));
CREATE INDEX queued_inputs_ready ON queued_inputs(scope_id,target_actor_key,status,placement,id);
CREATE TRIGGER queued_input_placement_guard BEFORE UPDATE ON queued_inputs
WHEN NEW.placement IS NOT OLD.placement
BEGIN SELECT RAISE(ABORT,'Queued input placement is immutable'); END;
CREATE TABLE reply_obligation_dispositions (
  scope_id TEXT NOT NULL, message_id TEXT NOT NULL, actor_key TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('failed','cancelled','silent','broadcast-skipped','continuation-exhausted')),
  diagnosis TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,message_id,actor_key),
  FOREIGN KEY(scope_id,message_id,actor_key) REFERENCES reply_obligations(scope_id,message_id,actor_key)
);
CREATE TRIGGER reply_disposition_immutable BEFORE UPDATE ON reply_obligation_dispositions
BEGIN SELECT RAISE(ABORT,'Reply disposition is immutable'); END;
`,
},
  {
  id: "core-task-retirement-v1",
  sql: `
DROP TABLE IF EXISTS task_comments;
DROP TABLE IF EXISTS task_subscribers;
DROP TABLE IF EXISTS task_references;
DROP TABLE IF EXISTS tasks;
`,
},
  {
  id: "core-topic-retirement-v1",
  sql: `
-- Delivery chain (children before delivery_captures).
DELETE FROM queued_inputs WHERE scope_id LIKE 'topic:%';
DELETE FROM reply_obligation_dispositions WHERE scope_id LIKE 'topic:%';
DELETE FROM reply_settlements WHERE scope_id LIKE 'topic:%';
DELETE FROM reply_obligations WHERE scope_id LIKE 'topic:%';
DELETE FROM captured_deliveries WHERE scope_id LIKE 'topic:%';
DELETE FROM delivery_captures WHERE scope_id LIKE 'topic:%';
-- Execution / runtime state.
DELETE FROM runtime_stale_fields WHERE scope_id LIKE 'topic:%';
DELETE FROM runtime_checkpoints WHERE scope_id LIKE 'topic:%';
DELETE FROM current_sessions WHERE scope_id LIKE 'topic:%';
DELETE FROM user_cursor_messages WHERE scope_id LIKE 'topic:%';
DELETE FROM read_cursors WHERE scope_id LIKE 'topic:%';
DELETE FROM background_tasks WHERE scope_id LIKE 'topic:%';
DELETE FROM execution_attempts WHERE scope_id LIKE 'topic:%';
-- Messages, events, statistics.
DELETE FROM message_mentions WHERE scope_id LIKE 'topic:%';
DELETE FROM message_replies WHERE scope_id LIKE 'topic:%';
DELETE FROM messages WHERE scope_id LIKE 'topic:%';
DELETE FROM message_archive_entries WHERE scope_id LIKE 'topic:%';
DELETE FROM message_archives WHERE scope_id LIKE 'topic:%';
DELETE FROM event_source_receipts WHERE event_id IN (SELECT id FROM agent_events WHERE scope_id LIKE 'topic:%');
DELETE FROM event_usage_receipts WHERE event_id IN (SELECT id FROM agent_events WHERE scope_id LIKE 'topic:%');
DELETE FROM agent_events WHERE scope_id LIKE 'topic:%';
DELETE FROM member_statistics WHERE scope_id LIKE 'topic:%';
DELETE FROM dm_member_cursor_sequences WHERE scope_id LIKE 'topic:%';
DELETE FROM token_usage_daily WHERE room_id LIKE 'topic:%';
-- Document metadata.
DELETE FROM memory_document_history WHERE scope_id LIKE 'topic:%';
DELETE FROM memory_documents WHERE scope_id LIKE 'topic:%';
-- Remaining scope-bound rows, then the topic records themselves.
DELETE FROM scope_sequences WHERE scope_id LIKE 'topic:%';
DELETE FROM outbox WHERE scope_id LIKE 'topic:%';
DELETE FROM topic_participants;
DELETE FROM topics;
DELETE FROM scopes WHERE kind='topic';
`,
},
  {
  id: "core-background-retirement-v1",
  sql: `
DELETE FROM outbox WHERE kind='background.terminal';
DROP TABLE IF EXISTS background_tasks;
`,
},
  {
  id: "core-member-session-v1",
  sql: `
DROP TABLE current_sessions;
CREATE TABLE current_sessions (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  runtime TEXT NOT NULL CHECK(length(runtime)>0),
  sdk_session_id TEXT,
  file_reference TEXT,
  reference_kind TEXT NOT NULL CHECK(reference_kind IN ('member-relative','legacy-absolute')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
},
  {
  id: "core-member-runtime-state-v1",
  sql: `
CREATE TABLE runtime_checkpoints_member (
  member_id TEXT PRIMARY KEY REFERENCES members(id),
  contract_fingerprint TEXT,
  contract_version INTEGER,
  drift_notified INTEGER,
  stale_since INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO runtime_checkpoints_member(member_id, contract_fingerprint, contract_version, drift_notified, stale_since, updated_at)
SELECT r.member_id, r.contract_fingerprint, r.contract_version, r.drift_notified,
  (SELECT MAX(r3.stale_since) FROM runtime_checkpoints r3 WHERE r3.member_id = r.member_id),
  r.updated_at
FROM runtime_checkpoints r
WHERE r.rowid = (SELECT r2.rowid FROM runtime_checkpoints r2 WHERE r2.member_id = r.member_id ORDER BY r2.updated_at DESC, r2.rowid DESC LIMIT 1);
CREATE TABLE runtime_stale_fields_member (
  member_id TEXT NOT NULL,
  field TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(member_id, field),
  FOREIGN KEY(member_id) REFERENCES runtime_checkpoints_member(member_id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO runtime_stale_fields_member(member_id, field, ordinal)
SELECT member_id, field, MIN(ordinal) FROM runtime_stale_fields GROUP BY member_id, field;
DROP TABLE runtime_stale_fields;
DROP TABLE runtime_checkpoints;
ALTER TABLE runtime_checkpoints_member RENAME TO runtime_checkpoints;
ALTER TABLE runtime_stale_fields_member RENAME TO runtime_stale_fields;
`,
},
  {
  id: "core-room-description-v1",
  sql: `ALTER TABLE rooms ADD COLUMN description TEXT;`,
},
  {
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
},
  {
  id: "core-short-ids-v1",
  sql: `
CREATE TABLE id_migration_map (
  kind TEXT NOT NULL CHECK (kind IN ('member', 'room')),
  old_id TEXT NOT NULL,
  new_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (kind, old_id),
  UNIQUE (kind, new_id)
);
`,
},
]);
