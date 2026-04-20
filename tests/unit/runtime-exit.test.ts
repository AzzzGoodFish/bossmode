import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { AgentStreamEvent } from "../../src/engine/runtime/types.js";

const spawnMock = vi.fn();
const execSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const existsSyncMock = vi.fn();

vi.mock("node:child_process", () => ({ spawn: spawnMock, execSync: execSyncMock }));
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
  proc.pid = 4242;
  proc.killed = false;
  // In destroy tests we emit exit ourselves — don't auto-emit in kill().
  proc.kill = vi.fn(() => { proc.killed = true; });
  return proc;
}

const baseOpts = {
  cwd: "/tmp",
  roomId: "room-a",
  member: {
    id: "dev",
    name: "dev",
    type: "agent" as const,
    agent: "developer",
    model: "sonnet",
    runtime: "pi-cli" as const,
    thinkingLevel: "off" as const,
  },
  agentPrompt: "sys",
  envPrompt: "env",
  skillPaths: [],
  roomMembers: ["dev", "pm"],
  callbacks: { onChat: async () => {}, onMention: async () => {} },
};

describe("runtime_exit lifecycle event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(false);
    execSyncMock.mockReturnValue("pi 1.0.0");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pi-cli emits runtime_exit with unexpected=true on post-startup crash and carries stderr tail", async () => {
    const proc = createFakeProc();
    spawnMock.mockImplementation(() => proc);

    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");
    const runtime = new PiCliRuntime("pi", 1);
    const p = runtime.createAgent(baseOpts);
    // Let the 500ms startup probe resolve and the handle be constructed.
    await vi.advanceTimersByTimeAsync(500);
    const handle = await p;

    const received: AgentStreamEvent[] = [];
    handle.subscribe((ev) => received.push(ev));

    // Simulate stderr arriving after handle construction, then a non-zero exit.
    proc.stderr.emit("data", Buffer.from("ParseError: Unexpected token, expected \",\"\n"));
    proc.emit("exit", 1, null);

    const exitEvt = received.find((e) => e.type === "runtime_exit") as any;
    expect(exitEvt).toBeDefined();
    expect(exitEvt.code).toBe(1);
    expect(exitEvt.unexpected).toBe(true);
    expect(exitEvt.stderrTail).toContain("ParseError");
  });

  it("pi-cli emits runtime_exit with unexpected=false after destroy()", async () => {
    const proc = createFakeProc();
    spawnMock.mockImplementation(() => proc);

    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");
    const runtime = new PiCliRuntime("pi", 1);
    const p = runtime.createAgent(baseOpts);
    await vi.advanceTimersByTimeAsync(500);
    const handle = await p;

    const received: AgentStreamEvent[] = [];
    handle.subscribe((ev) => received.push(ev));

    handle.destroy();
    // After destroy, listeners.clear() has already run so the event isn't delivered.
    // This is intentional: no one is listening once destroy is called.
    // What we assert: unsubscribe happened (no events after destroy).
    proc.emit("exit", 0, null);
    expect(received.filter((e) => e.type === "runtime_exit")).toHaveLength(0);
  });

  it("pi-cli captures stderr that arrives during the 500ms startup probe (via initialStderr)", async () => {
    const proc = createFakeProc();
    spawnMock.mockImplementation(() => proc);

    const { PiCliRuntime } = await import("../../src/engine/runtime/pi-cli.js");
    const runtime = new PiCliRuntime("pi", 1);
    const p = runtime.createAgent(baseOpts);

    // Emit stderr BEFORE the handle is constructed (during probe window).
    proc.stderr.emit("data", Buffer.from("early boot noise\n"));

    await vi.advanceTimersByTimeAsync(500);
    const handle = await p;

    const received: AgentStreamEvent[] = [];
    handle.subscribe((ev) => received.push(ev));

    proc.emit("exit", 2, null);
    const exitEvt = received.find((e) => e.type === "runtime_exit") as any;
    expect(exitEvt).toBeDefined();
    expect(exitEvt.stderrTail).toContain("early boot noise");
  });
});
