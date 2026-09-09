import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, bindDatabase, applyStorageMigrations, type Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { settingsMigration } from "../../src/storage/schema/settings.js";
import { ModelCredentialsRepository } from "../../src/storage/repositories/model-settings.js";
import { WorkspacesRepository, SshCredentialsRepository } from "../../src/storage/repositories/workspace-settings.js";
import { McpSettingsRepository } from "../../src/storage/repositories/mcp-settings.js";
import { AuthSessionsRepository } from "../../src/storage/repositories/settings.js";
import type { ModelCredentialProfile } from "../../src/shared/types.js";
import { createCredentialStore, saveModelCredentialProfile, deleteModelCredentialProfile, getModelCredentialProfile, startNativeOAuthConnection, startOAuthLoginJob, getOAuthLoginJob, setOAuthLoginAdapterForTests, setPiCatalogModelsForTests } from "../../src/engine/model-credentials.js";
import { createWorkspace, useWorkspace, removeWorkspace, readWorkspaces, ensureDefaultRegistry, originalWorkspace } from "../../src/workspace/workspace-registry.js";
import { writeMcpConfig, readRedactedMcpConfigText, sanitizeMcpError, restoreRedactedMcpConfig } from "../../src/shared/mcp-settings.js";

let root: string, db: Database, other: Database, repo: ModelCredentialsRepository;
function profile(id = "a", patch: Partial<ModelCredentialProfile> = {}): ModelCredentialProfile {
  return { id, profileKind: "custom_endpoint", name: id, providerSlug: id, protocol: "openai-completions", baseUrl: "https://example.test", authType: "api_key", apiKey: `key-${id}`, requestProfile: "standard", enabled: true, isDefault: false, models: [{ id: "model", reasoning: false }], createdAt: 1, updatedAt: 1, ...patch };
}
const ssh = (id: string) => ({ id, kind: "ssh" as const, description: id, root: ".", host: "example.test", port: 22, user: "test", keyPath: "/external/key", builtin: false as const });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "core-settings-review-"));
  db = openDatabase(join(root, "core.sqlite"));
  applyStorageMigrations(db, [baseStorageMigration, settingsMigration]); bindDatabase(db);
  other = openDatabase(db.path); other.exec("PRAGMA busy_timeout=0");
  repo = new ModelCredentialsRepository(db);
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
  if (sql === "SELECT * FROM model_profiles ORDER BY position") {
    const original = ModelCredentialsRepository.prototype.read;
    vi.spyOn(ModelCredentialsRepository.prototype, "read").mockImplementation(function () {
      const result = original.call(this); interpose(); return result;
    });
  } else {
    const original = db.all.bind(db);
    vi.spyOn(db, "all").mockImplementation((query, ...args) => {
      const rows = original(query, ...args);
      if (query === sql) interpose();
      return rows;
    });
  }
  return () => { expect(attempted).toBe(true); if (blocked) write(); };
}

