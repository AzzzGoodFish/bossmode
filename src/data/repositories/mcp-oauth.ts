import { createHash } from "node:crypto";
import type { Database } from "../database.js";

// Structural implementation of vendor/pi-mcp-adapter McpAuthStorage. Kept local
// because the vendored TS extension is loaded by the SDK, not compiled into dist.
// These secret-bearing records are internal storage/protocol types, not API DTOs.
export interface McpOauthEntry {
  tokens?: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
  clientInfo?: {
    clientId: string; clientSecret?: string; clientIdIssuedAt?: number;
    clientSecretExpiresAt?: number; redirectUris?: string[];
  };
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string;
}

export function mcpOauthServerKey(serverName: string): string {
  if (typeof serverName !== "string") throw new Error("Invalid MCP server name");
  return createHash("sha256").update(serverName, "utf8").digest("hex");
}

function validateKey(key: string): void {
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid MCP OAuth storage key");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP OAuth record");
  return value as Record<string, unknown>;
}
function text(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error("Invalid MCP OAuth text field");
  return value;
}
function number(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid MCP OAuth numeric field");
  return value;
}

/** Pure decoder for the pinned adapter's tokens.json AuthEntry document.
 * No file lookup, schema initialization, fallback or import-on-read. */
export function decodeLegacyMcpOauthEntry(value: unknown): McpOauthEntry {
  const row = object(value);
  const entry: McpOauthEntry = {};
  for (const key of ["serverUrl", "codeVerifier", "oauthState"] as const) {
    if (row[key] !== undefined) entry[key] = text(row[key]);
  }
  if (row.tokens !== undefined) {
    const tokens = object(row.tokens);
    entry.tokens = {
      accessToken: text(tokens.accessToken, true)!,
      ...(tokens.refreshToken !== undefined ? { refreshToken: text(tokens.refreshToken) } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: number(tokens.expiresAt) } : {}),
      ...(tokens.scope !== undefined ? { scope: text(tokens.scope) } : {}),
    };
  }
  if (row.clientInfo !== undefined) {
    const client = object(row.clientInfo);
    entry.clientInfo = {
      clientId: text(client.clientId, true)!,
      ...(client.clientSecret !== undefined ? { clientSecret: text(client.clientSecret) } : {}),
      ...(client.clientIdIssuedAt !== undefined ? { clientIdIssuedAt: number(client.clientIdIssuedAt) } : {}),
      ...(client.clientSecretExpiresAt !== undefined ? { clientSecretExpiresAt: number(client.clientSecretExpiresAt) } : {}),
    };
    if (client.redirectUris !== undefined) {
      if (!Array.isArray(client.redirectUris)) throw new Error("Invalid MCP OAuth redirect URIs");
      entry.clientInfo.redirectUris = client.redirectUris.map((uri) => text(uri, true)!);
    }
  }
  // Avoid silently accepting the unrelated, flat OAuthTokens format of the
  // unused oauth-handler helper as an empty AuthEntry.
  if ("access_token" in row) throw new Error("Unsupported flat MCP OAuth token file; explicit conversion required");
  return entry;
}

export class McpOauthRepository {
  constructor(private readonly db: Database) {}

  transaction<T>(operation: () => T): T { return this.db.transaction(operation); }

  read(serverName: string): McpOauthEntry | undefined {
    // A coherent snapshot across normalized tables, even with another connection.
    return this.transaction(() => this.readKey(mcpOauthServerKey(serverName)));
  }

