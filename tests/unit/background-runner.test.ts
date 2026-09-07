/**
 * Background task runner + six-tool dispatch: mocked runtime child sessions.
 * Verifies: start→run→final-text→done; cancel independence (abort only via
 * background_cancel); wait timeout returns the real current status without the
 * answer; wait repeat-read; status never leaks results; ownership checks.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
let runner: typeof import("../../src/engine/background-task-runner.js");
let store: typeof import("../../src/engine/background-task-store.js");
let agentManager: typeof import("../../src/engine/agent-manager.js");
let registryMod: typeof import("../../src/workspace/member-registry.js");
let roomStore: typeof import("../../src/workspace/room-store.js");
let tools: typeof import("../../src/engine/tools.js");
let memberId = "";
let roomId = "";
let promptDeferred: (() => void) | null = null;

const FAKE_PROMPT = vi.fn(async () => {
  await new Promise<void>((resolve) => { promptDeferred = resolve; });
});
let handleEmit: ((event: any) => void) | null = null;
const fakeHandle = {
  prompt: FAKE_PROMPT,
  abort: vi.fn(),
  destroy: vi.fn(),
  subscribe: vi.fn((fn: (event: any) => void) => { handleEmit = fn; return () => { handleEmit = null; }; }),
  sessionId: "child-sdk-session-id",
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bm-bgrun-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  vi.resetModules();
  promptDeferred = null;
  FAKE_PROMPT.mockClear();
  (fakeHandle.abort as any).mockClear();
  (fakeHandle.destroy as any).mockClear();
  fakeHandle.subscribe.mockClear();
  handleEmit = null;

  store = await import("../../src/engine/background-task-store.js");
  agentManager = await import("../../src/engine/agent-manager.js");
  registryMod = await import("../../src/workspace/member-registry.js");
  roomStore = await import("../../src/workspace/room-store.js");
  runner = await import("../../src/engine/background-task-runner.js");
  tools = await import("../../src/engine/tools.js");

  // agent definition pool
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "general.md"), "---\nname: general\ndescription: general\nsystemPrompt: you are general\n---\ngeneral\n", "utf-8");

  // member + room with model binding
  const member = registryMod.createMember({
    name: "bgrunner",
    agent: "general",
    runtime: "pi-cli",
    model: "anthropic/model-x",
    credentialId: "cred-a",
    thinkingLevel: "off",
  } as any);
  memberId = member.id;
  const room = roomStore.createRoom("bg room", undefined, [{ agent: "general", name: "bgrunner" }]);
  roomStore.stampGlobalMemberIds(room.id, [member.id], member.id);
  roomId = room.id;

  // runtime registry stub: createAgent returns the fake handle
  agentManager.initAgentManager({
    get: (name: string) => (name === "pi-cli" ? {
      name: "pi-cli",
      capabilities: {},
      detect: async () => ({ available: true }),
      createAgent: async (opts: any) => {
        // same assertions the real path would honor
        expect(opts.background?.sessionDir).toBeTruthy();
        expect(opts.background?.inheritCodexSessionIdFrom).toBeUndefined();
        return fakeHandle as any;
      },
      shutdownAll: async () => {},
    } : undefined),
  } as any);
});

afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function runToCompletion() {
  // wait until the executor has subscribed and prompt is in flight, then settle
  for (let i = 0; i < 100 && !(handleEmit && promptDeferred); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  handleEmit?.({ type: "message_end", text: "THE ANSWER" });
  promptDeferred?.();
  await new Promise((r) => setTimeout(r, 5));
}

describe("background runner + tool dispatch", () => {
  it("start returns real starting status; run settles done with the final text after cleanup", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "generic", sessionMode: "new", prompt: "do a thing" });
    if (!started.ok) { expect(started.error).toBeTruthy(); }
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(["starting", "running"]).toContain(started.status);
    await new Promise((r) => setTimeout(r, 5));
    await runToCompletion();
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("done");
    expect(record?.result).toBe("THE ANSWER");
    expect(fakeHandle.destroy).toHaveBeenCalled();
  });

  it("no final text → failed with explicit reason, never success", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 5));
    promptDeferred?.(); // settle without message_end
    await new Promise((r) => setTimeout(r, 5));
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("without final text");
  });

  it("cancel is independent: only background_cancel aborts; tool returns cancelling then cancelled", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "recall", sessionMode: "fork" });
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 5));
    expect(fakeHandle.abort).not.toHaveBeenCalled();

    const cancel = runner.cancelBackgroundTask(memberId, started.taskId);
    expect(cancel.ok && cancel.status).toBe("cancelling");
    expect(fakeHandle.abort).toHaveBeenCalled();

    promptDeferred?.(); // aborted prompt settles
    await new Promise((r) => setTimeout(r, 5));
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("cancelled");
    expect(record?.result).toBeNull();
    // cancel of a terminal task returns the terminal status, no answer
    const again = runner.cancelBackgroundTask(memberId, started.taskId);
    expect(again.ok && again.status).toBe("cancelled");
    expect(again.ok && (again as any).note).toContain("immutable");
  });

  it("cancel during starting (before executor marks running) still terminates as cancelled", async () => {
    // block the executor inside createAgent
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "memorize", sessionMode: "fork" });
    if (!started.ok) return;
    const cancel = runner.cancelBackgroundTask(memberId, started.taskId);
    expect(cancel.ok && cancel.status).toBe("cancelling");
    await new Promise((r) => setTimeout(r, 5));
    await runToCompletion();
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("cancelled");
  });

  it("background_wait: timeout returns the real non-terminal status without the answer; repeat read after done", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "generic", sessionMode: "new", prompt: "slow" });
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 5));

    const timeoutView = await tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.taskId, blockMs: 30 }) as any;
    expect(timeoutView.ok).toBe(true);
    expect(timeoutView.status).toBe("running");
    expect(timeoutView.result).toBeUndefined();
    expect(timeoutView.note).toContain("background_wait");

    await runToCompletion();

    const doneView = await tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.taskId }) as any;
    expect(doneView.status).toBe("done");
    expect(doneView.result).toBe("THE ANSWER");
    const again = await tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.taskId }) as any;
    expect(again.result).toBe("THE ANSWER"); // repeatable read
  });

  it("background_status lists lifecycle facts only, scoped to the caller's scope", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "recall", sessionMode: "fork" });
    await runToCompletion();
    const status = await tools.handleToolCallback("background_status", roomId, "bgrunner", {}) as any;
    expect(status.ok).toBe(true);
    expect(status.tasks).toHaveLength(1);
    const entry = status.tasks[0];
    expect(entry.taskId).toBe(started.ok && started.taskId);
    expect(entry.status).toBe("done");
    expect("result" in entry).toBe(false);
    expect("error" in entry).toBe(false);
  });

  it("ownership: another member's task id reads as not found", async () => {
    const other = registryMod.createMember({ name: "stranger", agent: "general", runtime: "pi-cli", model: "anthropic/model-x", credentialId: "cred-a" } as any);
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "generic", sessionMode: "new", prompt: "mine" });
    await runToCompletion();
    const waitView = await tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.ok ? started.taskId : "" }) as any;
    expect(waitView.ok).toBe(true); // owner succeeds
    // stranger same room cannot wait on it
    const denied = await tools.handleToolCallback("background_wait", roomId, "stranger", { taskId: started.ok ? started.taskId : "" }) as any;
    expect(denied.ok).toBe(false);
    void other;
  });

  it("background_start via dispatcher validates sessionMode and prompt", async () => {
    const bad = await tools.handleToolCallback("background_start", roomId, "bgrunner", { prompt: "x", sessionMode: "sometimes" }) as any;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("sessionMode");
    const empty = await tools.handleToolCallback("background_start", roomId, "bgrunner", { prompt: "  ", sessionMode: "new" }) as any;
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("prompt");
  });

  it("wait with blockMs 0 waits until terminal (no timeout path)", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId: `room:${roomId}`, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    await new Promise((r) => setTimeout(r, 5));
    const waitP = tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.taskId, blockMs: 0 });
    await new Promise((r) => setTimeout(r, 10));
    await runToCompletion();
    const view = await waitP as any;
    expect(view.status).toBe("done");
    expect(view.result).toBe("THE ANSWER");
  });
});
