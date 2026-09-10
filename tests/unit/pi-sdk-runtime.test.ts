import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";

vi.mock("../../src/workspace/extension-store.js", () => ({
  resolveMemberExtensionPaths: () => [],
  resolveMemberExtensionSkillPaths: () => [],
}));

import { coreFixture } from "../helpers/core-fixture.js";
const mcpFactory = { name: "pi-mcp-adapter", factory: vi.fn() };
const loadDatabaseMcpFactory = vi.fn(async (_path: string) => mcpFactory);
vi.mock("../../src/engine/runtime/mcp-factory.js", () => ({ loadDatabaseMcpFactory }));
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
let exportedConfig: any = null;
let bossmodeConfig: any;
const modelRegistryCreate = vi.fn();
const modelRegistryRefresh = vi.fn();
const databaseRuntimeRefresh = vi.fn(async (_runtime: unknown, _profileId?: string) => {});
const modelRuntime = { kind: "database-runtime", refresh: modelRegistryRefresh, getAuth: vi.fn(), checkAuth: vi.fn() };
const modelRegistryGetApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "sk-test" }));
const createAgentSession = vi.fn();
const resourceLoaderCtor = vi.fn();
let hostedMcpLoaded = true;
const toolsFactory = vi.fn();
const sessionManagerCreate = vi.fn();
const sessionManagerOpen = vi.fn();
const settingsManagerCreate = vi.fn();
const settingsApplyOverrides = vi.fn();
const settingsGetTransport = vi.fn(() => "auto");
const settingsGetWebSocketConnectTimeoutMs = vi.fn(() => 60000);
const settingsGetHttpIdleTimeoutMs = vi.fn(() => 600000);
const settingsGetCompactionSettings = vi.fn(() => ({ enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 }));
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();
const sessionExtensionSetFlagValue = vi.fn();
const sessionExtensionEmit = vi.fn(async () => {});
const sessionExtensionHasHandlers = vi.fn(() => false);
const sessionBindExtensions = vi.fn(async () => {});
let activeToolNames: string[] = [];
let ignoreActiveToolChanges = false;
let openedSessionModel: { provider: string; modelId: string } | null = null;
let openedLeafEntry: any = null;
const sessionBranch = vi.fn();
const sessionResetLeaf = vi.fn();

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => join(dir, ".bossmode"),
  readConfig: () => bossmodeConfig,
}));

vi.mock("../../src/engine/model-credentials.js", () => ({
  getBossmodePiRuntimeRoot: () => join(dir, "pi-agent", "runtime"),
  createDatabaseModelRuntime: async (credentials: unknown, profileId: string) => { modelRegistryCreate(credentials, profileId); return modelRuntime; },
  refreshDatabaseModelRuntime: databaseRuntimeRefresh,
  exportPiConfigForMember: () => exportedConfig,
  normalizeModelRef: (modelRef: string) => modelRef,
  createCredentialStore: (profile: any) => ({ kind: "credentials", profile, read: vi.fn(), list: vi.fn(async () => []), modify: vi.fn(), delete: vi.fn() }),
  getModelCredentialProfile: (id: string) => ({ id, providerSlug: "anthropic", enabled: true, name: "Test account" }),
  // Faithful room-scope shape (topic/dm branches not exercised in this suite).
  resolvePiAgentDir: (roomIdOrScope: string, memberIdOrName: string) =>
    join(dir, "pi-agent", "runtime", String(roomIdOrScope).replace(/[^a-zA-Z0-9._-]+/g, "_"), String(memberIdOrName).replace(/[^a-zA-Z0-9._-]+/g, "_")),
}));

