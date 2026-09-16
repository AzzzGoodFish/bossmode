import { importAuthSession } from "../../src/api/auth.js";
import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, bindDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");
const settingsMigration = getMigration("core-settings-v1");
import { importModelProfile, replaceCredentialStore, readCredentialStore, credentialRevision } from "../../src/config/models.js";
import { WorkspacesRepository, SshCredentialsRepository } from "../../src/data/repositories/workspace-settings.js";
import { McpSettingsRepository } from "../../src/data/repositories/mcp-settings.js";

import type { ModelCredentialProfile } from "../../src/kernel/types.js";
import { saveModelCredentialProfile, deleteModelCredentialProfile, getModelCredentialProfile } from "../../src/config/models.js";
import { startNativeOAuthConnection, startOAuthLoginJob, getOAuthLoginJob, setOAuthLoginAdapterForTests } from "../../src/config/oauth.js";
import { setPiCatalogModelsForTests } from "../../src/config/catalog.js";
import { createCredentialStore } from "../../src/config/pi-adapt/credentials.js";
import { createWorkspace, useWorkspace, removeWorkspace, readWorkspaces, ensureDefaultRegistry, originalWorkspace } from "../../src/member/workspaces/workspace-registry.js";
import { writeMcpConfig, readRedactedMcpConfigText, sanitizeMcpError, restoreRedactedMcpConfig } from "../../src/member/mcp/mcp-settings.js";

