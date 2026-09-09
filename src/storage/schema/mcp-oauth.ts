import type { StorageMigration } from "../database.js";

/** Application-wide server-name hash is the existing adapter credential identity.
 * URL is a validity guard, not another owner or a second credential namespace. */
export const mcpOauthMigration: StorageMigration = {
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
};