// Live customTools factory — sole source for "bossmode" classification (no static name whitelist).
vi.mock("../../src/engine/runtime/bossmode-sdk-tools.js", () => ({
  createBossmodeSdkTools: (opts: any) => { toolsFactory(opts); return [
    { name: "query_room_messages" },
    { name: "wait" },
    { name: "create_task" },
  ]; },
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader {
    constructor(options: any) { resourceLoaderCtor(options); }
    async reload() {}
    getExtensions() { return { extensions: hostedMcpLoaded ? [{path:"<inline:pi-mcp-adapter>",tools:new Map([["mcp", {}]])}] : [], errors: [] }; }
  }
  return {
    VERSION: "test-sdk",
    ModelRegistry: class {
      constructor(public runtime: any) {}
      find(provider: string, id: string) { return { provider, id }; }
      getApiKeyAndHeaders(...args: any[]) { return modelRegistryGetApiKeyAndHeaders(...args); }
      async refresh(...args: any[]) { return modelRegistryRefresh(...args); }
    },
    SettingsManager: {
      create: (...args: any[]) => {
        settingsManagerCreate(...args);
        return {
          kind: "settings",
          args,
          applyOverrides: settingsApplyOverrides,
          getTransport: settingsGetTransport,
          getWebSocketConnectTimeoutMs: settingsGetWebSocketConnectTimeoutMs,
          getHttpIdleTimeoutMs: settingsGetHttpIdleTimeoutMs,
          getCompactionSettings: settingsGetCompactionSettings,
        };
      },
    },
    SessionManager: {
      create: (...args: any[]) => {
        sessionManagerCreate(...args);
        return { kind: "created-session", args, buildSessionContext: () => ({ model: null }) };
      },
      open: (...args: any[]) => {
        sessionManagerOpen(...args);
        return {
          kind: "opened-session",
          args,
          buildSessionContext: () => ({ model: openedSessionModel }),
          getLeafEntry: () => openedLeafEntry,
          branch: sessionBranch,
          resetLeaf: sessionResetLeaf,
        };
      },
    },
    DefaultResourceLoader,
    createAgentSession: async (...args: any[]) => {
      const result = await createAgentSession(...args);
      result.session.modelRuntime = args[0].modelRuntime;
      result.session.model = { ...args[0].model, contextWindow: result.session.model?.contextWindow };
      // SDK holds the exact supplied model object.
      Object.assign(args[0].model, result.session.model);
      result.session.model = args[0].model;
      return result;
    },
  };
});

function baseOpts(overrides: Record<string, any> = {}) {
  return {
    cwd: dir,
    roomId: "room-a",
    member: { id: "pm", name: "pm", agent: "pm", runtime: "pi-cli", model: "anthropic/claude-sonnet-4-6", credentialId: "cred-a", thinkingLevel: "off" },
    agentPrompt: "agent prompt",
    envPrompt: "env prompt",
    skillPaths: [],
    roomMembers: ["pm"],
    callbacks: { onChat: vi.fn(), onMention: vi.fn() },
    ...overrides,
  };
}

function savedSessionFile(): string {
  const path = join(dir, "old-session.jsonl");
  writeFileSync(path, "{}\n");
  return path;
}

const createdHandles: any[] = [];
beforeEach(async () => {
  fixture = coreFixture(); dir = fixture.root;
  hostedMcpLoaded = true;
  // Each binding wraps the runtime public auth methods; never reuse an attached runtime.
  modelRuntime.refresh = modelRegistryRefresh;
  modelRuntime.getAuth = vi.fn();
  modelRuntime.checkAuth = vi.fn();
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('pm','pm','pm','general','{}',0,0)");
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('room-a','room','room-a')");
  const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
  const create = PiSdkRuntime.prototype.createAgent;
  vi.spyOn(PiSdkRuntime.prototype, "createAgent").mockImplementation(async function(opts) {
    const handle = await create.call(this, opts); createdHandles.push(handle); return handle;
  });
});
afterEach(async () => {
  try { for (const handle of createdHandles) await handle.destroyAndWait(); }
  finally { createdHandles.length = 0; vi.restoreAllMocks(); fixture.close(); }
});

describe("PiSdkRuntime", () => {
  beforeEach(() => {
    exportedConfig = null;
    openedSessionModel = null;
    openedLeafEntry = null;
    activeToolNames = [];
    ignoreActiveToolChanges = false;
    vi.clearAllMocks();
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: false } };
    settingsGetTransport.mockReturnValue("auto");
    settingsGetWebSocketConnectTimeoutMs.mockReturnValue(60000);
    modelRegistryGetApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: "sk-test" });
    settingsGetHttpIdleTimeoutMs.mockReturnValue(600000);
    settingsGetCompactionSettings.mockReturnValue({ enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 });
    createAgentSession.mockResolvedValue({
      session: {
        modelRuntime,
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        steer: vi.fn(),
        abort: vi.fn(),
        abortCompaction: vi.fn(),
        abortBranchSummary: vi.fn(),
        dispose: vi.fn(),
        reload: vi.fn(async (options?: any) => { await options?.beforeSessionStart?.(); }),
        compact: vi.fn(),
        setModel: vi.fn(),
        setThinkingLevel: vi.fn(),
        setActiveToolsByName: vi.fn((names: string[]) => { if (!ignoreActiveToolChanges) activeToolNames = names; }),
        getActiveToolNames: vi.fn(() => activeToolNames),
        getAllTools: vi.fn(() => activeToolNames.map((name: string) => ({ name }))),
        bindExtensions: sessionBindExtensions,
        extensionRunner: {
          setFlagValue: sessionExtensionSetFlagValue,
          emit: sessionExtensionEmit,
          hasHandlers: sessionExtensionHasHandlers,
        },
        sessionId: "session-a",
        sessionFile: join(dir, "session.json"),
        thinkingLevel: "off",
        settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
        model: { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 18000 },
      },
    });
  });


  it("throws setup guidance instead of falling back to SDK default auth when no Bossmode credential profile exists", async () => {
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await expect(new PiSdkRuntime().createAgent(baseOpts())).rejects.toThrow("Go to Settings → Model Credentials");

    expect(modelRegistryCreate).not.toHaveBeenCalled();
  });

  it("creates the runtime from the database adapter with the selected profile", async () => {
    const agentDir = join(dir, "profile-agent-dir");
    exportedConfig = { agentDir, extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(modelRegistryCreate).toHaveBeenCalledWith(expect.objectContaining({ read: expect.any(Function), modify: expect.any(Function) }), "test-profile");
  });

  it("warns when a run crosses compaction threshold but SDK emits no compaction event", async () => {
    let listener: ((event: any) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", usage: { input: 17000, output: 1500, cacheRead: 0, cacheWrite: 0, totalTokens: 18500 } },
      });
      listener?.({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 14, cacheRead: 0, cacheWrite: 0, totalTokens: 24 } },
      });
    });
    createAgentSession.mockResolvedValueOnce({
      session: {
        modelRuntime,
        subscribe: vi.fn((fn: any) => { listener = fn; return vi.fn(); }),
        prompt,
        steer: vi.fn(),
        abort: vi.fn(),
        abortCompaction: vi.fn(),
        abortBranchSummary: vi.fn(),
        dispose: vi.fn(),
        compact: vi.fn(),
        setModel: vi.fn(),
        setThinkingLevel: vi.fn(),
        bindExtensions: sessionBindExtensions,
        extensionRunner: { setFlagValue: sessionExtensionSetFlagValue, emit: sessionExtensionEmit, hasHandlers: sessionExtensionHasHandlers },
        sessionId: "session-a",
        sessionFile: join(dir, "session.json"),
        thinkingLevel: "off",
        settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
        model: { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 18000 },
      },
    });
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    await handle.prompt("hello");

    expect(loggerWarn).toHaveBeenCalledWith("runtime:pi-sdk", "compaction watchdog: run crossed threshold without SDK compaction event", expect.objectContaining({
      maxTokens: 18500,
      contextWindow: 18000,
      threshold: 17000,
      model: "anthropic/claude-sonnet-4-6",
    }));
  });

  it("does not warn when SDK emits a compaction event for the threshold-crossing run", async () => {
    let listener: ((event: any) => void) | undefined;
    const prompt = vi.fn(async () => {
      listener?.({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 17000, output: 1500, cacheRead: 0, cacheWrite: 0, totalTokens: 18500 } } });
      listener?.({ type: "compaction_start", reason: "threshold" });
    });
    createAgentSession.mockResolvedValueOnce({
      session: {
        modelRuntime,
        subscribe: vi.fn((fn: any) => { listener = fn; return vi.fn(); }),
        prompt,
        steer: vi.fn(), abort: vi.fn(), abortCompaction: vi.fn(), abortBranchSummary: vi.fn(), dispose: vi.fn(), compact: vi.fn(), setModel: vi.fn(), setThinkingLevel: vi.fn(), bindExtensions: sessionBindExtensions,
        extensionRunner: { setFlagValue: sessionExtensionSetFlagValue, emit: sessionExtensionEmit, hasHandlers: sessionExtensionHasHandlers },
        sessionId: "session-a", sessionFile: join(dir, "session.json"), thinkingLevel: "off", settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
        model: { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 18000 },
      },
    });
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    await handle.prompt("hello");

    expect(loggerWarn).not.toHaveBeenCalledWith("runtime:pi-sdk", "compaction watchdog: run crossed threshold without SDK compaction event", expect.anything());
  });

  it("applies Bossmode default pi transport overrides without persisting settings", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(settingsApplyOverrides).toHaveBeenCalledWith({
      transport: "auto",
      websocketConnectTimeoutMs: 15000,
    });
  });

  it.each(["sse", "websocket"] as const)("passes Codex %s transport straight to the SDK settings manager", async (transport) => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "openai-codex" } };
    bossmodeConfig = { runtime: { sessionResume: true, codexTransport: transport, websocketConnectTimeoutMs: 3210 }, mcp: { enabled: false } };
    settingsGetTransport.mockReturnValueOnce(transport);
    settingsGetWebSocketConnectTimeoutMs.mockReturnValueOnce(3210);
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({ member: { ...baseOpts().member, model: "openai-codex/gpt-6-astra" } }));

    expect(settingsApplyOverrides).toHaveBeenCalledWith({ transport, websocketConnectTimeoutMs: 3210 });
    expect(loggerInfo).toHaveBeenCalledWith("runtime:pi-sdk", "createAgent", expect.objectContaining({ transport }));
  });

  it.each(["sse", "websocket"] as const)("reapplies Codex %s transport and timeouts after member resource reload", async (transport) => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "openai-codex" } };
    bossmodeConfig = { runtime: { sessionResume: true, codexTransport: transport, websocketConnectTimeoutMs: 3210, httpIdleTimeoutMs: 6543 }, mcp: { enabled: false } };
    settingsGetTransport.mockReturnValue(transport);
    settingsGetWebSocketConnectTimeoutMs.mockReturnValue(3210);
    settingsGetHttpIdleTimeoutMs.mockReturnValue(6543);
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts({ member: { ...baseOpts().member, model: "openai-codex/gpt-6-astra" } }));

    await handle.reloadResources!({ roomId: "room-a", member: baseOpts().member, agentPrompt: "agent prompt", appendSystemPrompt: [], skillPaths: [], skillNames: [] });

    expect(settingsApplyOverrides.mock.calls.filter(([value]) => JSON.stringify(value) === JSON.stringify({ transport, websocketConnectTimeoutMs: 3210, httpIdleTimeoutMs: 6543 }))).toHaveLength(2);
  });

  it("always loads the MCP adapter (platform infrastructure) even with MCP flag off and no member config", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    const loaderOptions = resourceLoaderCtor.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    // Batch 6 §1.4: adapter is unconditionally bound; empty config is harmless.
    expect(loaderOptions.additionalExtensionPaths).toHaveLength(0);
    expect(loaderOptions.extensionFactories).toEqual([mcpFactory]);
    expect(loadDatabaseMcpFactory).toHaveBeenCalledWith(expect.stringMatching(/vendor\/pi-mcp-adapter\/index\.ts$/));
    expect(createAgentSession.mock.calls[0][0].tools).toBeUndefined();
    const scopedPath = sessionExtensionSetFlagValue.mock.calls.find((call) => call[0] === "mcp-config")?.[1];
    expect(JSON.parse(readFileSync(scopedPath, "utf-8"))).toEqual({ mcpServers: {} });
    expect(sessionBindExtensions).toHaveBeenCalledWith(expect.objectContaining({ mode: "print", onError: expect.any(Function) }));
  });

  it("member extensions dir expands into file entries in the loader paths (qa rc.14 ①)", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { memberExtensionsDir } = await import("../../src/workspace/member-profile.js");
    const extDir = memberExtensionsDir("pm");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "my-tool.ts"), "export default () => {};\n", "utf-8");
    mkdirSync(join(extDir, "pkg"));
    writeFileSync(join(extDir, "pkg", "package.json"), JSON.stringify({ pi: { extensions: ["main.js"] } }));
    writeFileSync(join(extDir, "pkg", "main.js"), "export default () => {};\n", "utf-8");
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    const paths = resourceLoaderCtor.mock.calls[0][0].additionalExtensionPaths;
    // File entries, never the bare directory; adapter still last.
    expect(paths).toContain(join(extDir, "my-tool.ts"));
    expect(paths).toContain(join(extDir, "pkg", "main.js"));
    expect(paths).not.toContain(extDir);
    expect(paths.some((p: string) => p.includes("pi-mcp-adapter"))).toBe(false);
    expect(resourceLoaderCtor.mock.calls[0][0].extensionFactories).toEqual([mcpFactory]);
  });

  it("no member SQL MCP configuration → adapter bound with empty scoped config", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: true } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(resourceLoaderCtor.mock.calls[0][0].additionalExtensionPaths).toHaveLength(0);
    expect(resourceLoaderCtor.mock.calls[0][0].extensionFactories).toEqual([mcpFactory]);
    expect(createAgentSession.mock.calls[0][0].tools).toBeUndefined();
    const scopedPath = sessionExtensionSetFlagValue.mock.calls.find((call) => call[0] === "mcp-config")?.[1];
    expect(JSON.parse(readFileSync(scopedPath, "utf-8"))).toEqual({ mcpServers: {} });
  });

  it("member SQL MCP configuration is the source — every configured server is enabled", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: true } };
    // Member-owned SQL configuration; the registry enable list is retired.
    const { writeMemberMcpConfig } = await import("../../src/shared/mcp-settings.js");
    writeMemberMcpConfig("pm", { mcpServers: { playwright: { url: "http://127.0.0.1:8931/mcp" }, github: { url: "http://127.0.0.1:8932/mcp" } } });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({ member: { ...baseOpts().member, mcpServers: ["playwright"] } }));

    const loaderOptions = resourceLoaderCtor.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.additionalExtensionPaths).toHaveLength(0);
    expect(loaderOptions.extensionFactories).toEqual([mcpFactory]);
    expect(loadDatabaseMcpFactory).toHaveBeenCalledWith(expect.stringMatching(/vendor\/pi-mcp-adapter\/index\.ts$/));
    expect(createAgentSession.mock.calls[0][0].tools).toBeUndefined();
    const scopedPath = sessionExtensionSetFlagValue.mock.calls.find((call) => call[0] === "mcp-config")?.[1];
    expect(existsSync(scopedPath)).toBe(true);
    const scoped = JSON.parse(readFileSync(scopedPath, "utf-8"));
    // Both configured servers pass; the retired mcpServers list is ignored.
    expect(Object.keys(scoped.mcpServers).sort()).toEqual(["github", "playwright"]);
    expect(sessionBindExtensions).toHaveBeenCalledWith(expect.objectContaining({ mode: "print", onError: expect.any(Function) }));
    expect(process.env.MCP_DIRECT_TOOLS).toBe("__none__");
    expect(process.env.BOSSMODE_MCP_CONFIG_STRICT).toBe("1");
  });

  it("refreshes prompt sources with the supported API without reloading resources or resetting the session", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem-stable','old-name','old-name','general','{}',0,0)");
    const opts = baseOpts({ member: { ...baseOpts().member, id: "mem-stable", name: "old-name" } });
    const handle = await new PiSdkRuntime().createAgent(opts);
    const session = (handle as any).session;
    const loader = createAgentSession.mock.calls[0][0].resourceLoader;
    const reload = vi.spyOn(loader, "reload");
    activeToolNames = ["read", "query_room_messages", "web_search"];
    const appends = ["new environment", "  "];
    handle.refreshPrompt!({ agentPrompt: "  new identity  ", appendSystemPrompt: appends });
    appends[0] = "caller mutation";

    expect(loader.getSystemPrompt()).toBe("new identity");
    expect(loader.getAppendSystemPrompt()).toEqual(["new environment"]);
    expect(handle.runtimeParams!.systemPrompt).toBe("new identity\n\nnew environment");
    expect(session.setActiveToolsByName).toHaveBeenLastCalledWith(["read", "query_room_messages", "web_search"]);
    expect(reload).not.toHaveBeenCalled();
    expect(session.reload).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(sessionResetLeaf).not.toHaveBeenCalled();
    expect(sessionBranch).not.toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    expect(toolsFactory).toHaveBeenCalledWith(expect.objectContaining({ memberId: "mem-stable" }));

    // A subsequent explicit resource reload must replace the prompt override too.
    await handle.reloadResources!({ roomId: opts.roomId, member: { ...opts.member, name: "new-name" }, agentPrompt: "reloaded identity", appendSystemPrompt: [], skillPaths: [] });
    expect(loader.getSystemPrompt()).toBe("reloaded identity");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(toolsFactory).toHaveBeenLastCalledWith(expect.objectContaining({ memberId: "mem-stable" }));
  });

  it.each(["isStreaming", "isCompacting"])("rejects prompt refresh while SDK %s without changing prompt sources", async (flag) => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const session = (handle as any).session;
    const loader = createAgentSession.mock.calls[0][0].resourceLoader;
    session[flag] = true;
    expect(() => handle.refreshPrompt!({ agentPrompt: "unsafe", appendSystemPrompt: [] })).toThrow("idle pre-prompt boundary");
    expect(loader.getSystemPrompt()).toBe("agent prompt");
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
  });

  it("rejects prompt refresh during a handle run and permits it after settlement", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const session = (handle as any).session;
    let finish!: () => void;
    session.prompt.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const run = handle.prompt("current run");
    expect(() => handle.refreshPrompt!({ agentPrompt: "unsafe", appendSystemPrompt: [] })).toThrow("idle pre-prompt boundary");
    finish();
    await run;
    expect(() => handle.refreshPrompt!({ agentPrompt: "safe", appendSystemPrompt: [] })).not.toThrow();
    expect(handle.runtimeParams!.systemPrompt).toBe("safe");
  });

  it("activates newly assigned MCP on reload without replacing the session", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: true } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const runtime = new PiSdkRuntime();
    const handle = await runtime.createAgent(baseOpts());
    const sessionId = (handle as any).session.sessionId;

    const { writeMemberMcpConfig } = await import("../../src/shared/mcp-settings.js");
    writeMemberMcpConfig("pm", { mcpServers: { playwright: { url: "http://127.0.0.1:8931/mcp" } } });
    // Simulate registry after reload including extension + mcp tools
    activeToolNames = ["read", "bash", "edit", "write", "mcp", "web_search"];
    await handle.reloadResources!({
      roomId: "room-a",
      member: { ...baseOpts().member, mcpServers: ["playwright"] },
      agentPrompt: "updated prompt",
      appendSystemPrompt: ["room supplement"],
      skillPaths: [],
      skillNames: [],
    });

    expect((handle as any).session.sessionId).toBe(sessionId);
    expect(activeToolNames).toContain("mcp");
    expect(activeToolNames).toContain("web_search");
    const scopedPath = sessionExtensionSetFlagValue.mock.calls.at(-1)![1];
    expect(Object.keys(JSON.parse(readFileSync(scopedPath, "utf8")).mcpServers)).toEqual(["playwright"]);
    expect((handle.runtimeParams as any).systemPrompt).toContain("updated prompt");
  });

  it("replaces the derived config before reload start and releases each config after shutdown", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const { writeMemberMcpConfig } = await import("../../src/shared/mcp-settings.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const oldPath = sessionExtensionSetFlagValue.mock.calls.at(-1)![1];
    writeMemberMcpConfig("pm", { mcpServers: { added: { url: "http://127.0.0.1:1/mcp" } } });
    activeToolNames = ["mcp"];
    const session = (handle as any).session;
    session.reload.mockImplementationOnce(async (options: any) => {
      expect(existsSync(oldPath)).toBe(true);
      await options.beforeSessionStart();
      const newPath = sessionExtensionSetFlagValue.mock.calls.at(-1)![1];
      expect(newPath).not.toBe(oldPath);
      expect(Object.keys(JSON.parse(readFileSync(newPath, "utf8")).mcpServers)).toEqual(["added"]);
    });
    await handle.reloadResources!({roomId: "room-a", member: baseOpts().member, agentPrompt: "updated", appendSystemPrompt: [], skillPaths: []});
    const newPath = sessionExtensionSetFlagValue.mock.calls.at(-1)![1];
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    expect(sessionBindExtensions).toHaveBeenCalledTimes(1);
    await handle.destroyAndWait!();
    expect(existsSync(newPath)).toBe(false);
  });

  it("shuts down an obtained session and removes derived config when binding fails", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    sessionBindExtensions.mockRejectedValueOnce(new Error("bind failed"));
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    await expect(new PiSdkRuntime().createAgent(baseOpts())).rejects.toThrow("bind failed");
    const session = (await createAgentSession.mock.results.at(-1)!.value).session;
    expect(session.abort).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect(existsSync(sessionExtensionSetFlagValue.mock.calls.at(-1)![1])).toBe(false);
  });

  it("retains failed creation cleanup for member and repeated global shutdown",async()=>{
    exportedConfig={agentDir:join(dir,"profile-agent-dir"),extensionPaths:[],profile:{id:"test-profile",providerSlug:"anthropic"}};
    const session=(await createAgentSession.getMockImplementation()!()).session;
    session.dispose.mockImplementationOnce(()=>{throw new Error("dispose failed");});
    sessionBindExtensions.mockRejectedValueOnce(new Error("bind failed"));
    const {PiSdkRuntime}=await import("../../src/engine/runtime/pi-sdk.js");const runtime=new PiSdkRuntime();
    await expect(runtime.createAgent(baseOpts())).rejects.toThrow("Runtime creation and cleanup failed");
    await expect(runtime.shutdownMember(baseOpts().member.id)).rejects.toThrow("incomplete");
    await expect(runtime.shutdownAll()).rejects.toThrow("incomplete");
    await expect(runtime.shutdownAll()).rejects.toThrow("incomplete");
    await expect(runtime.shutdownMember("mem_other")).resolves.toBeUndefined();
  });

  it("teardown waits for a blocked reload and prevents its late session start",async()=>{
    exportedConfig={agentDir:join(dir,"profile-agent-dir"),extensionPaths:[],profile:{id:"test-profile",providerSlug:"anthropic"}};
    const {PiSdkRuntime}=await import("../../src/engine/runtime/pi-sdk.js");
    const handle=await new PiSdkRuntime().createAgent(baseOpts());const session=(handle as any).session;
    let release!:()=>void;let entered=false;const gate=new Promise<void>(resolve=>release=resolve);
    session.reload.mockImplementationOnce(async(options:any)=>{entered=true;await gate;await options.beforeSessionStart();});
    const reload=handle.reloadResources!({roomId:"room-a",member:baseOpts().member,agentPrompt:"x",appendSystemPrompt:[],skillPaths:[]});
    const rejected=expect(reload).rejects.toThrow("destroyed");
    await vi.waitFor(()=>expect(entered).toBe(true));const teardown=handle.destroyAndWait!();
    await Promise.resolve();expect(session.dispose).not.toHaveBeenCalled();
    release();await rejected;await teardown;expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("does not create an apparently healthy session when the SDK suppresses a hosted factory error", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    hostedMcpLoaded = false;
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    await expect(new PiSdkRuntime().createAgent(baseOpts())).rejects.toThrow("Hosted MCP extension failed to load");
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("removes derived config when the hosted factory cannot load", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const settings = await import("../../src/shared/mcp-settings.js");
    const materialize = settings.writeMemberScopedMcpConfig;
    let path = "";
    vi.spyOn(settings, "writeMemberScopedMcpConfig").mockImplementation(args => {
      const config = materialize(args); path = config.configPath; return config;
    });
    loadDatabaseMcpFactory.mockRejectedValueOnce(new Error("factory failed"));
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    await expect(new PiSdkRuntime().createAgent(baseOpts())).rejects.toThrow("factory failed");
    expect(path).not.toBe(""); expect(existsSync(path)).toBe(false);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("retains uncertain config generations after reload failure until session teardown", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const settings = await import("../../src/shared/mcp-settings.js");
    const materialize = settings.writeMemberScopedMcpConfig;
    const paths: string[] = [];
    vi.spyOn(settings, "writeMemberScopedMcpConfig").mockImplementation(args => {
      const config = materialize(args); paths.push(config.configPath); return config;
    });
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    (handle as any).session.reload.mockRejectedValueOnce(new Error("reload failed"));
    await expect(handle.reloadResources!({roomId:"room-a",member:baseOpts().member,agentPrompt:"x",appendSystemPrompt:[],skillPaths:[]})).rejects.toThrow("reload failed");
    expect(paths).toHaveLength(2); expect(paths.every(existsSync)).toBe(true);
    await handle.destroyAndWait!(); expect(paths.some(existsSync)).toBe(false);
  });

  it("keeps the mcp tool after a reload even with no member SQL MCP configuration (adapter is platform infrastructure)", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: true } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    activeToolNames = ["read", "bash", "edit", "write", "mcp", "web_search"];

    await handle.reloadResources!({
      roomId: "room-a",
      member: baseOpts().member,
      agentPrompt: "agent prompt",
      appendSystemPrompt: [],
      skillPaths: [],
      skillNames: [],
    });

    // Batch 6 §1.4: no member mcp.json → empty scoped config, adapter still bound.
    expect(activeToolNames).toContain("mcp");
    const scopedPath = sessionExtensionSetFlagValue.mock.calls.at(-1)?.[1];
    expect(JSON.parse(readFileSync(scopedPath, "utf-8"))).toEqual({ mcpServers: {} });
  });

  it("rejects reload instead of reporting success when active MCP tools cannot be applied", async () => {
    const { writeMemberMcpConfig } = await import("../../src/shared/mcp-settings.js");
    writeMemberMcpConfig("pm", { mcpServers: { playwright: { url: "http://127.0.0.1:8931/mcp" } } });
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: true } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const previousPrompt = (handle.runtimeParams as any).systemPrompt;
    ignoreActiveToolChanges = true;

    await expect(handle.reloadResources!({
      roomId: "room-a",
      member: { ...baseOpts().member, mcpServers: ["playwright"] },
      agentPrompt: "updated prompt",
      appendSystemPrompt: [],
      skillPaths: [],
      skillNames: [],
    })).rejects.toThrow("Reload could not apply MCP access");
    expect((handle.runtimeParams as any).systemPrompt).toBe(previousPrompt);
  });

  it("resumes saved session and appends configured model change when saved model differs", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    openedSessionModel = { provider: "anthropic", modelId: "claude-opus-4-7" };
    const setModel = vi.fn().mockResolvedValue(undefined);
    createAgentSession.mockResolvedValueOnce({
      session: {
        modelRuntime,
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        steer: vi.fn(),
        abort: vi.fn(),
        abortCompaction: vi.fn(),
        abortBranchSummary: vi.fn(),
        dispose: vi.fn(),
        compact: vi.fn(),
        setModel,
        setThinkingLevel: vi.fn(),
        bindExtensions: sessionBindExtensions,
        extensionRunner: { setFlagValue: sessionExtensionSetFlagValue, emit: sessionExtensionEmit, hasHandlers: sessionExtensionHasHandlers },
        sessionId: "session-a",
        sessionFile: join(dir, "session.json"),
        thinkingLevel: "off",
        settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
      },
    });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      member: { ...baseOpts().member, model: "anthropic/claude-fable-5" },
      resumeSession: { sessionId: "old-session", sessionFile: savedSessionFile() },
    }));

    expect(sessionManagerOpen).toHaveBeenCalledWith(join(dir, "old-session.jsonl"), expect.any(String), dir);
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("opened-session");
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", id: "claude-fable-5" }));
  });

  it("rolls back the failed turn and resumes instead of discarding history when saved session ended with assistant provider error", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    openedSessionModel = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    openedLeafEntry = {
      type: "message",
      id: "leaf-err",
      parentId: "turn-parent",
      message: { role: "assistant", stopReason: "error", errorMessage: "An unknown error occurred" },
    };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      resumeSession: { sessionId: "old-session", sessionFile: savedSessionFile() },
    }));

    expect(sessionManagerOpen).toHaveBeenCalledWith(join(dir, "old-session.jsonl"), expect.any(String), dir);
    expect(sessionBranch).toHaveBeenCalledWith("turn-parent");
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("opened-session");
  });

  it("resets the leaf and resumes when the first turn itself ended with a provider error", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    openedSessionModel = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    openedLeafEntry = {
      type: "message",
      id: "leaf-err",
      parentId: null,
      message: { role: "assistant", stopReason: "error", errorMessage: "boom" },
    };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      resumeSession: { sessionId: "old-session", sessionFile: savedSessionFile() },
    }));

    expect(sessionResetLeaf).toHaveBeenCalled();
    expect(sessionBranch).not.toHaveBeenCalled();
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("opened-session");
  });

  it("resumes saved session when saved model matches configured model", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    openedSessionModel = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      resumeSession: { sessionId: "old-session", sessionFile: savedSessionFile() },
    }));

    expect(sessionManagerOpen).toHaveBeenCalledWith(join(dir, "old-session.jsonl"), expect.any(String), dir);
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("opened-session");
  });

  it("starts fresh when the saved session file was deleted", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const missing = join(dir, "missing-session.jsonl");
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      resumeSession: { sessionId: "old-session", sessionFile: missing },
    }));

    expect(sessionManagerOpen).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith(dir, expect.any(String));
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("created-session");
    expect(loggerWarn).toHaveBeenCalledWith("runtime:pi-sdk", "saved session file missing, starting fresh", expect.objectContaining({ sessionFile: missing }));
  });

  it.each(["success", "stopped", "failure"])("manual compact reports SDK %s without replacement lifecycle events", async (result) => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const mock = makeWatchdogSession({ contextWindow: 18000, reserveTokens: 1000, onPrompt: async () => {} });
    mock.session.compact = vi.fn(async () => {
      mock.emit({ type: "compaction_start", reason: "manual" });
      mock.emit({ type: "compaction_end", reason: "manual", aborted: result === "stopped", willRetry: false,
        ...(result === "failure" ? { errorMessage: "summary failed" } : {}) });
      // SDK 0.82.1 rejects both cancellation and real failures after its end event.
      if (result !== "success") throw new Error(result === "stopped" ? "Compaction cancelled" : "summary failed");
      return { summary: "summary" };
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const events: any[] = [];
    handle.subscribe((event) => events.push(event));
    if (result === "failure") await expect(handle.compact()).rejects.toThrow("summary failed");
    else expect(await handle.compact()).toEqual({ aborted: result === "stopped" });
    expect(events.map((event) => event.type)).toEqual(["agent_start", "compaction_start", "compaction_end", "agent_end"]);
  });

  it.each([false, true])("abort before SDK compaction_start honors preserveCompaction=%s", async (preserveCompaction) => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const mock = makeWatchdogSession({ contextWindow: 18000, reserveTokens: 1000, onPrompt: async () => {} });
    let release!: () => void;
    const beforeStart = new Promise<void>((resolve) => { release = resolve; });
    let controllerReady = false;
    let cancelled = false;
    mock.session.abortCompaction = vi.fn(() => { if (controllerReady) cancelled = true; });
    mock.session.compact = vi.fn(async () => {
      await beforeStart;
      controllerReady = true;
      mock.emit({ type: "compaction_start", reason: "manual" });
      mock.emit({ type: "compaction_end", reason: "manual", aborted: cancelled, willRetry: false });
      if (cancelled) throw new Error("Compaction cancelled");
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const operation = handle.compact();
    handle.abort({ preserveCompaction });
    release();
    expect(await operation).toEqual({ aborted: !preserveCompaction });
    expect(mock.session.abortCompaction).toHaveBeenCalledTimes(preserveCompaction ? 0 : 2);
  });

  it("refreshes registry and awaits SDK model switch", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const setModel = vi.fn().mockResolvedValue(undefined);
    createAgentSession.mockResolvedValueOnce({
      session: {
        modelRuntime,
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        steer: vi.fn(),
        abort: vi.fn(),
        abortCompaction: vi.fn(),
        abortBranchSummary: vi.fn(),
        dispose: vi.fn(),
        compact: vi.fn(),
        setModel,
        setThinkingLevel: vi.fn(),
        bindExtensions: sessionBindExtensions,
        extensionRunner: { setFlagValue: sessionExtensionSetFlagValue, emit: sessionExtensionEmit, hasHandlers: sessionExtensionHasHandlers },
        sessionId: "session-a",
        sessionFile: join(dir, "session.json"),
        thinkingLevel: "off",
        settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
      },
    });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    await handle.refreshModelRegistry?.();
    await handle.setModel?.("anthropic/claude-opus-4-6", "cred-b");

    expect(databaseRuntimeRefresh).toHaveBeenCalledWith(modelRuntime, "test-profile");
    expect(databaseRuntimeRefresh).toHaveBeenCalledWith(modelRuntime, "cred-b");
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", id: "claude-opus-4-6" }));
    expect(handle.runtimeParams?.model).toBe("anthropic/claude-opus-4-6");
  });

  it("teardown awaits a pending model refresh and blocks late model/history mutation",async()=>{
    exportedConfig={agentDir:join(dir,"profile-agent-dir"),extensionPaths:[],profile:{id:"test-profile",providerSlug:"anthropic"}};
    const {PiSdkRuntime}=await import("../../src/engine/runtime/pi-sdk.js");const handle=await new PiSdkRuntime().createAgent(baseOpts());const session=(handle as any).session;
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    databaseRuntimeRefresh.mockImplementationOnce(async()=>{await gate;});
    const changing=handle.setModel!("anthropic/claude-opus-4-6","cred-b");const rejected=expect(changing).rejects.toThrow("destroyed");
    const teardown=handle.destroyAndWait!();await Promise.resolve();expect(session.dispose).not.toHaveBeenCalled();
    release();await rejected;await teardown;
    expect(session.setModel).not.toHaveBeenCalled();
    await expect(handle.refreshModelRegistry!()).rejects.toThrow("destroyed");
    expect(()=>handle.setThinkingLevel!("high")).toThrow("destroyed");
  });

  it("reports configured skill names separately from SDK-loadable skill paths", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts({
      skillPaths: [join(dir, "missing-skill")],
      skillNames: ["impeccable", "custom-skill"],
    }));

    expect(resourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({ additionalSkillPaths: [] }));
    expect(handle.runtimeParams?.skills).toEqual(["impeccable", "custom-skill"]);
  });

  it("getActiveTools returns intersection of registry and active names with source labels", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    activeToolNames = ["read", "bash", "wait", "web_search", "mcp"];
    createAgentSession.mockResolvedValueOnce({
      session: {
        modelRuntime,
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(), steer: vi.fn(), abort: vi.fn(), abortCompaction: vi.fn(), abortBranchSummary: vi.fn(), dispose: vi.fn(),
        reload: vi.fn(async (options?: any) => { await options?.beforeSessionStart?.(); }), compact: vi.fn(), setModel: vi.fn(), setThinkingLevel: vi.fn(),
        setActiveToolsByName: vi.fn((names: string[]) => { activeToolNames = names; }),
        getActiveToolNames: vi.fn(() => activeToolNames),
        getAllTools: vi.fn(() => [
          { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, sourceInfo: { path: "builtin", source: "builtin" } },
          { name: "bash", description: "Run bash", parameters: { type: "object", properties: {} }, sourceInfo: { path: "builtin", source: "builtin" } },
          // wait has no sourceInfo path — must classify via live customTools set, not static whitelist
          { name: "wait", description: "Block until member event", parameters: { type: "object", properties: {} } },
          { name: "web_search", description: "Search the web", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, sourceInfo: { path: "/tmp/extensions/node_modules/pi-web-access/index.ts", source: "extension", baseDir: "/tmp/extensions/node_modules/pi-web-access" } },
          { name: "mcp", description: "MCP proxy", parameters: { type: "object", properties: {} }, sourceInfo: { path: "vendor/pi-mcp-adapter/index.ts", source: "extension" } },
          { name: "inactive_tool", description: "Should be filtered", parameters: {}, sourceInfo: { path: "x" } },
        ]),
        getToolDefinition: vi.fn((name: string) => ({ name, label: name })),
        bindExtensions: sessionBindExtensions,
        extensionRunner: { setFlagValue: sessionExtensionSetFlagValue, emit: sessionExtensionEmit, hasHandlers: sessionExtensionHasHandlers },
        sessionId: "session-a", sessionFile: join(dir, "session.json"), thinkingLevel: "off",
        settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
        model: { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 18000 },
      },
    });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const tools = handle.getActiveTools!();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["bash", "mcp", "read", "wait", "web_search"]);
    expect(tools.find((t) => t.name === "read")?.source).toBe("builtin");
    expect(tools.find((t) => t.name === "wait")?.source).toBe("bossmode");
    expect(tools.find((t) => t.name === "mcp")?.source).toBe("mcp");
    expect(tools.find((t) => t.name === "web_search")?.source).toMatch(/^extension:/);
    expect(tools.find((t) => t.name === "web_search")?.parameters).toMatchObject({ required: ["query"] });
    expect(tools.find((t) => t.name === "inactive_tool")).toBeUndefined();
  });

  it("classifies tools from createBossmodeSdkTools set — no static whitelist fallback", () => {
    // Guard: static BOSSMODE_TOOL_NAMES must stay deleted.
    const src = readFileSync(join(process.cwd(), "src/engine/runtime/pi-sdk.ts"), "utf8");
    expect(src).not.toMatch(/BOSSMODE_TOOL_NAMES/);
    expect(src).toMatch(/bossmodeToolNames/);
  });

});



