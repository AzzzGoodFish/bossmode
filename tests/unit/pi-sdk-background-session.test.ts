/**
 * PiSdkRuntime background session variant (CreateAgentOpts.background):
 * - session writes into the task dir (SessionManager.create receives it)
 * - custom tool factory is built with execution:"background"
 * - member session identity is NOT reported via onSessionChanged
 * - Codex fork mode registers HTTP session-id inheritance; other providers do not
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workspace/extension-store.js", () => ({
  resolveMemberExtensionPaths: () => [],
  resolveMemberExtensionSkillPaths: () => [],
}));

let dir: string;
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
const inheritanceRegister = vi.fn(() => ({ release: vi.fn() }));
const onSessionChanged = vi.fn();

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => join(dir, ".bossmode"),
  readConfig: () => bossmodeConfig,
}));

vi.mock("../../src/engine/model-credentials.js", () => ({
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

vi.mock("../../src/engine/runtime/codex-header-inheritance.js", () => ({
  registerCodexSessionHeaderInheritance: (...args: any[]) => inheritanceRegister(...args),
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class DefaultResourceLoader {
    constructor(_options: any) {}
    async reload() {}
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
      create: (...args: any[]) => {
        sessionManagerCreate(...args);
        return { kind: "created-session", args, buildSessionContext: () => ({ model: null }) };
      },
      open: (...args: any[]) => {
        sessionManagerOpen(...args);
        return {
          kind: "opened-session",
          args,
          buildSessionContext: () => ({ model: null }),
          getLeafEntry: () => null,
          branch: vi.fn(),
          resetLeaf: vi.fn(),
        };
      },
    },
    DefaultResourceLoader,
    createAgentSession: async (...args: any[]) => {
      const result = await createAgentSession(...args);
      result.session.modelRuntime = args[0].modelRuntime;
      result.session.model = args[0].model;
      return result;
    },
  };
});

function baseOpts(overrides: Record<string, any> = {}) {
  return {
    cwd: dir,
    roomId: "room-a",
    member: { id: "pm", name: "pm", agent: "pm", runtime: "pi-cli", model: "anthropic/model-x", credentialId: "cred-a", thinkingLevel: "off" },
    agentPrompt: "agent prompt",
    envPrompt: "env prompt",
    skillPaths: [],
    roomMembers: ["pm"],
    callbacks: { onChat: vi.fn(), onMention: vi.fn() },
    ...overrides,
  };
}

describe("PiSdkRuntime background session variant", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-pi-bg-"));
    exportedConfig = null;
    vi.clearAllMocks();
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: false } };
    createAgentSession.mockResolvedValue({
      session: {
        subscribe: vi.fn(() => vi.fn()),
        prompt: vi.fn(),
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
        sessionId: "child-sdk-session-id",
        sessionFile: join(dir, "task", "session.jsonl"),
        thinkingLevel: "off",
        settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 1000, keepRecentTokens: 20000 }) },
        model: { provider: "anthropic", id: "model-x", contextWindow: 18000 },
      },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the child session into the background task dir and skips member session reporting", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const taskDir = join(dir, "members", "m1", "background-tasks", "2026-09-07", "bgt-test");

    const handle = await new PiSdkRuntime().createAgent(baseOpts({
      background: { sessionDir: taskDir },
      onSessionChanged,
    }));

    expect(sessionManagerCreate).toHaveBeenCalled();
    expect(sessionManagerCreate.mock.calls[0][1]).toBe(taskDir);
    expect(onSessionChanged).not.toHaveBeenCalled();
    expect(handle.sessionId).toBe("child-sdk-session-id");
  });

  it("builds custom tools with the background execution variant", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    await new PiSdkRuntime().createAgent(baseOpts({
      background: { sessionDir: join(dir, "taskdir") },
    }));
    expect(toolsFactory).toHaveBeenCalledWith(expect.objectContaining({ execution: "background" }));
  });

  it("registers codex session-id inheritance for fork-mode codex children only", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "openai-codex" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      background: { sessionDir: join(dir, "taskdir"), inheritCodexSessionIdFrom: "parent-sdk-session-id" },
    }));
    expect(inheritanceRegister).toHaveBeenCalledWith("child-sdk-session-id", "parent-sdk-session-id");

    inheritanceRegister.mockClear();
    await new PiSdkRuntime().createAgent(baseOpts({
      background: { sessionDir: join(dir, "taskdir2") }, // no parent id → no registration
    }));
    await new PiSdkRuntime().createAgent(baseOpts()); // live session → never registers
    expect(inheritanceRegister).not.toHaveBeenCalled();
  });

  it("live sessions still report identity via onSessionChanged", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    await new PiSdkRuntime().createAgent(baseOpts({ onSessionChanged }));
    expect(onSessionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "child-sdk-session-id" }),
    );
    expect(toolsFactory).toHaveBeenCalledWith(expect.objectContaining({ execution: "live" }));
  });
});