describe("review: concurrent service operations", () => {
  it("captures refresh identity and revision in one snapshot across the former read gap", async () => {
    const old = profile("a", { authType: "oauth", apiKey: undefined, oauthProviderId: "anthropic", oauthCredentials: { access: "old", refresh: "old-r", expires: 1 } });
    repo.importProfile(old);
    // After read() has assembled the complete profile, before revision() used to run.
    const original = ModelCredentialsRepository.prototype.read;
    let attempted = false, blocked = false;
    const write = () => new ModelCredentialsRepository(other).importProfile({ ...old, oauthCredentials: { access: "edited", refresh: "edited-r", expires: 2 } });
    vi.spyOn(ModelCredentialsRepository.prototype, "read").mockImplementation(function () {
      const result = original.call(this);
      if (!attempted) { attempted = true; try { write(); } catch (e) { if (!String(e).includes("database is locked")) throw e; blocked = true; } }
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
    repo.importProfile(profile()); repo.importProfile(profile("b"));
    const finish = interposeRead("SELECT * FROM model_profiles ORDER BY position", () => other.transaction(() => {
      const r = new ModelCredentialsRepository(other);
      r.importProfile(profile("b", { apiKey: "rotated-b" })); r.importProfile(profile("c"));
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
    repo.importProfile(profile("a", { providerSlug: "anthropic", profileKind: "builtin_provider" }));
    setOAuthLoginAdapterForTests({ login: async () => ({ access: "mock-access", refresh: "mock-refresh", expires: 99 }) });
    const job = await (path === "native" ? startNativeOAuthConnection({ providerId: "anthropic", profileId: "a" }) : startOAuthLoginJob({ providerId: "anthropic", profileId: "a", profile: { name: "reconnected" } }));
    expect(job.status).toBe("completed");
    expect(getModelCredentialProfile("a")?.oauthCredentials?.access).toBe("mock-access");
    const created = await startNativeOAuthConnection({ providerId: "anthropic", name: "new account" });
    expect(created.status).toBe("completed"); expect(created.profileId).not.toBe("a");
  });
  it.each(["native-delete", "native-edit", "native-recreate", "legacy-delete", "legacy-edit", "legacy-recreate"])("rejects %s without resurrecting or overwriting", async scenario => {
    const original = profile("a", { providerSlug: "anthropic", profileKind: "builtin_provider" }); repo.importProfile(original);
    let release!: (value: any) => void;
    setOAuthLoginAdapterForTests({ login: async (_provider, callbacks) => {
      callbacks.onAuth({ url: "https://mock.invalid/login" });
      return new Promise(resolve => { release = resolve; });
    } });
    const job = await (scenario.startsWith("native") ? startNativeOAuthConnection({ providerId: "anthropic", profileId: "a" }) : startOAuthLoginJob({ providerId: "anthropic", profileId: "a", profile: { name: "login captured" } }));
    const writer = new ModelCredentialsRepository(other);
    if (!scenario.endsWith("edit")) writer.replace({ profiles: [], migrations: [] });
    if (!scenario.endsWith("delete")) writer.importProfile({ ...original, name: "concurrent", apiKey: "new-secret" });
    const before = repo.read();
    release({ access: "stale-login", refresh: "stale-refresh", expires: 99 });
    await vi.waitFor(() => expect(getOAuthLoginJob(job.id)?.status).toBe("failed"));
    expect(getOAuthLoginJob(job.id)?.error).toMatch(/changed|deleted/i);
    expect(repo.read()).toEqual(before);
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
    repo.importProfile(profile()); const revision = repo.revision("a");
    expect(() => db.transaction(() => { repo.importProfile(profile("a", { name: "rollback" })); db.run(sql); })).toThrow(/NOT NULL/);
    expect(repo.read().profiles).toEqual([profile()]); expect(repo.revision("a")).toBe(revision);
  });
  it.each(["profile", "migration", "mcp-owner", "workspace-owner", "workspace-id", "ssh-owner", "session-hash"])("NULL %s rejects and rolls back an importer batch", kind => {
    repo.importProfile(profile()); const before = repo.read();
    expect(() => db.transaction(() => {
      repo.importProfile(profile("a", { name: "must rollback" }));
      switch (kind) {
        case "profile": repo.importProfile({ ...profile(), id: null as any, models: [] }); break;
        case "migration": repo.replace({ profiles: [profile()], migrations: [null as any] }); break;
        case "mcp-owner": new McpSettingsRepository(db, null as any).importConfig({ mcpServers: {} }); break;
        case "workspace-owner": new WorkspacesRepository(db).importRegistry(null as any, { active: "original", workspaces: [originalWorkspace("m")] }); break;
        case "workspace-id": new WorkspacesRepository(db).importRegistry("m", { active: "original", workspaces: [originalWorkspace("m"), { ...ssh("x"), id: null as any }] }); break;
        case "ssh-owner": new SshCredentialsRepository(db).importKey(null as any, { privateKey: "private", publicKey: "public" }); break;
        case "session-hash": new AuthSessionsRepository(db).importSessionHash(null as any, 100); break;
      }
    })).toThrow();
    expect(repo.read()).toEqual(before);
    for (const table of ["credential_migrations", "mcp_config", "workspace_registries", "workspaces", "ssh_credentials", "auth_sessions"]) expect(db.all(`SELECT * FROM ${table}`)).toEqual([]);
  });
});