// -- Compaction watchdog action (2026-07-29 k3 empty-response loop fix) --

interface WatchdogMock {
  session: any;
  calls: string[];
  messages: any[];
  appended: any[];
  emit: (e: any) => void;
}

function makeWatchdogSession(opts: {
  contextWindow: number;
  reserveTokens: number;
  onPrompt: (m: WatchdogMock) => Promise<void>;
}): WatchdogMock {
  const mock: WatchdogMock = {
    calls: [],
    messages: [],
    appended: [],
    session: null,
    emit: () => {},
  };
  let listener: ((event: any) => void) | undefined;
  mock.emit = (e) => listener?.(e);
  settingsGetCompactionSettings.mockReturnValue({ enabled: true, reserveTokens: opts.reserveTokens, keepRecentTokens: 20000 });
  mock.session = {
    subscribe: vi.fn((fn: any) => { listener = fn; return vi.fn(); }),
    prompt: vi.fn(async (text: string) => { mock.calls.push(text); await opts.onPrompt(mock); }),
    steer: vi.fn(),
    abort: vi.fn(async () => {}),
    abortCompaction: vi.fn(),
    abortBranchSummary: vi.fn(),
    dispose: vi.fn(),
    reload: vi.fn(async (options?: any) => { await options?.beforeSessionStart?.(); }),
    compact: vi.fn(async () => ({ summary: "s", firstKeptEntryId: "x", tokensBefore: 1 })),
    setModel: vi.fn(),
    setThinkingLevel: vi.fn(),
    setActiveToolsByName: vi.fn(),
    getActiveToolNames: vi.fn(() => []),
    getAllTools: vi.fn(() => []),
    bindExtensions: sessionBindExtensions,
    extensionRunner: { setFlagValue: sessionExtensionSetFlagValue, emit: sessionExtensionEmit, hasHandlers: sessionExtensionHasHandlers },
    sessionId: "session-a",
    sessionFile: join(dir, "session.json"),
    thinkingLevel: "off",
    settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
    model: { provider: "kimi-coding", id: "k3", contextWindow: opts.contextWindow },
    state: { messages: mock.messages },
    sessionManager: { appendMessage: vi.fn((m: any) => { mock.appended.push(m); return "id"; }) },
  };
  return mock;
}

