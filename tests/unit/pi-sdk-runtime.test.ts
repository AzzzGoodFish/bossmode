import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let exportedConfig: any = null;
const authCreate = vi.fn();
const modelRegistryCreate = vi.fn();
const modelRegistryRefresh = vi.fn();
const authReload = vi.fn();
const createAgentSession = vi.fn();
const resourceLoaderCtor = vi.fn();
const sessionManagerCreate = vi.fn();
const sessionManagerOpen = vi.fn();
const settingsManagerCreate = vi.fn();
let openedSessionModel: { provider: string; modelId: string } | null = null;
let openedLeafEntry: any = null;

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
        return { find: () => ({ provider: "anthropic", id: "claude-sonnet-4-6" }), refresh: modelRegistryRefresh, authStorage: { reload: authReload } };
      },
    },
    SettingsManager: {
      create: (...args: any[]) => {
        settingsManagerCreate(...args);
        return { kind: "settings", args };
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

describe("PiSdkRuntime", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-pi-sdk-"));
    exportedConfig = null;
    openedSessionModel = null;
    openedLeafEntry = null;
    vi.clearAllMocks();
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
        sessionId: "session-a",
        sessionFile: join(dir, "session.json"),
        thinkingLevel: "off",
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
      },
    });
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      member: { ...baseOpts().member, model: "anthropic/claude-fable-5" },
      resumeSession: { sessionId: "old-session", sessionFile: join(dir, "old-session.jsonl") },
    }));

    expect(sessionManagerOpen).toHaveBeenCalledWith(join(dir, "old-session.jsonl"), expect.any(String), dir);
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("opened-session");
    expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-6" }));
  });

  it("starts fresh instead of resuming when saved session ended with assistant provider error", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    openedSessionModel = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    openedLeafEntry = {
      type: "message",
      message: { role: "assistant", stopReason: "error", errorMessage: "An unknown error occurred" },
    };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      resumeSession: { sessionId: "old-session", sessionFile: join(dir, "old-session.jsonl") },
    }));

    expect(sessionManagerOpen).toHaveBeenCalledWith(join(dir, "old-session.jsonl"), expect.any(String), dir);
    expect(sessionManagerCreate).toHaveBeenCalledWith(dir, expect.any(String));
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("created-session");
  });

  it("resumes saved session when saved model matches configured model", async () => {
    exportedConfig = { agentDir: join(dir, "profile-agent-dir"), extensionPaths: [] };
    openedSessionModel = { provider: "anthropic", modelId: "claude-sonnet-4-6" };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts({
      resumeSession: { sessionId: "old-session", sessionFile: join(dir, "old-session.jsonl") },
    }));

    expect(sessionManagerOpen).toHaveBeenCalledWith(join(dir, "old-session.jsonl"), expect.any(String), dir);
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession.mock.calls[0][0].sessionManager.kind).toBe("opened-session");
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