let root: string, db: Database, other: Database, repo: Database;
function profile(id = "a", patch: Partial<ModelCredentialProfile> = {}): ModelCredentialProfile {
  return { id, profileKind: "custom_endpoint", name: id, providerSlug: id, protocol: "openai-completions", baseUrl: "https://example.test", authType: "api_key", apiKey: `key-${id}`, requestProfile: "standard", enabled: true, isDefault: false, models: [{ id: "model", reasoning: false }], createdAt: 1, updatedAt: 1, ...patch };
}
const ssh = (id: string) => ({ id, kind: "ssh" as const, description: id, root: ".", host: "example.test", port: 22, user: "test", keyPath: "/external/key", builtin: false as const });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "core-settings-review-"));
  db = openDatabase(join(root, "core.sqlite"));
  applyStorageMigrations(db, [baseStorageMigration, settingsMigration]); bindDatabase(db);
  other = openDatabase(db.path); other.exec("PRAGMA busy_timeout=0");
  repo = db;
  setPiCatalogModelsForTests([{ provider: "anthropic", id: "model", api: "anthropic-messages", baseUrl: "https://example.test", input: ["text"] }]);
});
afterEach(() => { vi.restoreAllMocks(); setOAuthLoginAdapterForTests(null); setPiCatalogModelsForTests(null); other.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

// Interpose precisely after the old service read. A short write transaction blocks
// the second connection; retry after it exits, just as a real competing writer does.
function interposeRead(sql: string, write: () => void) {
  let attempted = false, blocked = false;
  const interpose = () => {
    if (attempted) return;
    attempted = true;
    try { write(); } catch (error) {
      if (!String(error).includes("database is locked")) throw error;
      blocked = true;
    }
  };
  if (sql === "SELECT * FROM model_profiles ORDER BY position") sql = "SELECT id FROM credential_migrations ORDER BY id";
  const original = db.all.bind(db);
  vi.spyOn(db, "all").mockImplementation((query, ...args) => {
    const rows = original(query, ...args);
    if (query === sql) interpose();
    return rows;
  });
  return () => { expect(attempted).toBe(true); if (blocked) write(); };
}

describe("review: concurrent service operations", () => {
  it("captures refresh identity and revision in one snapshot across the former read gap", async () => {
    const old = profile("a", { authType: "oauth", apiKey: undefined, oauthProviderId: "anthropic", oauthCredentials: { access: "old", refresh: "old-r", expires: 1 } });
    importModelProfile(old, undefined, repo);
    // After read() has assembled the complete profile, before revision() used to run.
    const original = db.all.bind(db);
    let attempted = false, blocked = false;
    const write = () => importModelProfile({ ...old, oauthCredentials: { access: "edited", refresh: "edited-r", expires: 2 } }, undefined, other);
    vi.spyOn(db, "all").mockImplementation((query, ...args) => {
      const result = original(query, ...args);
      if (query === "SELECT id FROM credential_migrations ORDER BY id" && !attempted) { attempted = true; try { write(); } catch (e) { if (!String(e).includes("database is locked")) throw e; blocked = true; } }
      return result;
    });
    const result = await createCredentialStore(old).modify("a", async current => {
      expect((current as any).access).toBe("old");
      if (blocked) write(); // Also proves no transaction spans provider IO.
      return { type: "oauth", access: "stale", refresh: "stale-r", expires: 99 };
    });
    expect(attempted).toBe(true);
    expect((result as any).access).toBe("edited");
    expect(getModelCredentialProfile("a")?.oauthCredentials?.access).toBe("edited");
  });
  it.each(["save", "delete"])("%s preserves unrelated concurrent account secrets and additions", operation => {
    importModelProfile(profile(), undefined, repo); importModelProfile(profile("b"), undefined, repo);
    const finish = interposeRead("SELECT * FROM model_profiles ORDER BY position", () => other.transaction(() => {
      const r = other;
      importModelProfile(profile("b", { apiKey: "rotated-b" }), undefined, r); importModelProfile(profile("c"), undefined, r);
    }));
    if (operation === "save") saveModelCredentialProfile({ ...profile(), name: "renamed" });
    else expect(deleteModelCredentialProfile("a")).toBe(true);
    finish();
    expect(getModelCredentialProfile("b")?.apiKey).toBe("rotated-b");
    expect(getModelCredentialProfile("c")?.apiKey).toBe("key-c");
    expect(getModelCredentialProfile("a")?.name).toBe(operation === "save" ? "renamed" : undefined);
  });
  it.each(["register", "switch", "remove"])("workspace %s preserves concurrent additions", operation => {
    ensureDefaultRegistry("member"); createWorkspace("member", ssh("first"));
    const finish = interposeRead("SELECT * FROM workspaces WHERE member_id=? ORDER BY position", () => {
      const r = new WorkspacesRepository(other), registry = r.read("member")!;
      r.importRegistry("member", { ...registry, workspaces: [...registry.workspaces, ssh("concurrent")] });
    });
    const result = operation === "register" ? createWorkspace("member", ssh("second")) : operation === "switch" ? useWorkspace("member", "first") : removeWorkspace("member", "first");
    expect(result.ok).toBe(true); finish();
    const registry = readWorkspaces("member");
    expect(registry.workspaces.map(w => w.id)).toContain("concurrent");
    expect(registry.active).toBe(operation === "switch" ? "first" : "original");
  });
});

describe("review: paused MOCK application OAuth login, no provider network", () => {
  it.each(["native", "legacy"] as const)("%s completes unchanged and new profiles", async path => {
    importModelProfile(profile("a", { providerSlug: "anthropic", profileKind: "builtin_provider" }), undefined, repo);
    setOAuthLoginAdapterForTests({ login: async () => ({ access: "mock-access", refresh: "mock-refresh", expires: 99 }) });
    const job = await (path === "native" ? startNativeOAuthConnection({ providerId: "anthropic", profileId: "a" }) : startOAuthLoginJob({ providerId: "anthropic", profileId: "a", profile: { name: "reconnected" } }));
    expect(job.status).toBe("completed");
    expect(getModelCredentialProfile("a")?.oauthCredentials?.access).toBe("mock-access");
    const created = await startNativeOAuthConnection({ providerId: "anthropic", name: "new account" });
    expect(created.status).toBe("completed"); expect(created.profileId).not.toBe("a");
  });
  it.each(["native-delete", "native-edit", "native-recreate", "legacy-delete", "legacy-edit", "legacy-recreate"])("rejects %s without resurrecting or overwriting", async scenario => {
    const original = profile("a", { providerSlug: "anthropic", profileKind: "builtin_provider" }); importModelProfile(original, undefined, repo);
    let release!: (value: any) => void;
    setOAuthLoginAdapterForTests({ login: async (_provider, callbacks) => {
      callbacks.onAuth({ url: "https://mock.invalid/login" });
      return new Promise(resolve => { release = resolve; });
    } });
    const job = await (scenario.startsWith("native") ? startNativeOAuthConnection({ providerId: "anthropic", profileId: "a" }) : startOAuthLoginJob({ providerId: "anthropic", profileId: "a", profile: { name: "login captured" } }));
    const writer = other;
    if (!scenario.endsWith("edit")) replaceCredentialStore({ profiles: [], migrations: [] }, writer);
    if (!scenario.endsWith("delete")) importModelProfile({ ...original, name: "concurrent", apiKey: "new-secret" }, undefined, writer);
    const before = readCredentialStore(repo);
    release({ access: "stale-login", refresh: "stale-refresh", expires: 99 });
    await vi.waitFor(() => expect(getOAuthLoginJob(job.id)?.status).toBe("failed"));
    expect(getOAuthLoginJob(job.id)?.error).toMatch(/changed|deleted/i);
    expect(readCredentialStore(repo)).toEqual(before);
  });
});

describe("review: MCP credential arguments", () => {
  it("redacts split and flag=value credentials in public config and errors, preserving nonsecrets and round trips", () => {
    const args = ["server.js", "--api-key", "credential-sentinel", "--client-secret=client-sentinel", "--access_token=access-sentinel", "--password", "password-sentinel", "--port", "8080", "--verbose", "--mode=stdio", "--max-tokens=1000", "--tokenizer=default"];
    const server = { command: "node", args }, config = { mcpServers: { test: server } };
    writeMcpConfig(config);
    const text = readRedactedMcpConfigText().configText;
    const publicConfig = JSON.parse(text);
    const error = sanitizeMcpError(`failed: ${args.join(" ")} (client-sentinel)`, server);
    for (const secret of ["credential-sentinel", "client-sentinel", "access-sentinel", "password-sentinel"]) {
      expect(text).not.toContain(secret); expect(error).not.toContain(secret);
    }
    for (const nonsecret of ["server.js", "--port", "8080", "--verbose", "--mode=stdio", "--max-tokens=1000", "--tokenizer=default"]) {
      expect(publicConfig.mcpServers.test.args).toContain(nonsecret); expect(error).toContain(nonsecret);
    }
    expect(restoreRedactedMcpConfig(publicConfig, config)).toEqual(config);
  });
});

describe("review: settings import identities", () => {
  it("declares every settings primary-key column NOT NULL, including composite keys", () => {
    const tables = [...settingsMigration.sql.matchAll(/CREATE TABLE (\w+)/g)].map(m => m[1]);
    for (const table of tables) for (const column of db.all<any>(`PRAGMA table_info(${table})`).filter(c => c.pk)) {
      expect(column.notnull, `${table}.${column.name}`).toBe(1);
    }
  });
  it.each([
    "INSERT INTO model_secrets(profile_id,api_key) VALUES(NULL,'secret')",
    "INSERT INTO provider_api_keys VALUES(NULL,'secret')",
    "INSERT INTO catalog_snapshots(id) VALUES(NULL)",
    "INSERT INTO mcp_status(server_name,name,status) VALUES(NULL,'test','unknown')",
    "INSERT INTO workspace_registries VALUES(NULL,'original')",
    "INSERT INTO auth_sessions VALUES(NULL,100)",
  ])("SQL NULL identity rejects atomically: %s", sql => {
    importModelProfile(profile(), undefined, repo); const revision = credentialRevision("a", repo);
    expect(() => db.transaction(() => { importModelProfile(profile("a", { name: "rollback" }), undefined, repo); db.run(sql); })).toThrow(/NOT NULL/);
    expect(readCredentialStore(repo).profiles).toEqual([profile()]); expect(credentialRevision("a", repo)).toBe(revision);
  });
  it.each(["profile", "migration", "mcp-owner", "workspace-owner", "workspace-id", "ssh-owner", "session-hash"])("NULL %s rejects and rolls back an importer batch", kind => {
    importModelProfile(profile(), undefined, repo); const before = readCredentialStore(repo);
    expect(() => db.transaction(() => {
      importModelProfile(profile("a", { name: "must rollback" }), undefined, repo);
      switch (kind) {
        case "profile": importModelProfile({ ...profile(), id: null as any, models: [] }, undefined, repo); break;
        case "migration": replaceCredentialStore({ profiles: [profile()], migrations: [null as any] }, repo); break;
        case "mcp-owner": new McpSettingsRepository(db, null as any).importConfig({ mcpServers: {} }); break;
        case "workspace-owner": new WorkspacesRepository(db).importRegistry(null as any, { active: "original", workspaces: [originalWorkspace("m")] }); break;
        case "workspace-id": new WorkspacesRepository(db).importRegistry("m", { active: "original", workspaces: [originalWorkspace("m"), { ...ssh("x"), id: null as any }] }); break;
        case "ssh-owner": new SshCredentialsRepository(db).importKey(null as any, { privateKey: "private", publicKey: "public" }); break;
        case "session-hash": importAuthSession(null as any, 100, db); break;
      }
    })).toThrow();
    expect(readCredentialStore(repo)).toEqual(before);
    for (const table of ["credential_migrations", "mcp_config", "workspace_registries", "workspaces", "ssh_credentials", "auth_sessions"]) expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
  });
});