function assistantMsg(totalTokens: number, content: any[], stopReason = "toolUse") {
  return { role: "assistant", stopReason, usage: { input: totalTokens, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens }, content, timestamp: Date.now() };
}

function responsesInput(messages: any[]) {
  return convertResponsesMessages({
    id: "test", provider: "openai-codex", api: "openai-codex-responses", input: ["text"],
  } as any, { messages }, new Set(["openai-codex"]));
}

describe("PiSdkAgentHandle compaction watchdog action", () => {
  beforeEach(() => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    bossmodeConfig = { runtime: { sessionResume: false }, mcp: { enabled: false } };
    vi.clearAllMocks();
  });


  it("teardown awaits watchdog compaction and never starts its continuation after destruction",async()=>{
    const mock=makeWatchdogSession({contextWindow:50000,reserveTokens:1000,onPrompt:async m=>{
      const assistant=assistantMsg(30000,[{type:"toolCall",id:"t",name:"read",arguments:{}}]);
      m.emit({type:"message_end",message:assistant});m.emit({type:"agent_end",messages:[]});
    }});
    let release!:()=>void;let compacting=false;const gate=new Promise<void>(resolve=>release=resolve);
    mock.session.compact=vi.fn(async()=>{compacting=true;await gate;});
    createAgentSession.mockResolvedValueOnce({session:mock.session});
    const {PiSdkRuntime}=await import("../../src/engine/runtime/pi-sdk.js");const handle=await new PiSdkRuntime().createAgent(baseOpts());
    const prompt=handle.prompt("original");await vi.waitFor(()=>expect(compacting).toBe(true));
    let finished=false;const teardown=handle.destroyAndWait!().then(()=>finished=true);
    await Promise.resolve();expect(finished).toBe(false);expect(mock.session.dispose).not.toHaveBeenCalled();
    release();await prompt;await teardown;expect(mock.calls).toEqual(["original"]);
    await expect(handle.prompt("late")).rejects.toThrow("destroyed");
  });

  it("mid-run crossing: aborts and compacts without rewriting SDK history", async () => {
    const mock = makeWatchdogSession({
      contextWindow: 50000,
      reserveTokens: 1000, // threshold 49000, action line max(16232, 25000) = 25000
      onPrompt: async (m) => {
        if (m.calls.length > 1) return; // continuation run: idle
        const assistant = assistantMsg(30000, [
          { type: "toolCall", id: "tc1", name: "read", arguments: {} },
          { type: "toolCall", id: "tc2", name: "bash", arguments: {} },
        ]);
        m.messages.push(assistant);
        m.messages.push({ role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: Date.now() });
        m.emit({ type: "message_end", message: assistant });
        m.emit({ type: "agent_end", messages: [] });
      },
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());

    await handle.prompt("do work");

    expect(mock.session.abort).toHaveBeenCalledTimes(1); // watchdog aborted the run
    expect(mock.session.compact).toHaveBeenCalledTimes(1); // exactly one compaction
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]).toContain("automatically compacted"); // continue instruction
    expect(mock.appended).toEqual([]);
    expect(mock.messages).toHaveLength(2);
    // The real provider converter supplies missing results, without modifying history.
    const input = responsesInput(mock.messages);
    expect(input.filter((m: any) => m.type === "function_call_output").map((m: any) => m.call_id)).toEqual(["tc1", "tc2"]);
    expect(mock.messages).toHaveLength(2);
    expect(loggerWarn).toHaveBeenCalledWith("runtime:pi-sdk", "compaction watchdog: mid-run crossing, aborting for compaction", expect.any(Object));
  });

  it.each(["aborted", "error", "toolUse"])("message abort preserves %s history and sends paired Codex input", async (stopReason) => {
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => { ready = r; });
    const held = new Promise<void>((r) => { release = r; });
    const mock = makeWatchdogSession({
      contextWindow: 50000,
      reserveTokens: 1000,
      onPrompt: async (m) => {
        m.messages.push(assistantMsg(1000, [
          { type: "toolCall", id: "call_interrupted|fc_interrupted", name: "chat", arguments: { message: "partial" } },
        ], stopReason));
        ready();
        await held;
        m.emit({ type: "agent_end", messages: m.messages });
      },
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    const running = handle.prompt("work");
    await started;
    const before = JSON.stringify(mock.messages);
    handle.abort({ preserveCompaction: true });
    release();
    await running;

    expect(mock.session.abort).toHaveBeenCalledTimes(1);
    expect(mock.session.abortCompaction).not.toHaveBeenCalled();
    expect(mock.session.abortBranchSummary).not.toHaveBeenCalled();
    expect(mock.appended).toEqual([]);
    expect(JSON.stringify(mock.messages)).toBe(before);
    const input = responsesInput([...mock.messages, { role: "user", content: "continue", timestamp: Date.now() }]);
    const calls = input.filter((m: any) => m.type === "function_call");
    const results = input.filter((m: any) => m.type === "function_call_output");
    expect(calls.map((m: any) => m.call_id)).toEqual(results.map((m: any) => m.call_id));
    expect(calls).toHaveLength(stopReason === "toolUse" ? 1 : 0);
    // Explicit Stop, unlike message delivery, still cancels compaction.
    handle.abort();
    expect(mock.session.abortCompaction).toHaveBeenCalledTimes(1);
    expect(mock.session.abortBranchSummary).toHaveBeenCalledTimes(1);
  });

  it("crossing at a natural run end (no tool calls): watchdog does not act (SDK boundary check owns it)", async () => {
    const mock = makeWatchdogSession({
      contextWindow: 50000,
      reserveTokens: 1000,
      onPrompt: async (m) => {
        m.emit({ type: "message_end", message: assistantMsg(30000, [{ type: "text", text: "done" }], "stop") });
        m.emit({ type: "agent_end", messages: [] });
      },
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());

    await handle.prompt("do work");

    expect(mock.session.abort).not.toHaveBeenCalled();
    expect(mock.session.compact).not.toHaveBeenCalled();
    expect(mock.calls).toEqual(["do work"]);
  });

  it("empty response at low usage: one verbatim retry, then a visible error (no compaction)", async () => {
    const mock = makeWatchdogSession({
      contextWindow: 50000,
      reserveTokens: 1000,
      onPrompt: async () => {},
    });
    // Every run ends on an empty assistant response (stop + no text + 1 output token).
    mock.session.prompt = vi.fn(async (text: string) => {
      mock.calls.push(text);
      mock.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 100 }, content: [], timestamp: Date.now() } });
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());

    await expect(handle.prompt("do work")).rejects.toThrow(/empty response twice/);

    expect(mock.calls).toHaveLength(2); // original + one retry
    expect(mock.calls[1]).toContain("came back empty");
    expect(mock.session.compact).not.toHaveBeenCalled();
    expect(mock.session.abort).not.toHaveBeenCalled();
  });

  it("empty response with usage near the clamp zone: compaction + continue (usage-driven, not shape-driven)", async () => {
    const mock = makeWatchdogSession({
      contextWindow: 200000,
      reserveTokens: 16384, // threshold 183616, action 150848, fault band start 118080
      onPrompt: async () => {},
    });
    mock.session.prompt = vi.fn(async (text: string) => {
      mock.calls.push(text);
      if (mock.calls.length > 1) return; // continuation: idle
      mock.emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 120000, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 120000 }, content: [], timestamp: Date.now() } });
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());

    await handle.prompt("do work");

    expect(mock.session.compact).toHaveBeenCalledTimes(1);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]).toContain("automatically compacted"); // continue, not the empty-retry nudge
  });

  it("compaction failure: visible error, no automatic retry", async () => {
    const mock = makeWatchdogSession({
      contextWindow: 50000,
      reserveTokens: 1000,
      onPrompt: async (m) => {
        if (m.calls.length > 1) return;
        const assistant = assistantMsg(30000, [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]);
        m.messages.push(assistant);
        m.emit({ type: "message_end", message: assistant });
        m.emit({ type: "agent_end", messages: [] });
      },
    });
    mock.session.compact = vi.fn(async () => { throw new Error("summary request failed"); });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());

    await expect(handle.prompt("do work")).rejects.toThrow(/Automatic context compaction failed: summary request failed/);

    expect(mock.session.compact).toHaveBeenCalledTimes(1); // no retry
    expect(mock.calls).toEqual(["do work"]); // no continuation after failure
  });

  it("skips our own compact when the SDK already compacted after the abort", async () => {
    const mock = makeWatchdogSession({
      contextWindow: 50000,
      reserveTokens: 1000,
      onPrompt: async (m) => {
        if (m.calls.length > 1) return;
        const assistant = assistantMsg(30000, [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]);
        m.messages.push(assistant);
        m.emit({ type: "message_end", message: assistant });
        // SDK's own post-run check fires after our abort: compaction events arrive.
        m.emit({ type: "agent_end", messages: [] });
        m.emit({ type: "compaction_start", reason: "threshold" });
        m.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
      },
    });
    createAgentSession.mockResolvedValueOnce({ session: mock.session });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts());

    await handle.prompt("do work");

    expect(mock.session.compact).not.toHaveBeenCalled(); // SDK handled it
    expect(mock.calls).toHaveLength(2); // still continues the turn
    expect(mock.calls[1]).toContain("automatically compacted");
  });
});
