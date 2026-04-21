import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
const execSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execSync: execSyncMock,
}));

vi.mock("node:fs", () => ({
  writeFileSync: writeFileSyncMock,
  unlinkSync: unlinkSyncMock,
  existsSync: existsSyncMock,
  mkdirSync: vi.fn(),
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
  proc.pid = 5678;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    proc.emit("exit", 0, null);
  });
  return proc;
}

describe("PiCliRuntime spawn args", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(false);
    spawnMock.mockImplementation(() => createFakeProc());
    execSyncMock.mockReturnValue("pi 1.0.0");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not force --no-extensions and keeps --no-skills", async () => {
    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");

    const runtime = new PiCliRuntime("pi", 12345);
    const p = runtime.createAgent({
      cwd: "/tmp",
      roomId: "room-a",
      member: {
        id: "dev",
        name: "dev",
        type: "agent",
        agent: "developer",
        model: "sonnet",
        runtime: "pi-cli",
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

    await vi.advanceTimersByTimeAsync(500);
    await p;

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("--no-extensions");
    expect(spawnArgs).toContain("--no-skills");
  });

  it("registers write_summary tool in generated extension", async () => {
    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");

    const runtime = new PiCliRuntime("pi", 12345);
    const p = runtime.createAgent({
      cwd: "/tmp",
      roomId: "room-a",
      member: {
        id: "summarizer",
        name: "summarizer",
        type: "agent",
        agent: "summarizer",
        model: "sonnet",
        runtime: "pi-cli",
        thinkingLevel: "off",
      },
      agentPrompt: "system",
      envPrompt: "env",
      skillPaths: [],
      roomMembers: ["summarizer", "pm"],
      callbacks: {
        onChat: async () => {},
        onMention: async () => {},
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    await p;

    const extensionContent = writeFileSyncMock.mock.calls[0][1] as string;
    expect(extensionContent).toContain('name: "write_summary"');
    expect(extensionContent).toContain('tool: "write_summary"');
    // Regression guard: quote escaping in the generated summary tool.
    // Template literal used `\"` (→ literal ") which breaks the emitted JS.
    // Correct form is `\\"` so the output file contains `\"`.
    expect(extensionContent).toContain('Summary created: \\"');
    expect(extensionContent).not.toMatch(/Summary created: ""/);
  });

  it("maps get_state response data to onSessionChanged callback", async () => {
    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");

    const runtime = new PiCliRuntime("pi", 12345);
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
        runtime: "pi-cli",
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

    await vi.advanceTimersByTimeAsync(500);
    await p;

    const proc = spawnMock.mock.results[0].value as any;
    expect(proc.stdin.write).toHaveBeenCalledWith('{"type":"get_state"}\n');

    proc.stdout.emit("data", Buffer.from('{"type":"response","command":"get_state","success":true,"data":{"sessionId":"test-id","sessionFile":"/tmp/test.jsonl"}}\n'));

    expect(onSessionChanged).toHaveBeenCalledTimes(1);
    expect(onSessionChanged).toHaveBeenCalledWith({
      sessionId: "test-id",
      sessionFile: "/tmp/test.jsonl",
    });
  });

  it("does not emit agent_end or reject prompt on 90s stdout inactivity timeout", async () => {
    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");

    const runtime = new PiCliRuntime("pi", 12345);
    const p = runtime.createAgent({
      cwd: "/tmp",
      roomId: "room-a",
      member: {
        id: "dev",
        name: "dev",
        type: "agent",
        agent: "developer",
        model: "sonnet",
        runtime: "pi-cli",
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

    await vi.advanceTimersByTimeAsync(500);
    const handle = await p;

    const events: any[] = [];
    handle.subscribe((ev) => events.push(ev));

    let promptState: "pending" | "resolved" | "rejected" = "pending";
    const promptPromise = handle.prompt("long running task");
    promptPromise.then(() => { promptState = "resolved"; }).catch(() => { promptState = "rejected"; });

    await vi.advanceTimersByTimeAsync(90000);
    await Promise.resolve();

    expect(promptState).toBe("pending");
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(0);

    const proc = spawnMock.mock.results[0].value as any;
    expect(proc.stdin.write).not.toHaveBeenCalledWith('{"type":"abort"}\n');

    handle.destroy();
  });
});