  private readKey(key: string): McpOauthEntry | undefined {
    const row = this.db.get<{ server_url: string | null; code_verifier: string | null; oauth_state: string | null }>(
      "SELECT server_url, code_verifier, oauth_state FROM mcp_oauth_entries WHERE server_key = ?", key);
    if (!row) return undefined;
    const result: McpOauthEntry = {};
    if (row.server_url !== null) result.serverUrl = row.server_url;
    if (row.code_verifier !== null) result.codeVerifier = row.code_verifier;
    if (row.oauth_state !== null) result.oauthState = row.oauth_state;
    const tokens = this.db.get<{ access_token: string; refresh_token: string | null; expires_at: number | null; scope: string | null }>(
      "SELECT access_token, refresh_token, expires_at, scope FROM mcp_oauth_tokens WHERE server_key = ?", key);
    if (tokens) {
      result.tokens = { accessToken: tokens.access_token };
      if (tokens.refresh_token !== null) result.tokens.refreshToken = tokens.refresh_token;
      if (tokens.expires_at !== null) result.tokens.expiresAt = tokens.expires_at;
      if (tokens.scope !== null) result.tokens.scope = tokens.scope;
    }
    const client = this.db.get<{ client_id: string; client_secret: string | null; client_id_issued_at: number | null; client_secret_expires_at: number | null; has_redirect_uris: number }>(
      "SELECT client_id, client_secret, client_id_issued_at, client_secret_expires_at, has_redirect_uris FROM mcp_oauth_clients WHERE server_key = ?", key);
    if (client) {
      result.clientInfo = { clientId: client.client_id };
      if (client.client_secret !== null) result.clientInfo.clientSecret = client.client_secret;
      if (client.client_id_issued_at !== null) result.clientInfo.clientIdIssuedAt = client.client_id_issued_at;
      if (client.client_secret_expires_at !== null) result.clientInfo.clientSecretExpiresAt = client.client_secret_expires_at;
      if (client.has_redirect_uris) result.clientInfo.redirectUris = this.db.all<{ uri: string }>(
        "SELECT uri FROM mcp_oauth_redirect_uris WHERE server_key = ? ORDER BY position", key).map((item) => item.uri);
    }
    return result;
  }

  write(serverName: string, entry: McpOauthEntry): void {
    this.importHashedAuthEntry(mcpOauthServerKey(serverName), entry);
  }

  remove(serverName: string): void {
    this.db.run("DELETE FROM mcp_oauth_entries WHERE server_key = ?", mcpOauthServerKey(serverName));
  }

  /** Explicit importer upsert when the configured server name is known. */
  importAuthEntry(serverName: string, entry: McpOauthEntry): void { this.write(serverName, entry); }

  /** Explicit importer upsert for sha256-<hex>/tokens.json, including orphaned
   * names which cannot be recovered from their hash. Pass only the 64 hex chars.
   * Caller owns backup, source decoding, import transaction and retirement. */
  importHashedAuthEntry(serverKey: string, input: McpOauthEntry): void {
    validateKey(serverKey);
    const entry = decodeLegacyMcpOauthEntry(input);
    this.transaction(() => {
      this.db.run(`INSERT INTO mcp_oauth_entries(server_key, server_url, code_verifier, oauth_state) VALUES (?, ?, ?, ?)
        ON CONFLICT(server_key) DO UPDATE SET server_url=excluded.server_url, code_verifier=excluded.code_verifier, oauth_state=excluded.oauth_state`,
        serverKey, entry.serverUrl ?? null, entry.codeVerifier ?? null, entry.oauthState ?? null);
      this.db.run("DELETE FROM mcp_oauth_tokens WHERE server_key = ?", serverKey);
      this.db.run("DELETE FROM mcp_oauth_clients WHERE server_key = ?", serverKey);
      if (entry.tokens) {
        const tokens = entry.tokens;
        this.db.run("INSERT INTO mcp_oauth_tokens VALUES (?, ?, ?, ?, ?)", serverKey,
          tokens.accessToken, tokens.refreshToken ?? null, tokens.expiresAt ?? null, tokens.scope ?? null);
      }
      if (entry.clientInfo) {
        const client = entry.clientInfo;
        this.db.run("INSERT INTO mcp_oauth_clients VALUES (?, ?, ?, ?, ?, ?)", serverKey,
          client.clientId, client.clientSecret ?? null, client.clientIdIssuedAt ?? null,
          client.clientSecretExpiresAt ?? null, client.redirectUris === undefined ? 0 : 1);
        client.redirectUris?.forEach((uri, position) => {
          this.db.run("INSERT INTO mcp_oauth_redirect_uris VALUES (?, ?, ?)", serverKey, position, uri);
        });
      }
    });
  }
}

const storages = new WeakMap<Database, McpOauthRepository>();

/** One adapter authority per explicitly supplied DB context. Reusing its identity
 * preserves cross-extension per-server auth deduplication. No I/O or lifecycle
 * work occurs here, and closing the DB never selects another authority. */
export function createMcpOauthStorage(db: Database): McpOauthRepository {
  let storage = storages.get(db);
  if (!storage) { storage = new McpOauthRepository(db); storages.set(db, storage); }
  return storage;
}
