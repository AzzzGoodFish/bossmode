/**
 * PiSdkRuntime background session variant (CreateAgentOpts.background):
 * - session writes into the task dir (SessionManager.create receives it)
 * - custom tool factory is built with execution:"background"
 * - member session identity is NOT reported via onSessionChanged
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const onSessionChanged = vi.fn();
const sessionPrompt = vi.fn(async () => {});
let sessionSubscriber: ((event: any) => void) | undefined;

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
    sessionSubscriber = undefined;
    sessionPrompt.mockResolvedValue(undefined);
    bossmodeConfig = { runtime: { sessionResume: true }, mcp: { enabled: false } };
    createAgentSession.mockResolvedValue({
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
    expect(toolsFactory).toHaveBeenCalledWith(expect.objectContaining({ execution: "background", memberId: "pm" }));
  });

  it("removes each successfully cleaned background handle before the next task", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const runtime = new PiSdkRuntime();

    const first = await runtime.createAgent(baseOpts({ background: { sessionDir: join(dir, "task-one") } }));
    expect((runtime as any).handles.size).toBe(1);
    await first.destroyAndWait!();
    expect((runtime as any).handles.size).toBe(0);

    const second = await runtime.createAgent(baseOpts({ background: { sessionDir: join(dir, "task-two") } }));
    expect((runtime as any).handles.size).toBe(1);
    await second.destroyAndWait!();
    expect((runtime as any).handles.size).toBe(0);
  });

  it("publishes a live session only after the SDK file materializes", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    await new PiSdkRuntime().createAgent(baseOpts({ onSessionChanged }));
    expect(onSessionChanged).not.toHaveBeenCalled();
    const file = join(dir, "task", "session.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, '{"type":"session"}\n');
    sessionSubscriber?.({ type: "agent_start" });
    expect(onSessionChanged).toHaveBeenCalledWith({ sessionId: "child-sdk-session-id", sessionFile: file });
    sessionSubscriber?.({ type: "agent_end" });
    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    expect(toolsFactory).toHaveBeenCalledWith(expect.objectContaining({ execution: "live" }));
  });

  it("does not publish when the first live turn fails before the SDK file exists", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [], profile: { id: "test-profile", providerSlug: "anthropic" } };
    sessionPrompt.mockRejectedValueOnce(new Error("cancelled before materialization"));
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");
    const handle = await new PiSdkRuntime().createAgent(baseOpts({ onSessionChanged }));
    await expect(handle.prompt("first")).rejects.toThrow("cancelled before materialization");
    expect(onSessionChanged).not.toHaveBeenCalled();
  });
});
