import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, bindDatabase, applyStorageMigrations, type Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { settingsMigration } from "../../src/storage/schema/settings.js";
import { SettingsRepository } from "../../src/storage/repositories/settings.js";
import { McpSettingsRepository } from "../../src/storage/repositories/mcp-settings.js";
import { WorkspacesRepository, SshCredentialsRepository } from "../../src/storage/repositories/workspace-settings.js";
import { configExists, readConfig, writeConfig, getDefaultConfig, getConfigPath, getBossmodeDir, hashPassword } from "../../src/shared/config.js";
import { login, validateToken, getSessionExpiresAtForTests, setSessionRemainingForTests, SESSION_TTL_MS } from "../../src/api/auth.js";
import { readMcpConfigText, writeMcpConfig, readRedactedMcpConfigText, readMemberMcpConfig, writeMemberMcpConfig, writeMemberScopedMcpConfig, readMcpStatusCache, writeMcpStatusCache, sanitizeMcpError } from "../../src/shared/mcp-settings.js";
import { readWorkspaces, createWorkspace, useWorkspace, removeWorkspace, workspacesJsonPath, ensureDefaultRegistry } from "../../src/workspace/workspace-registry.js";
import { ensureMemberSshKeyPair, memberSshKeyPath, readMemberSshPublicKey, readWorkspaceSshPrivateKey, materializeMemberSshCredential } from "../../src/workspace/ssh-keygen.js";

let root: string;
let db: Database;
function open() { db=openDatabase(join(root,"core.sqlite")); applyStorageMigrations(db,[baseStorageMigration,settingsMigration]); bindDatabase(db); }
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"core-settings-fixture-"));open();});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});rmSync(getConfigPath(),{force:true});});

