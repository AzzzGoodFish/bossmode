import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let exportedConfig: any = null;
const authCreate = vi.fn();
const modelRegistryCreate = vi.fn();
const createAgentSession = vi.fn();
const resourceLoaderCtor = vi.fn();
const sessionManagerCreate = vi.fn();
const sessionManagerOpen = vi.fn();
const settingsManagerCreate = vi.fn();

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
        return { find: () => ({ provider: "anthropic", id: "claude-sonnet-4-6" }) };
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
        return { kind: "session", args };
      },
      open: (...args: any[]) => {
        sessionManagerOpen(...args);
        return { kind: "session", args };
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

  it("uses SDK default auth and model registry when no Bossmode credential profile exists", async () => {
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(authCreate).toHaveBeenCalledWith();
    expect(modelRegistryCreate).toHaveBeenCalledWith(expect.anything());
    expect(authCreate).not.toHaveBeenCalledWith(expect.stringContaining("auth.json"));
    expect(modelRegistryCreate).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("models.json"));
    expect(sessionManagerCreate).toHaveBeenCalledWith(dir, expect.stringContaining("pi-agent/runtime/room-a/pm/sessions"));
  });

  it("uses exported Bossmode auth and model files when a credential profile exists", async () => {
    const agentDir = join(dir, "profile-agent-dir");
    exportedConfig = { agentDir, extensionPaths: [] };
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    await new PiSdkRuntime().createAgent(baseOpts());

    expect(authCreate).toHaveBeenCalledWith(join(agentDir, "auth.json"));
    expect(modelRegistryCreate).toHaveBeenCalledWith(expect.anything(), join(agentDir, "models.json"));
  });

  it("reports configured skill names separately from SDK-loadable skill paths", async () => {
    const { PiSdkRuntime } = await import("../../src/engine/runtime/pi-sdk.js");

    const handle = await new PiSdkRuntime().createAgent(baseOpts({
      skillPaths: [join(dir, "missing-skill")],
      skillNames: ["impeccable", "custom-skill"],
    }));

    expect(resourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({ additionalSkillPaths: [] }));
    expect(handle.runtimeParams?.skills).toEqual(["impeccable", "custom-skill"]);
  });
});
