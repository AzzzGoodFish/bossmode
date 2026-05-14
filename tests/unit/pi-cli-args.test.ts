import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
const execSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const exportPiConfigForMemberMock = vi.fn(() => null);

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

vi.mock("../../src/engine/model-credentials.js", () => ({
  exportPiConfigForMember: exportPiConfigForMemberMock,
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
    exportPiConfigForMemberMock.mockReturnValue(null);
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

  it("passes only the role prompt via --system-prompt and appends Bossmode overlays", async () => {
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
      agentPrompt: "ROLE PROMPT",
      envPrompt: "DOCS INDEX\nENV PROMPT",
      rulesPrompt: "ROOM RULES",
      skillPaths: [],
      roomMembers: ["dev", "pm"],
      callbacks: { onChat: async () => {}, onMention: async () => {} },
    });

    await vi.advanceTimersByTimeAsync(500);
    await p;

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).toContain("--system-prompt");
    expect(spawnArgs[spawnArgs.indexOf("--system-prompt") + 1]).toBe("ROLE PROMPT");
    const appendValues = spawnArgs
      .map((arg, i) => (arg === "--append-system-prompt" ? spawnArgs[i + 1] : null))
      .filter(Boolean);
    expect(appendValues).toEqual(["DOCS INDEX\nENV PROMPT", "ROOM RULES"]);
  });

  it("does not pass --system-prompt for builtin/general when only Bossmode overlays exist", async () => {
    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");

    const runtime = new PiCliRuntime("pi", 12345);
    const p = runtime.createAgent({
      cwd: "/tmp",
      roomId: "room-a",
      member: {
        id: "general",
        name: "general",
        type: "agent",
        agent: "general",
        model: "sonnet",
        runtime: "pi-cli",
        thinkingLevel: "off",
      },
      agentPrompt: "",
      envPrompt: "DOCS INDEX\nENV PROMPT",
      rulesPrompt: "ROOM RULES",
      skillPaths: [],
      roomMembers: ["general", "pm"],
      callbacks: { onChat: async () => {}, onMention: async () => {} },
    });

    await vi.advanceTimersByTimeAsync(500);
    await p;

    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("--system-prompt");
    const appendValues = spawnArgs
      .map((arg, i) => (arg === "--append-system-prompt" ? spawnArgs[i + 1] : null))
      .filter(Boolean);
    expect(appendValues).toEqual(["DOCS INDEX\nENV PROMPT", "ROOM RULES"]);
  });

  it("exports configured model credentials to pi env and extension args", async () => {
    exportPiConfigForMemberMock.mockReturnValue({
      agentDir: "/tmp/bossmode-pi-agent",
      extensionPaths: ["/tmp/profile-extension.ts"],
    });
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
        model: "openrouter/anthropic/claude-sonnet",
        runtime: "pi-cli",
        thinkingLevel: "off",
        credentialId: "cred-1",
      },
      agentPrompt: "system",
      envPrompt: "env",
      skillPaths: [],
      roomMembers: ["dev", "pm"],
      callbacks: { onChat: async () => {}, onMention: async () => {} },
    });

    await vi.advanceTimersByTimeAsync(500);
    await p;

    expect(exportPiConfigForMemberMock).toHaveBeenCalledWith({
      roomId: "room-a",
      memberName: "dev",
      modelRef: "openrouter/anthropic/claude-sonnet",
      credentialId: "cred-1",
    });
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    const spawnOpts = spawnMock.mock.calls[0][2] as any;
    expect(spawnArgs).toContain("/tmp/profile-extension.ts");
    expect(spawnOpts.env.PI_CODING_AGENT_DIR).toBe("/tmp/bossmode-pi-agent");
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

    // Regression guard: newline escaping in the generated extension.
    // Template strings inside the extension must use \\n (double-escaped) so
    // the emitted .ts file contains a literal \n character sequence, not an
    // actual newline that would split a string literal and cause a ParseError.
    // Specifically validate the two places that previously regressed:
    //   1. truncate() trailing text
    //   2. query_room_messages join separator
    expect(extensionContent).toContain('+ "\\n\\n--- Result truncated');
    expect(extensionContent).toContain('.join("\\n\\n")');
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

  it("handles /compact as fire-and-forget and resolves on async compact response", async () => {
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
    const proc = spawnMock.mock.results[0].value as any;

    const events: any[] = [];
    handle.subscribe((ev) => events.push(ev));

    let compactResolved = false;
    const compactPromise = handle.prompt("/compact").then(() => {
      compactResolved = true;
    });

    expect(proc.stdin.write).toHaveBeenCalledWith('{"type":"compact"}\n');

    await vi.advanceTimersByTimeAsync(31000);
    expect(compactResolved).toBe(false);

    proc.stdout.emit("data", Buffer.from('{"type":"response","command":"compact","success":true,"data":{"tokensBefore":1234,"summary":"trimmed"}}\n'));
    await compactPromise;

    expect(events.some((e) => e.type === "message_update" && e.text === "Compacting context...")).toBe(true);
    expect(events.some((e) => e.type === "message_end" && String(e.text).includes("Tokens before: 1234"))).toBe(true);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);

    handle.destroy();
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