describe("settings and auth DB authority",()=>{
  it("does not consult or rewrite legacy configuration",()=>{
    mkdirSync(dirname(getConfigPath()),{recursive:true});
    writeFileSync(getConfigPath(),'{"legacy-secret":"not-authority"}');
    expect(configExists()).toBe(false); expect(()=>readConfig()).toThrow("not initialized");
    const config={...getDefaultConfig(),auth:{username:"fish",passwordHash:hashPassword("password")},apiKeys:{provider:"secret"},memoryBudgets:{persona:4000},catalog:{autoRefreshIntervalDays:0}};
    writeConfig(config); expect(readConfig()).toEqual(config);
    expect(readFileSync(getConfigPath(),"utf8")).toContain("not-authority");
    expect(db.get<any>("SELECT host,port FROM app_settings")).toEqual({host:"127.0.0.1",port:8080});
    expect(db.get<any>("SELECT api_key FROM provider_api_keys")?.api_key).toBe("secret");
    db.close();open();expect(readConfig()).toEqual(config);
  });
  it("rolls back all configuration fields on a failing import",()=>{
    writeConfig(getDefaultConfig());
    db.exec("CREATE TRIGGER reject_key BEFORE INSERT ON provider_api_keys BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(()=>new SettingsRepository(db).importConfig({...getDefaultConfig(),defaults:{host:"changed",port:9000},apiKeys:{p:"secret"}})).toThrow("injected");
    expect(readConfig()).toEqual(getDefaultConfig());
  });
  it("persists only token hashes, survives reopen, slides and expires",()=>{
    writeConfig({...getDefaultConfig(),auth:{username:"u",passwordHash:hashPassword("p")}});
    expect(login("u","wrong")).toBeNull();
    const session=login("u","p")!; expect(session.token).toHaveLength(64);
    expect(JSON.stringify(db.all("SELECT * FROM auth_sessions"))).not.toContain(session.token);
    db.close();open();expect(validateToken(session.token)).toBe(true);
    setSessionRemainingForTests(session.token,1000);expect(validateToken(session.token)).toBe(true);
    expect(getSessionExpiresAtForTests(session.token)!).toBeGreaterThan(Date.now()+SESSION_TTL_MS-1000);
    setSessionRemainingForTests(session.token,-1);expect(validateToken(session.token)).toBe(false);
    expect(getSessionExpiresAtForTests(session.token)).toBeNull();
  });
  it("missing or closed DB fails instead of file fallback",()=>{
    writeConfig(getDefaultConfig()); db.close();
    expect(getBossmodeDir()).toBe(process.env.BOSSMODE_DIR);
    expect(getConfigPath()).toContain("config.json");
    expect(()=>readConfig()).toThrow("bootstrap");
    expect(()=>readMcpConfigText()).toThrow("bootstrap");
    expect(()=>readWorkspaces("member")).toThrow("bootstrap");
  });
});

describe("MCP normalized configuration and restricted derived input",()=>{
  const config={mcpServers:{test:{command:"node",args:["a","b"],env:{CUSTOM_VALUE:"hidden-env"},headers:{Authorization:"hidden-header"},sampling:true},http:{url:"https://example.test/mcp"}},settings:{timeout:500}};
  it("round-trips global and member config independently and redacts secrets",()=>{
    writeMcpConfig(config);writeMemberMcpConfig("a",{mcpServers:{own:{command:"echo",args:[]}}});
    expect(JSON.parse(readMcpConfigText())).toEqual(config);
    expect(readMemberMcpConfig("a")).toEqual({mcpServers:{own:{command:"echo",args:[]}}});
    expect(readMemberMcpConfig("b")).toBeNull();
    expect(db.all("SELECT value FROM mcp_server_args WHERE owner_id='global' ORDER BY position")).toEqual([{value:"a"},{value:"b"}]);
    const publicText=readRedactedMcpConfigText().configText;
    expect(publicText).not.toContain("hidden-env");expect(publicText).not.toContain("hidden-header");
    expect(sanitizeMcpError("hidden-env hidden-header",config.mcpServers.test)).toBe("[REDACTED] [REDACTED]");
    const status={test:{name:"test",status:"available" as const,toolCount:2,checkedAt:100,configHash:"hash"}};
    writeMcpStatusCache(status); db.close();open();expect(readMcpStatusCache()).toEqual(status);expect(JSON.parse(readMcpConfigText())).toEqual(config);
  });
  it("normalizes transport, auth, OAuth and global adapter business fields",()=>{
    const all={imports:["vscode"],mcpServers:{remote:{url:"https://test/mcp",cwd:"/tmp",auth:"oauth",bearerToken:"bearer-secret",bearerTokenEnv:"TOKEN",lifecycle:"lazy",idleTimeout:2,requestTimeoutMs:500,exposeResources:true,debug:false,directTools:["read"],excludeTools:["write"],oauth:{grantType:"client_credentials",clientId:"id",clientSecret:"client-secret",scope:"scope",redirectUri:"http://localhost",clientName:"name",clientUri:"https://test"}}},settings:{toolPrefix:"server",idleTimeout:10,requestTimeoutMs:1000,directTools:false,disableProxyTool:true,autoAuth:false,sampling:false,samplingAutoApprove:false,elicitation:false,authRequiredMessage:"auth",outputGuard:{maxBytes:100,maxLines:10,detailsMaxBytes:50}}};
    writeMcpConfig(all);expect(JSON.parse(readMcpConfigText())).toEqual(all);
    expect(db.get<any>("SELECT auth,lifecycle,request_timeout_ms FROM mcp_servers")).toEqual({auth:"oauth",lifecycle:"lazy",request_timeout_ms:500});
    expect(db.get<any>("SELECT extension_json FROM mcp_servers")?.extension_json).toBe("{}");
    expect(db.get<any>("SELECT settings_extension_json FROM mcp_config")?.settings_extension_json).toBe("{}");
    const publicText=readRedactedMcpConfigText().configText;expect(publicText).not.toContain("bearer-secret");expect(publicText).not.toContain("client-secret");
  });
  it("validates JSON and transactionally rejects broken server rows",()=>{
    writeMcpConfig(config);
    expect(()=>new McpSettingsRepository(db).importConfig({mcpServers:{bad:{command:123}}})).toThrow("Invalid MCP");
    expect(JSON.parse(readMcpConfigText())).toEqual(config);
  });
  it("materializes a private filtered copy with explicit cleanup, not a second authority",()=>{
    writeMemberMcpConfig("a",config);
    const derived=writeMemberScopedMcpConfig({roomId:"room",memberId:"a"});
    try {
      expect(statSync(dirname(derived.configPath)).mode & 0o777).toBe(0o700);
      expect(statSync(derived.configPath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(derived.configPath,"utf8")).mcpServers.test.sampling).toBe(false);
      writeFileSync(derived.configPath,"{}");expect(readMemberMcpConfig("a")).toEqual(config);
    } finally {derived.dispose();}
    expect(existsSync(derived.configPath)).toBe(false);
  });
});

describe("workspaces and SSH credentials",()=>{
  it("preserves active pointer and external key references without writing a registry file",()=>{
    const id="settings-workspaces-test";
    ensureDefaultRegistry(id);expect(readWorkspaces(id).active).toBe("original");
    expect(createWorkspace(id,{id:"remote",kind:"ssh",host:"test",user:"fish",keyPath:"/external/key"}).ok).toBe(true);
    expect(useWorkspace(id,"remote").ok).toBe(true);
    expect(existsSync(workspacesJsonPath(id))).toBe(false);
    db.close();open();expect(readWorkspaces(id).active).toBe("remote");
    expect(readWorkspaces(id).workspaces[1]).toMatchObject({keyPath:"/external/key"});
    expect(removeWorkspace(id,"remote").ok).toBe(true);expect(readWorkspaces(id).active).toBe("original");
    expect(removeWorkspace(id,"original").ok).toBe(false);
    expect(()=>new WorkspacesRepository(db).importRegistry(id,{active:"missing",workspaces:[]})).toThrow("Active");
  });
  it("stores owned keys in DB and explicitly disposes derived material",()=>{
    const id="settings-ssh-test";
    new SshCredentialsRepository(db).importKey(id,{privateKey:"private",publicKey:"public",config:"Host test"});
    expect(ensureMemberSshKeyPair(id)).toBe("public");expect(readMemberSshPublicKey(id)).toBe("public");
    expect(existsSync(memberSshKeyPath(id))).toBe(false);
    expect(readWorkspaceSshPrivateKey(id,memberSshKeyPath(id)).toString()).toBe("private");
    const external=join(root,"external");writeFileSync(external,"external-key");
    expect(readWorkspaceSshPrivateKey(id,external).toString()).toBe("external-key");
    const material=materializeMemberSshCredential(id);
    try {
      expect(statSync(material.keyPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(material.configPath!,"utf8")).toBe("Host test");
      writeFileSync(material.keyPath,"tampered");
      expect(readWorkspaceSshPrivateKey(id,memberSshKeyPath(id)).toString()).toBe("private");
    } finally {material.dispose();}
    expect(existsSync(material.keyPath)).toBe(false);
  });
  it("generates a new key through a temporary keygen directory only",()=>{
    const id="settings-generated-key";
    const publicKey=ensureMemberSshKeyPair(id);expect(publicKey).toMatch(/^ssh-ed25519 /);
    expect(ensureMemberSshKeyPair(id)).toBe(publicKey);
    expect(existsSync(memberSshKeyPath(id))).toBe(false);
    expect(new SshCredentialsRepository(db).read(id)?.privateKey).toContain("OPENSSH PRIVATE KEY");
  });
});
