import type { StorageMigration } from "../database.js";

export const settingsMigration: StorageMigration = {
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
};
