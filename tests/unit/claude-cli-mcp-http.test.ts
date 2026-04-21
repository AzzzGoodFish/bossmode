import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
const execSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const symlinkSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const readdirSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
}));

vi.mock("node:fs", () => ({
  writeFileSync: writeFileSyncMock,
  unlinkSync: unlinkSyncMock,
  existsSync: existsSyncMock,
  symlinkSync: symlinkSyncMock,
  mkdirSync: mkdirSyncMock,
  readdirSync: readdirSyncMock,
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/test",
}));

function createFakeProc() {
  const proc = new EventEmitter() as any;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter() as any;
  stdin.writable = true;
  stdin.write = vi.fn();

  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.pid = 4321;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    proc.emit("exit", 0, null);
  });
  return proc;
}

describe("ClaudeCliRuntime MCP HTTP + session callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    existsSyncMock.mockImplementation((p: any) => String(p).includes("session_hook_forwarder.cjs"));
    spawnMock.mockImplementation(() => createFakeProc());
    execSyncMock.mockReturnValue("claude 1.0.0");
    readdirSyncMock.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("cleans legacy /tmp/bossmode-mcp-*.json files on runtime init", async () => {
    const { ClaudeCliRuntime } = await import("../../src/engine/runtime/claude-cli.js");

    readdirSyncMock.mockReturnValue([
      "bossmode-mcp-pm-1.json",
      "bossmode-mcp-dev-2.json",
      "bossmode-hook-dev-3.json",
      "other-file.txt",
    ]);

    new ClaudeCliRuntime("claude", 12345);

    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/bossmode-mcp-pm-1.json");
    expect(unlinkSyncMock).toHaveBeenCalledWith("/tmp/bossmode-mcp-dev-2.json");
    expect(unlinkSyncMock).not.toHaveBeenCalledWith("/tmp/bossmode-hook-dev-3.json");
  });

  it("passes inline MCP HTTP config and --settings to claude args", async () => {
    const { ClaudeCliRuntime } = await import("../../src/engine/runtime/claude-cli.js");

    const runtime = new ClaudeCliRuntime("claude", 12345);
    const p = runtime.createAgent({
      cwd: "/tmp",
      roomId: "room-a",
      member: {
        id: "dev",
        name: "dev",
        type: "agent",
        agent: "developer",
        model: "sonnet",
        runtime: "claude-cli",
        thinkingLevel: "off",
      },
      agentPrompt: "system",
      envPrompt: "env",
      skillPaths: [],
      roomMembers: ["dev", "pm"],
      callbacks: {
        onChat: async () => {},
        onMention: async () => {},
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    const mcpIdx = spawnArgs.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);

    const mcpConfig = JSON.parse(spawnArgs[mcpIdx + 1]);
    expect(mcpConfig.mcpServers.bossmode.type).toBe("http");
    expect(mcpConfig.mcpServers.bossmode.url).toBe("http://127.0.0.1:12345/mcp/room-a/dev");

    const settingsIdx = spawnArgs.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(-1);
    expect(spawnArgs[settingsIdx + 1]).toContain("/tmp/bossmode-hook-dev-");
    expect(writeFileSyncMock).toHaveBeenCalled();
  });

  it("notifies onSessionChanged for each new session_id", async () => {
    const { ClaudeCliRuntime } = await import("../../src/engine/runtime/claude-cli.js");

    const runtime = new ClaudeCliRuntime("claude", 12345);
    const onSessionChanged = vi.fn();

    const p = runtime.createAgent({
      cwd: "/tmp",
      roomId: "room-a",
      member: {
        id: "dev",
        name: "dev",
        type: "agent",
        agent: "developer",
        model: "sonnet",
        runtime: "claude-cli",
        thinkingLevel: "off",
      },
      agentPrompt: "system",
      envPrompt: "env",
      skillPaths: [],
      roomMembers: ["dev", "pm"],
      onSessionChanged,
      callbacks: {
        onChat: async () => {},
        onMention: async () => {},
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    await p;

    const proc = spawnMock.mock.results[0].value as any;
    proc.stdout.emit("data", Buffer.from('{"type":"system","session_id":"s1"}\n'));
    proc.stdout.emit("data", Buffer.from('{"type":"system","session_id":"s1"}\n'));
    proc.stdout.emit("data", Buffer.from('{"type":"system","session_id":"s2"}\n'));

    expect(onSessionChanged).toHaveBeenCalledTimes(2);
    expect(onSessionChanged.mock.calls[0][0]).toEqual({ sessionId: "s1" });
    expect(onSessionChanged.mock.calls[1][0]).toEqual({ sessionId: "s2" });
  });

  it("does not emit agent_end or reject prompt on 90s stdout inactivity timeout", async () => {
    const { ClaudeCliRuntime } = await import("../../src/engine/runtime/claude-cli.js");

    const runtime = new ClaudeCliRuntime("claude", 12345);
    const p = runtime.createAgent({
      cwd: "/tmp",
      roomId: "room-a",
      member: {
        id: "dev",
        name: "dev",
        type: "agent",
        agent: "developer",
        model: "sonnet",
        runtime: "claude-cli",
        thinkingLevel: "off",
      },
      agentPrompt: "system",
      envPrompt: "env",
      skillPaths: [],
      roomMembers: ["dev", "pm"],
      callbacks: {
        onChat: async () => {},
        onMention: async () => {},
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    const handle = await p;

    const events: any[] = [];
    handle.subscribe((ev) => events.push(ev));

    let promptState: "pending" | "resolved" | "rejected" = "pending";
    const promptPromise = handle.prompt("summarize large room");
    promptPromise.then(() => { promptState = "resolved"; }).catch(() => { promptState = "rejected"; });

    await vi.advanceTimersByTimeAsync(90000);
    await Promise.resolve();

    expect(promptState).toBe("pending");
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(0);

    handle.destroy();
  });
});
