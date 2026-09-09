import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyStorageMigrations, openDatabase, type Database } from "../../src/storage/database.js";
import { mcpOauthMigration } from "../../src/storage/schema/mcp-oauth.js";
import { createMcpOauthStorage, decodeLegacyMcpOauthEntry, McpOauthRepository, mcpOauthServerKey, type McpOauthEntry } from "../../src/storage/repositories/mcp-oauth.js";
import { createMcpAuth, type McpAuthStorage } from "../../vendor/pi-mcp-adapter/mcp-auth.ts";
import { McpOAuthProvider } from "../../vendor/pi-mcp-adapter/mcp-oauth-provider.ts";
import { createMcpAuthFlow } from "../../vendor/pi-mcp-adapter/mcp-auth-flow.ts";

let root: string;
let db: Database;
let repository: McpOauthRepository;
let connections: Database[];
const url = "https://mock.invalid/mcp";
const entry: McpOauthEntry = {
  serverUrl: url, codeVerifier: "mock-verifier", oauthState: "mock-state",
  tokens: { accessToken: "mock-access", refreshToken: "mock-refresh", expiresAt: 1234567890.5, scope: "read write" },
  clientInfo: { clientId: "mock-client", clientSecret: "mock-secret", clientIdIssuedAt: 42,
    clientSecretExpiresAt: 0, redirectUris: ["http://localhost:1234/callback", "http://localhost:1234/callback"] },
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-mcp-oauth-"));
  db = openDatabase(join(root, "oauth.sqlite")); connections = [db];
  applyStorageMigrations(db, [mcpOauthMigration]); repository = new McpOauthRepository(db);
  vi.stubEnv("MCP_OAUTH_DIR", join(root, "forbidden-file-backend"));
});
afterEach(() => { connections.forEach((connection) => connection.close()); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("MCP OAuth SQLite authority", () => {
  it("is structurally compatible, creates no files on construction, and requires an initialized schema", () => {
    expect(createMcpOauthStorage(db)).toBe(createMcpOauthStorage(db));
    const storage: McpAuthStorage = repository;
    expect(storage).toBe(repository);
    const uninitialized = openDatabase(join(root, "uninitialized.sqlite")); connections.push(uninitialized);
    const fresh = createMcpOauthStorage(uninitialized);
    expect(fresh).not.toBe(createMcpOauthStorage(db));
    const before = readdirSync(root);
    createMcpAuth(fresh); createMcpAuthFlow(fresh);
    expect(readdirSync(root)).toEqual(before);
    expect(() => fresh.read("server")).toThrow(/no such table/);
    expect(existsSync(process.env.MCP_OAUTH_DIR!)).toBe(false);
  });

  it("never reads, updates or retires a legacy credential file during normal operations", async () => {
    const dir = join(process.env.MCP_OAUTH_DIR!, `sha256-${mcpOauthServerKey("server")}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "tokens.json");
    const source = JSON.stringify(entry);
    writeFileSync(path, source, { mode: 0o600 });
    const provider = new McpOAuthProvider("server", url, {}, { onRedirect: vi.fn() }, repository);
    expect(await provider.tokens()).toBeUndefined();
    await provider.saveTokens({ access_token: "sql-only", token_type: "Bearer" });
    expect(repository.read("server")?.tokens?.accessToken).toBe("sql-only");
    expect(readFileSync(path, "utf8")).toBe(source);
    db.close(); await expect(provider.tokens()).rejects.toThrow("closed");
    expect(readFileSync(path, "utf8")).toBe(source);
  });

  it("imports all fields, uses normalized tables, reopens and returns detached values", () => {
    repository.importAuthEntry("сервер / ../", entry);
    const read = repository.read("сервер / ../")!;
    expect(read).toEqual(entry); read.tokens!.accessToken = "not-saved";
    expect(repository.read("сервер / ../")).toEqual(entry);
    expect(db.all("SELECT * FROM mcp_oauth_redirect_uris")).toHaveLength(2);
    db.close(); db = openDatabase(join(root, "oauth.sqlite")); connections.push(db);
    repository = new McpOauthRepository(db);
    expect(repository.read("сервер / ../")).toEqual(entry);
    expect(repository.read("missing")).toBeUndefined();
    expect(existsSync(process.env.MCP_OAUTH_DIR!)).toBe(false);
  });

  it("imports hashed orphan keys without guessing owner identities and upserts idempotently", () => {
    const key = mcpOauthServerKey("");
    repository.importHashedAuthEntry(key, decodeLegacyMcpOauthEntry(JSON.parse(JSON.stringify(entry))));
    repository.importHashedAuthEntry(key, entry);
    expect(repository.read("")).toEqual(entry);
    expect(db.all("SELECT * FROM mcp_oauth_entries")).toHaveLength(1);
    repository.importHashedAuthEntry(key, {});
    expect(repository.read("")).toEqual({});
    expect(db.all("SELECT * FROM mcp_oauth_redirect_uris")).toHaveLength(0);
  });

  it("preserves absent versus empty redirect URIs, strings and zero timestamps", () => {
    for (const redirectUris of [undefined, []]) {
      const value = { serverUrl: "", tokens: { accessToken: "", expiresAt: 0, scope: "" }, clientInfo: { clientId: "", ...(redirectUris ? { redirectUris } : {}) } };
      repository.write("x", value); expect(repository.read("x")).toEqual(value);
    }
  });

  it("rejects malformed imports without exposing supplied secrets or changing rows", () => {
    repository.write("server", entry);
    for (const value of [null, [], { tokens: { accessToken: { secret: "do-not-leak" } } }, { clientInfo: { clientId: "x", redirectUris: [123] } }, { tokens: { accessToken: "x", expiresAt: Infinity } }, { access_token: "do-not-leak" }]) {
      expect(() => repository.importAuthEntry("server", value as any)).toThrow(/MCP OAuth/);
      try { decodeLegacyMcpOauthEntry(value); } catch (error) { expect(String(error)).not.toContain("do-not-leak"); }
    }
    expect(() => repository.importHashedAuthEntry("../tokens.json", entry)).toThrow("storage key");
    expect(repository.read("server")).toEqual(entry);
  });

  it("rolls back partial child writes, outer imports, async callbacks and adapter updates", () => {
    repository.write("server", entry);
    db.exec("CREATE TRIGGER fail_client BEFORE INSERT ON mcp_oauth_clients BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(() => repository.write("server", { ...entry, oauthState: "changed" })).toThrow("injected");
    expect(repository.read("server")).toEqual(entry);
    expect(() => createMcpAuth(repository).updateTokens("server", { accessToken: "changed" }, url)).toThrow("injected");
    expect(repository.read("server")).toEqual(entry);
    db.exec("DROP TRIGGER fail_client");
    expect(() => repository.transaction(() => { repository.write("new", entry); throw new Error("rollback"); })).toThrow("rollback");
    expect(repository.read("new")).toBeUndefined();
    expect(() => repository.transaction(async () => repository.write("async", entry))).toThrow("synchronous");
    expect(repository.read("async")).toBeUndefined();
  });

  it("atomically resets registration, tokens and PKCE, rolling back failure in the second SQL clear", () => {
    repository.write("server", entry);
    const auth = createMcpAuth(repository);
    // write clears tokens, then clients: fail the second logical child clear.
    db.exec("CREATE TRIGGER fail_second_clear BEFORE DELETE ON mcp_oauth_clients BEGIN SELECT RAISE(ABORT, 'injected second clear'); END");
    expect(() => auth.resetRegistration("server")).toThrow("injected second clear");
    expect(repository.read("server")).toEqual(entry);
    const other = openDatabase(join(root, "oauth.sqlite")); connections.push(other);
    expect(new McpOauthRepository(other).read("server")).toEqual(entry);
    db.exec("DROP TRIGGER fail_second_clear");
    const write = vi.spyOn(repository, "write");
    auth.resetRegistration("server");
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
    expect(repository.read("server")).toEqual({ serverUrl: url });
    expect(new McpOauthRepository(other).read("server")).toEqual({ serverUrl: url });
  });

  it("propagates closed and read-only storage failures with no file fallback", async () => {
    const provider = new McpOAuthProvider("server", url, {}, { onRedirect: vi.fn() }, repository);
    db.exec("PRAGMA query_only=ON");
    await expect(provider.saveTokens({ access_token: "mock", token_type: "Bearer" })).rejects.toThrow();
    db.exec("PRAGMA query_only=OFF");
    expect(repository.read("server")).toBeUndefined();
    db.close(); await expect(provider.tokens()).rejects.toThrow("closed");
    await expect(provider.invalidateCredentials("all")).rejects.toThrow("closed");
    expect(existsSync(process.env.MCP_OAUTH_DIR!)).toBe(false);
  });

  it("uses current DB rows across connections without overwriting other OAuth fields", () => {
    const otherDb = openDatabase(db.path); connections.push(otherDb);
    const other = createMcpAuth(new McpOauthRepository(otherDb));
    const auth = createMcpAuth(repository);
    auth.updateTokens("shared", { accessToken: "first" }, url);
    other.updateClientInfo("shared", { clientId: "client" }, url);
    auth.updateCodeVerifier("shared", "verifier", url);
    other.updateOAuthState("shared", "state", url);
    auth.updateTokens("shared", { accessToken: "refreshed", refreshToken: "rotated" }, url);
    expect(repository.read("shared")).toEqual({ serverUrl: url, tokens: { accessToken: "refreshed", refreshToken: "rotated" }, clientInfo: { clientId: "client" }, codeVerifier: "verifier", oauthState: "state" });
  });

  it("preserves exact server-name/global ownership and URL invalidation behavior", () => {
    const auth = createMcpAuth(repository);
    repository.write("server", entry);
    expect(auth.getAuthForUrl("server", url + "/")).toBeUndefined();
    expect(auth.getAuthForUrl("Server", url)).toBeUndefined();
    auth.updateTokens("server", { accessToken: "new-url" }, url + "/");
    expect(repository.read("server")).toEqual({ serverUrl: url + "/", tokens: { accessToken: "new-url" } });
    repository.write("old", { tokens: { accessToken: "no-url" } });
    expect(auth.getAuthForUrl("old", url)).toBeUndefined();
  });

  it("round-trips SDK provider token refresh/client/PKCE and selective invalidation without I/O", async () => {
    const redirect = vi.fn();
    const provider = new McpOAuthProvider("server", url, {}, { onRedirect: redirect }, repository);
    await provider.saveClientInformation({ client_id: "dynamic", client_secret: "secret", redirect_uris: [provider.redirectUrl!] });
    await provider.saveTokens({ access_token: "old", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
    await provider.saveState("state"); await provider.saveCodeVerifier("verifier");
    expect(await provider.state()).toBe("state"); expect(await provider.codeVerifier()).toBe("verifier");
    expect(await provider.clientInformation()).toEqual({ client_id: "dynamic", client_secret: "secret" });
    await provider.redirectToAuthorization(new URL("https://mock.invalid/authorize")); expect(redirect).toHaveBeenCalledTimes(1);
    await provider.saveTokens({ access_token: "refreshed", refresh_token: "rotated", token_type: "Bearer", expires_in: 3600 });
    expect(await provider.tokens()).toMatchObject({ access_token: "refreshed", refresh_token: "rotated" });
    await provider.invalidateCredentials("tokens"); expect(await provider.tokens()).toBeUndefined();
    expect(await provider.codeVerifier()).toBe("verifier");
    await provider.invalidateCredentials("client"); expect(await provider.clientInformation()).toBeUndefined();
    await provider.invalidateCredentials("all"); expect(repository.read("server")).toBeUndefined();
    await expect(provider.redirectToAuthorization(new URL("https://mock.invalid/authorize"))).rejects.toThrow("Re-authentication required");
    expect(existsSync(process.env.MCP_OAUTH_DIR!)).toBe(false);
  });
});
