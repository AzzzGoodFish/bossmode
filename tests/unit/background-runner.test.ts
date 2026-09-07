/**
 * Background task runner + six-tool dispatch: mocked-runtime child sessions on
 * a REAL parent instance (buildMemberAgentSession + live sessionSources) and a
 * REAL SDK parent session file for fork. Verifies the 11:52 review contract:
 * fork keeps the latest user requirement and cuts before the in-flight start
 * tool call; fork failure is a real failure (no degrade-to-new); final only
 * counts stopReason "stop" without errorMessage; cancel independence and
 * idempotency; wait interrupt settles; wait timeout returns the real status;
 * ownership + scope authorization.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";

let dir: string;
let runner: typeof import("../../src/engine/background-task-runner.js");
let store: typeof import("../../src/engine/background-task-store.js");
let agentManager: typeof import("../../src/engine/agent-manager.js");
let registryMod: typeof import("../../src/workspace/member-registry.js");
let roomStore: typeof import("../../src/workspace/room-store.js");
let tools: typeof import("../../src/engine/tools.js");
let memberId = "";
let roomId = "";
let scopeId = "";
let promptDeferred: (() => void) | null = null;
let parentManager: SessionManager;

const FAKE_PROMPT = vi.fn(async () => {
  await new Promise<void>((resolve) => { promptDeferred = resolve; });
});
let handleEmit: ((event: any) => void) | null = null;
let lastCreateOpts: any = null;
const fakeHandle = {
  prompt: FAKE_PROMPT,
  abort: vi.fn(),
  destroy: vi.fn(),
  destroyAndWait: vi.fn(async () => {}),
  subscribe: vi.fn((fn: (event: any) => void) => { handleEmit = fn; return () => { handleEmit = null; }; }),
  sessionId: "child-sdk-session-id",
  runtimeParams: { thinkingLevel: "off", model: "anthropic/model-x", credentialId: "cred-a" },
  forkSnapshot: () => {
    try {
      return { sessionFile: parentManager.getSessionFile(), branchEntries: (parentManager as any).getBranch() };
    } catch {
      return null;
    }
  },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bm-bgrun-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  vi.resetModules();
  promptDeferred = null;
  lastCreateOpts = null;
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

  const member = registryMod.createMember({
    name: "bgrunner",
    agentTemplate: "general",
    runtime: "pi-cli",
    model: "anthropic/model-x",
    credentialId: "cred-a",
    thinkingLevel: "off",
  } as any);
  memberId = member.id;
  const room = roomStore.createRoom("bg room", undefined, [{ agent: "general", name: "bgrunner" }]);
  roomStore.stampGlobalMemberIds(room.id, [member.id], member.id);
  roomId = room.id;
  scopeId = `room:${roomId}`;

  // real parent session file for fork: user requirement + in-flight assistant toolCall
  const parentSessionsDir = join(dir, "parent-sessions");
  mkdirSync(parentSessionsDir, { recursive: true });
  parentManager = SessionManager.create(dir, parentSessionsDir);
  (parentManager as any).appendMessage({ role: "user", content: [{ type: "text", text: "please recall the deployment decision" }] });
  (parentManager as any).appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "recall", arguments: {} }],
  });

  agentManager.initAgentManager({
    get: (name: string) => (name === "pi-cli" ? {
      name: "pi-cli",
      capabilities: {},
      detect: async () => ({ available: true }),
      createAgent: async (opts: any) => {
        lastCreateOpts = opts;
        if (opts.background) {
          expect(opts.background.sessionDir).toBeTruthy();
          expect(opts.background.inheritCodexSessionIdFrom).toBeUndefined();
          // the child binds tools with the SAME id format the live parent used
          // (bare room id for rooms) — scope-keyed callbacks must not see a
          // normalized "room:<id>" the parent never used
          expect(opts.roomId).toBe(roomId);
        }
        return fakeHandle as any;
      },
      shutdownAll: async () => {},
    } : undefined),
  } as any);

  // real parent instance through the real assembly path (sessionSources)
  const instance = await agentManager.buildMemberAgentSession(memberId, scopeId);
  expect(instance).toBeTruthy();
});

afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function runToCompletion() {
  for (let i = 0; i < 200 && !(handleEmit && promptDeferred); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  handleEmit?.({ type: "message_end", text: "THE ANSWER", stopReason: "stop" });
  promptDeferred?.();
  await new Promise((r) => setTimeout(r, 5));
}

describe("forkCutLeafId", () => {
  const u = (id: string) => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text: "req " + id }] } });
  const a = (id: string) => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text: "work " + id }] } });
  const aTool = (id: string, name: string) => ({ id, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t" + id, name, arguments: {} }] } });

  it("cuts before the in-flight start tool call, keeping the latest user requirement", () => {
    const entries = [u("1"), a("2"), u("3"), aTool("4", "recall")];
    expect(runner.forkCutLeafId(entries as any)).toBe("3");
  });

  it("keeps completed tool turns from earlier in the conversation", () => {
    const entries = [u("1"), aTool("2", "read"), u("3"), aTool("4", "background_start")];
    expect(runner.forkCutLeafId(entries as any)).toBe("3");
  });

  it("falls to the leaf when no start tool call is on the branch", () => {
    const entries = [u("1"), a("2")];
    expect(runner.forkCutLeafId(entries as any)).toBe("2");
  });

  it("returns null for an empty prefix (start call is the first entry)", () => {
    const entries = [aTool("1", "memorize")];
    expect(runner.forkCutLeafId(entries as any)).toBeNull();
  });

  it("with no start tool call on the branch the whole branch is the prefix", () => {
    const entries = [u("1"), aTool("2", "read"), aTool("3", "shell_exec")];
    expect(runner.forkCutLeafId(entries as any)).toBe("3");
  });
});

describe("background runner + tool dispatch", () => {
  it("start requires a live parent instance in that scope", () => {
    const result = runner.startBackgroundTask({ memberId, scopeId: "room:nonexistent", kind: "generic", sessionMode: "new", prompt: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no live session");
  });

  it("start returns real starting status; run settles done with the final text after cleanup", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "do a thing" });
    if (!started.ok) { expect(started.error).toBeTruthy(); }
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(["starting", "running"]).toContain(started.status);
    await runToCompletion();
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("done");
    expect(record?.result).toBe("THE ANSWER");
    expect(fakeHandle.destroyAndWait).toHaveBeenCalled();
    expect(record?.scopeId).toBe(`room:${roomId}`); // full scope id for ownership/display
  });

  it("fork mode: child resumes a forked file in the task dir, cut before the in-flight call (latest user kept)", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "recall", sessionMode: "fork" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await runToCompletion();
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("done");
    expect(record?.parentSessionRef).toBe(parentManager.getSessionFile());
    // the child ran on the forked manager writing into its own task dir
    const manager = lastCreateOpts?.background?.sessionManager;
    expect(manager).toBeTruthy();
    const resumed = manager.getSessionFile();
    expect(resumed.startsWith(record!.sessionDir)).toBe(true);
    expect(existsSync(resumed)).toBe(true);
    // the fork kept the latest user requirement and cut the in-flight tool call
    const branch = (manager as any).getBranch() as any[];
    const roles = branch.filter((e: any) => e?.type === "message").map((e: any) => e.message?.role);
    expect(roles).toContain("user");
    expect(roles.filter((r: any) => r === "assistant")).toHaveLength(0);
    const forkText = JSON.stringify(branch);
    expect(forkText).toContain("please recall the deployment decision");
  });

  it("fork failure is a real failure — no degrade-to-new", async () => {
    // sabotage the fork source: snapshot points at a non-session file
    const garbage = join(dir, "garbage-parent.jsonl");
    writeFileSync(garbage, "this is not a session file\n", "utf-8");
    const originalForkSnapshot = fakeHandle.forkSnapshot;
    (fakeHandle as any).forkSnapshot = () => ({ sessionFile: garbage, branchEntries: [] });
    lastCreateOpts = null; // only child calls (opts.background) count from here
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "recall", sessionMode: "fork" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    for (let i = 0; i < 40 && store.getBackgroundTask(memberId, started.taskId)?.status === "starting"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("failed");
    expect(record?.error).toContain("fork");
    // no child session was started
    expect(lastCreateOpts).toBeNull();
    (fakeHandle as any).forkSnapshot = originalForkSnapshot;
  });

  it("no successful final (error-ended turn) → failed, never stale text as success", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    for (let i = 0; i < 200 && !(handleEmit && promptDeferred); i++) await new Promise((r) => setTimeout(r, 5));
    handleEmit?.({ type: "message_end", text: "partial text", stopReason: "error", errorMessage: "provider exploded" });
    promptDeferred?.();
    for (let i = 0; i < 40 && store.getBackgroundTask(memberId, started.taskId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("failed");
    expect(record?.result).toBeNull();
  });

  it("intermediate tool-turn text does not become the result; only the final stop counts", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    for (let i = 0; i < 200 && !handleEmit; i++) await new Promise((r) => setTimeout(r, 5));
    handleEmit?.({ type: "message_end", text: "let me check the files", stopReason: "toolUse" });
    await runToCompletion();
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("done");
    expect(record?.result).toBe("THE ANSWER");
  });

  it("cancel is independent and idempotent; only background_cancel aborts", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "recall", sessionMode: "new" });
    if (!started.ok) return;
    for (let i = 0; i < 200 && !promptDeferred; i++) await new Promise((r) => setTimeout(r, 5));
    expect(fakeHandle.abort).not.toHaveBeenCalled();

    const cancel = runner.cancelBackgroundTask(memberId, started.taskId);
    expect(cancel.ok && cancel.status).toBe("cancelling");
    expect(fakeHandle.abort).toHaveBeenCalled();
    // idempotent: second cancel while cancelling does not throw
    const again = runner.cancelBackgroundTask(memberId, started.taskId);
    expect(again.ok && again.status).toBe("cancelling");

    promptDeferred?.();
    for (let i = 0; i < 40 && store.getBackgroundTask(memberId, started.taskId)?.status === "cancelling"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("cancelled");
    expect(record?.result).toBeNull();
    // cancel of a terminal task returns the terminal status, no answer
    const third = runner.cancelBackgroundTask(memberId, started.taskId);
    expect(third.ok && third.status).toBe("cancelled");
    expect(third.ok && (third as any).note).toContain("immutable");
  });

  it("cancel landing during child creation skips the prompt entirely", async () => {
    // gate createAgent so the cancel lands while the child is being built
    let releaseCreate: (() => void) | null = null;
    const gatedCreate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const registry = {
      get: (name: string) => (name === "pi-cli" ? {
        name: "pi-cli", capabilities: {}, detect: async () => ({ available: true }),
        createAgent: async (opts: any) => { lastCreateOpts = opts; await gatedCreate; return fakeHandle as any; },
        shutdownAll: async () => {},
      } : undefined),
    };
    (agentManager as any).initAgentManager(registry as any);

    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    runner.cancelBackgroundTask(memberId, started.taskId);
    releaseCreate?.();
    for (let i = 0; i < 40 && !["cancelled", "failed", "done"].includes(store.getBackgroundTask(memberId, started.taskId)?.status ?? ""); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("cancelled");
    expect(FAKE_PROMPT).not.toHaveBeenCalled(); // no model work started
    expect(fakeHandle.destroyAndWait).toHaveBeenCalled();
  });

  it("terminal is published only after the awaited cleanup completes", async () => {
    let releaseCleanup: (() => void) | null = null;
    const gate = new Promise<void>((r) => { releaseCleanup = r; });
    (fakeHandle.destroyAndWait as any).mockImplementationOnce(async () => { await gate; });
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    for (let i = 0; i < 200 && !promptDeferred; i++) await new Promise((r) => setTimeout(r, 5));
    handleEmit?.({ type: "message_end", text: "DONE TEXT", stopReason: "stop" });
    promptDeferred?.();
    await new Promise((r) => setTimeout(r, 30));
    // run settled but cleanup gated: not yet terminal
    expect(store.getBackgroundTask(memberId, started.taskId)?.status).toBe("running");
    releaseCleanup?.();
    for (let i = 0; i < 40 && store.getBackgroundTask(memberId, started.taskId)?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("done");
    expect(record?.result).toBe("DONE TEXT");
  });

  it("a confirmed cleanup failure fails the task — no success claim, applied changes noted", async () => {
    (fakeHandle.destroyAndWait as any).mockImplementationOnce(async () => { throw new Error("teardown incomplete (1): dispose: ws pool refused to close"); });
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    await runToCompletion();
    const record = store.getBackgroundTask(memberId, started.taskId);
    expect(record?.status).toBe("failed");
    expect(record?.result).toBeNull();
    expect(record?.error).toContain("ws pool refused to close");
    expect(record?.error).toContain("may already be in effect");
  });

  it("background_wait: timeout returns the real non-terminal status without the answer; repeat read after done", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "slow" });
    if (!started.ok) return;
    for (let i = 0; i < 200 && !promptDeferred; i++) await new Promise((r) => setTimeout(r, 5));

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

  it("background_wait ends on member interrupt with the real status; the task keeps running", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "x" });
    if (!started.ok) return;
    for (let i = 0; i < 200 && !promptDeferred; i++) await new Promise((r) => setTimeout(r, 5));
    const waitP = tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.taskId, blockMs: 0 }) as any;
    await new Promise((r) => setTimeout(r, 10));
    store.settleBackgroundWaits(memberId); // interrupt path
    const view = await waitP;
    expect(view.ok).toBe(true);
    expect(view.status).toBe("running");
    expect(view.result).toBeUndefined();
    expect(view.note).toContain("interrupt");
    // task still alive: let it finish and read the result afterwards
    await runToCompletion();
    const doneView = await tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.taskId }) as any;
    expect(doneView.status).toBe("done");
  });

  it("background_status lists lifecycle facts only, scoped to the caller's scope", async () => {
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "recall", sessionMode: "fork" });
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

  it("ownership and scope authorization: another member's task id reads as not found", async () => {
    const other = registryMod.createMember({ name: "stranger", agentTemplate: "general", runtime: "pi-cli", model: "anthropic/model-x", credentialId: "cred-a" } as any);
    const started = runner.startBackgroundTask({ memberId, scopeId, kind: "generic", sessionMode: "new", prompt: "mine" });
    await runToCompletion();
    const waitView = await tools.handleToolCallback("background_wait", roomId, "bgrunner", { taskId: started.ok ? started.taskId : "" }) as any;
    expect(waitView.ok).toBe(true); // owner succeeds
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
});
