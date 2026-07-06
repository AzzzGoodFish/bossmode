import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let exportedConfig: any = null;
let bossmodeConfig: any;
const authCreate = vi.fn();
const modelRegistryCreate = vi.fn();
const modelRegistryRefresh = vi.fn();
const modelRegistryGetApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "sk-test" }));
const authReload = vi.fn();
const createAgentSession = vi.fn();
const resourceLoaderCtor = vi.fn();
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
  exportPiConfigForMember: () => exportedConfig,
  normalizeModelRef: (modelRef: string) => modelRef,
}));

vi.mock("../../src/engine/runtime/bossmode-sdk-tools.js", () => ({
  createBossmodeSdkTools: () => [],
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader {
    constructor(options: any) { resourceLoaderCtor(options); }
    async reload() {}
  }
  return {
    VERSION: "test-sdk",
    AuthStorage: {
      create: (...args: any[]) => {
        authCreate(...args);
        return { kind: "auth", args };
      },
    },
    ModelRegistry: {
      create: (...args: any[]) => {
        modelRegistryCreate(...args);
        return { find: () => ({ provider: "anthropic", id: "claude-sonnet-4-6" }), getApiKeyAndHeaders: modelRegistryGetApiKeyAndHeaders, refresh: modelRegistryRefresh, authStorage: { reload: authReload } };
      },
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
    createAgentSession: (...args: any[]) => createAgentSession(...args),
  };
});

function baseOpts(overrides: Record<string, any> = {}) {
  return {
    cwd: dir,
    roomId: "room-a",
    member: { id: "pm", name: "pm", agent: "pm", runtime: "pi-cli", model: "anthropic/claude-sonnet-4-6", thinkingLevel: "off" },
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

describe("PiSdkRuntime", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-pi-sdk-"));
    exportedConfig = null;
    openedSessionModel = null;
    openedLeafEntry = null;
    vi.clearAllMocks();
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: false } };
    settingsGetTransport.mockReturnValue("auto");
    settingsGetWebSocketConnectTimeoutMs.mockReturnValue(60000);
    modelRegistryGetApiKeyAndHeaders.mockResolvedValue({ ok: true, apiKey: "sk-test" });
    settingsGetHttpIdleTimeoutMs.mockReturnValue(600000);
    settingsGetCompactionSettings.mockReturnValue({ enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 });
    createAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
        steer: vi.fn(),
        abort: vi.fn(),
        abortCompaction: vi.fn(),
        abortBranchSummary: vi.fn(),
        dispose: vi.fn(),
        compact: vi.fn(),
        setModel: vi.fn(),
        setThinkingLevel: vi.fn(),
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

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws setup guidance instead of falling back to SDK default auth when no Bossmode credential profile exists", async () => {
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await expect(new PiSdkRuntime().createAgent(baseOpts())).rejects.toThrow("Go to Settings → Model Credentials");

    expect(authCreate).not.toHaveBeenCalled();
    expect(modelRegistryCreate).not.toHaveBeenCalled();
  });

  it("uses exported Bossmode auth and model files when a credential profile exists", async () => {
    const agentDir = join(dir, "profile-agent-dir");
    exportedConfig = { agentDir, extensionPaths: [] };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(authCreate).toHaveBeenCalledWith(join(agentDir, "auth.json"));
    expect(modelRegistryCreate).toHaveBeenCalledWith(expect.anything(), join(agentDir, "models.json"));
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
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
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
        subscribe: vi.fn((fn: any) => { listener = fn; return vi.fn(); }),
        prompt,
        steer: vi.fn(), abort: vi.fn(), abortCompaction: vi.fn(), abortBranchSummary: vi.fn(), dispose: vi.fn(), compact: vi.fn(), setModel: vi.fn(), setThinkingLevel: vi.fn(), bindExtensions: sessionBindExtensions,
        extensionRunner: { setFlagValue: sessionExtensionSetFlagValue, emit: sessionExtensionEmit, hasHandlers: sessionExtensionHasHandlers },
        sessionId: "session-a", sessionFile: join(dir, "session.json"), thinkingLevel: "off", settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
        model: { provider: "anthropic", id: "claude-sonnet-4-6", contextWindow: 18000 },
      },
    });
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    await handle.prompt("hello");

    expect(loggerWarn).not.toHaveBeenCalledWith("runtime:pi-sdk", "compaction watchdog: run crossed threshold without SDK compaction event", expect.anything());
  });

  it("applies Bossmode default pi transport overrides without persisting settings", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(settingsApplyOverrides).toHaveBeenCalledWith({
      transport: "auto",
      websocketConnectTimeoutMs: 15000,
    });
  });

  it("does not load MCP adapter or expose mcp tool when MCP is disabled", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    const loaderOptions = resourceLoaderCtor.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.additionalExtensionPaths).toEqual([]);
    expect(createAgentSession.mock.calls[0][0].tools).not.toContain("mcp");
    expect(sessionBindExtensions).not.toHaveBeenCalled();
  });

  it("does not expose mcp tool when MCP is globally enabled but member has no assigned servers", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: true } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(resourceLoaderCtor.mock.calls[0][0].additionalExtensionPaths).toEqual([]);
    expect(createAgentSession.mock.calls[0][0].tools).not.toContain("mcp");
  });

  it("loads only the pinned MCP adapter and exposes mcp proxy tool when MCP is enabled for an assigned server", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: true } };
    mkdirSync(join(dir, ".bossmode", "mcp"), { recursive: true });
    writeFileSync(join(dir, ".bossmode", "mcp", "mcp.json"), JSON.stringify({ mcpServers: { playwright: { url: "http://127.0.0.1:8931/mcp" }, github: { url: "http://127.0.0.1:8932/mcp" } } }, null, 2));
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({ member: { ...baseOpts().member, mcpServers: ["playwright"] } }));

    const loaderOptions = resourceLoaderCtor.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.additionalExtensionPaths).toHaveLength(1);
    expect(loaderOptions.additionalExtensionPaths[0]).toMatch(/vendor\/pi-mcp-adapter\/index\.ts$/);
    expect(createAgentSession.mock.calls[0][0].tools).toContain("mcp");
    expect(createAgentSession.mock.calls[0][0].tools).not.toContain("playwright_browser_navigate");
    const scopedPath = sessionExtensionSetFlagValue.mock.calls.find((call) => call[0] === "mcp-config")?.[1];
    expect(scopedPath).toMatch(/\.bossmode\/mcp\/runtime\/scopes\/room-a\/pm\/mcp\.json$/);
    const scoped = JSON.parse(readFileSync(scopedPath, "utf-8"));
    expect(Object.keys(scoped.mcpServers)).toEqual(["playwright"]);
    expect(scoped.mcpServers.github).toBeUndefined();
    expect(sessionBindExtensions).toHaveBeenCalledWith(expect.objectContaining({ mode: "print", onError: expect.any(Function) }));
    expect(process.env.MCP_DIRECT_TOOLS).toBe("__none__");
    expect(process.env.BOSSMODE_MCP_CONFIG_STRICT).toBe("1");
  });

  it("resumes saved session and appends configured model change when saved model differs", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    openedSessionModel = { provider: "anthropic", modelId: "claude-opus-4-7" };
    const setModel = vi.fn().mockResolvedValue(undefined);
    createAgentSession.mockResolvedValueOnce({
      session: {
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
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-6" }));
  });

  it("rolls back the failed turn and resumes instead of discarding history when saved session ended with assistant provider error", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
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
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
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
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
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
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
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

  it("refreshes registry and awaits SDK model switch", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    const setModel = vi.fn().mockResolvedValue(undefined);
    createAgentSession.mockResolvedValueOnce({
      session: {
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
        sessionId: "session-a",
        sessionFile: join(dir, "session.json"),
        thinkingLevel: "off",
        settingsManager: { getCompactionSettings: settingsGetCompactionSettings },
      },
    });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts());
    await handle.refreshModelRegistry?.();
    await handle.setModel?.("anthropic/claude-opus-4-6");

    expect(modelRegistryRefresh).toHaveBeenCalled();
    expect(authReload).toHaveBeenCalled();
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-6" }));
    expect(handle.runtimeParams?.model).toBe("anthropic/claude-opus-4-6");
  });

  it("reports configured skill names separately from SDK-loadable skill paths", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts({
      skillPaths: [join(dir, "missing-skill")],
      skillNames: ["impeccable", "custom-skill"],
    }));

    expect(resourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({ additionalSkillPaths: [] }));
    expect(handle.runtimeParams?.skills).toEqual(["impeccable", "custom-skill"]);
  });
});
