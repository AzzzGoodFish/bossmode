/**
 * PiSdkRuntime background session variant (CreateAgentOpts.background):
 * - session writes into the task dir (SessionManager.create receives it)
 * - custom tool factory is built with execution:"background"
 * - member session identity is NOT reported via onSessionChanged
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SDK/resource-loader unit boundary: no vendor loading or MCP transport here.
vi.mock("../../src/engine/runtime/mcp-factory.js", () => ({
  loadDatabaseMcpFactory: async () => ({ name: "pi-mcp-adapter", factory: () => {} }),
}));

vi.mock("../../src/workspace/extension-store.js", () => ({
  resolveMemberExtensionPaths: () => [],
  resolveMemberExtensionSkillPaths: () => [],
}));

let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;
let memberId: string;
let roomId: string;
const runtimes: import("../../src/engine/runtime/pi-sdk.js").PiSdkRuntime[] = [];
async function createRuntime() {
  const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
  const runtime = new PiSdkRuntime();
  runtimes.push(runtime);
  return runtime;
}
let exportedConfig: any = null;
let bossmodeConfig: any;
const modelRegistryGetApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "sk-test" }));
const createAgentSession = vi.fn();
const sessionManagerCreate = vi.fn();
const sessionManagerOpen = vi.fn();
const toolsFactory = vi.fn(() => [
  { name: "query_room_messages" },
  { name: "chat" },
]);
const onSessionChanged = vi.fn();
const sessionPrompt = vi.fn(async () => {});
let sessionSubscriber: ((event: any) => void) | undefined;

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  readConfig: () => bossmodeConfig,
}));

vi.mock("../../src/engine/model-credentials.js", () => ({
  createDatabaseModelRuntime: async () => ({ refresh: vi.fn(), getAuth: vi.fn(), checkAuth: vi.fn() }),
  getBossmodePiRuntimeRoot: () => join(dir, "pi-agent", "runtime"),
  exportPiConfigForMember: () => exportedConfig,
  normalizeModelRef: (modelRef: string) => modelRef,
  createCredentialStore: (profile: any) => ({ kind: "credentials", profile, read: vi.fn(), list: vi.fn(async () => []), modify: vi.fn(), delete: vi.fn() }),
  getModelCredentialProfile: (id: string) => ({ id, providerSlug: exportedConfig?.profile?.providerSlug ?? "anthropic", enabled: true, name: "Test account" }),
  resolvePiAgentDir: (roomIdOrScope: string, memberIdOrName: string) =>
    join(dir, "pi-agent", "runtime", String(roomIdOrScope).replace(/[^a-zA-Z0-9._-]+/g, "_"), String(memberIdOrName).replace(/[^a-zA-Z0-9._-]+/g, "_")),
}));

vi.mock("../../src/engine/runtime/bossmode-sdk-tools.js", () => ({
  createBossmodeSdkTools: (opts: any) => toolsFactory(opts),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  class DefaultResourceLoader {
    constructor(_options: any) {}
    async reload() {}
    getExtensions() { return { extensions: [{ path: "<inline:pi-mcp-adapter>", tools: new Map([["mcp", {}]]) }], errors: [] }; }
  }
  return {
    VERSION: "test-sdk",
    ModelRuntime: {
      create: async () => ({ kind: "model-runtime", refresh: vi.fn(), getAuth: vi.fn(), checkAuth: vi.fn() }),
    },
    ModelRegistry: class {
      constructor(_runtime: any) {}
      find() { return { provider: exportedConfig?.profile?.providerSlug ?? "anthropic", id: "model-x" }; }
      getApiKeyAndHeaders(...args: any[]) { return modelRegistryGetApiKeyAndHeaders(...args); }
      async refresh() {}
    },
    SettingsManager: {
      create: () => ({
        kind: "settings",
        applyOverrides: vi.fn(),
        getTransport: () => "auto",
        getWebSocketConnectTimeoutMs: () => 60000,
        getHttpIdleTimeoutMs: () => 600000,
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 }),
      }),
    },
    SessionManager: {
      create: (...args: Parameters<typeof actual.SessionManager.create>) => {
        sessionManagerCreate(...args);
        return actual.SessionManager.create(...args);
      },
      open: (...args: Parameters<typeof actual.SessionManager.open>) => {
        sessionManagerOpen(...args);
        return actual.SessionManager.open(...args);
      },
    },
    DefaultResourceLoader,
    createAgentSession: async (...args: any[]) => {
      const result = await createAgentSession(...args);
      result.session.sessionId = args[0].sessionManager.getSessionId();
      result.session.sessionFile = args[0].sessionManager.getSessionFile();
      result.session.modelRuntime = args[0].modelRuntime;
      result.session.model = args[0].model;
      return result;
    },
  };
});

function baseOpts(overrides: Record<string, any> = {}) {
  return {
    cwd: dir,
    roomId,
    member: { id: memberId, name: "pm", agent: "pm", runtime: "pi-cli", model: "anthropic/model-x", credentialId: "cred-a", thinkingLevel: "off" },
    agentPrompt: "agent prompt",
    envPrompt: "env prompt",
    skillPaths: [],
    roomMembers: ["pm"],
    callbacks: { onChat: vi.fn(), onMention: vi.fn() },
    ...overrides,
  };
}

describe("PiSdkRuntime background session variant", () => {
  beforeEach(async () => {
    const { coreFixture } = await import("../helpers/core-fixture.js");
    fixture = coreFixture();
    dir = fixture.root;
    const { saveAgentDefinition } = await import("../../src/workforce/agent-store.js");
    saveAgentDefinition("general", "---\nname: general\nskills: []\n---\nGeneral");
    const { createMember } = await import("../../src/workspace/member-registry.js");
    const { createRoom, stampGlobalMemberIds } = await import("../../src/workspace/room-store.js");
    memberId = createMember({ name: "pm", agentTemplate: "general" }).id;
    roomId = createRoom("SDK background", undefined, []).id;
    stampGlobalMemberIds(roomId, [memberId], memberId);
    exportedConfig = null;
    vi.clearAllMocks();
    sessionSubscriber = undefined;
    sessionPrompt.mockResolvedValue(undefined);
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: false } };
    createAgentSession.mockImplementation(async () => ({
      session: {
        subscribe: vi.fn((subscriber: (event: any) => void) => { sessionSubscriber = subscriber; return vi.fn(); }),
        prompt: sessionPrompt,
        abort: vi.fn(),
        abortCompaction: vi.fn(),
        abortBranchSummary: vi.fn(),
        dispose: vi.fn(),
        reload: vi.fn(),
        compact: vi.fn(),
        setModel: vi.fn(),
        setThinkingLevel: vi.fn(),
        setActiveToolsByName: vi.fn(),
        getActiveToolNames: vi.fn(() => []),
        getAllTools: vi.fn(() => []),
        bindExtensions: vi.fn(async () => {}),
        extensionRunner: { setFlagValue: vi.fn(), emit: vi.fn(async () => {}), hasHandlers: vi.fn(() => false) },
        thinkingLevel: "off",
        settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 }) },
        model: { provider: "anthropic", id: "model-x", contextWindow: 18000 },
      },
    }));
  });

  afterEach(async () => {
    try { for (const runtime of runtimes.splice(0)) await runtime.shutdownAll(); }
    finally { fixture.close(); }
  });

  it("writes the child session into the background task dir and skips member session reporting", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const taskDir = join(dir, "members", memberId, "background-tasks", "2026-09-07", "bgt-test");

    const handle = await (await createRuntime()).createAgent(baseOpts({
      background: { sessionDir: taskDir },
      onSessionChanged,
    }));

    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(sessionManagerCreate.mock.calls[0][1]).toBe(taskDir);
    expect(onSessionChanged).not.toHaveBeenCalled();
    expect(handle.sessionId).toBe(createAgentSession.mock.calls[0][0].sessionManager.getSessionId());
  });

  it("builds custom tools with the background execution variant", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    await (await createRuntime()).createAgent(baseOpts({
      background: { sessionDir: join(dir, "taskdir") },
    }));
    expect(toolsFactory).toHaveBeenCalledWith(expect.objectContaining({ execution: "background", memberId }));
  });

  it("removes each successfully cleaned background handle before the next task", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const runtime = await createRuntime();

    const first = await runtime.createAgent(baseOpts({ background: { sessionDir: join(dir, "task-one") } }));
    const dispose = (await createAgentSession.mock.results[0].value).session.dispose;
    await first.destroyAndWait!();
    expect(dispose).toHaveBeenCalledTimes(1);

    const second = await runtime.createAgent(baseOpts({ background: { sessionDir: join(dir, "task-two") } }));
    await second.destroyAndWait!();
    const secondDispose = (await createAgentSession.mock.results[1].value).session.dispose;
    expect(secondDispose).not.toBe(dispose);
    expect(secondDispose).toHaveBeenCalledOnce();
    await runtime.shutdownAll();
    expect(dispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("publishes a live session only after the SDK file materializes", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    await (await createRuntime()).createAgent(baseOpts({ onSessionChanged }));
    expect(onSessionChanged).not.toHaveBeenCalled();
    const manager = createAgentSession.mock.calls[0][0].sessionManager;
    manager.appendMessage({ role: "user", content: "first requirement", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], stopReason: "stop", timestamp: Date.now() });
    const file = manager.getSessionFile();
    sessionSubscriber?.({ type: "agent_start" });
    expect(onSessionChanged).toHaveBeenCalledWith({ sessionId: manager.getSessionId(), sessionFile: file });
    sessionSubscriber?.({ type: "agent_end" });
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    expect(toolsFactory).toHaveBeenCalledWith(expect.objectContaining({ execution: "live" }));
  });

  it("does not publish when the first live turn fails before the SDK file exists", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    sessionPrompt.mockRejectedValueOnce(new Error("cancelled before materialization"));
    const handle = await (await createRuntime()).createAgent(baseOpts({ onSessionChanged }));
    await expect(handle.prompt("first")).rejects.toThrow("cancelled before materialization");
    expect(onSessionChanged).not.toHaveBeenCalled();
  });
});
