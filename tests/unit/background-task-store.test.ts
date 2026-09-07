/**
 * Background task store (step 1): lifecycle records, task.json persistence,
 * UTC date folders, transition rules, wait registry, restart sweep.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let store: typeof import("../../src/engine/background-task-store.js");
let registry: typeof import("../../src/workspace/member-registry.js");

function seed() {
  dir = mkdtempSync(join(tmpdir(), "bm-bgstore-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  vi.resetModules();
}

beforeEach(async () => {
  seed();
  store = await import("../../src/engine/background-task-store.js");
  registry = await import("../../src/workspace/member-registry.js");
  memberRegistered = false;
  memberId = "";
});

afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const SNAPSHOT = { model: "test/model", credentialId: "cred-1", thinkingLevel: "medium" };

let memberRegistered = false;
let memberId = "";
function mkTask(overrides: Partial<Parameters<typeof store.createBackgroundTask>[0]> = {}) {
  if (!memberRegistered) {
    const created = registry.createMember({ name: "bgtester" } as any);
    memberId = created.id;
    memberRegistered = true;
  }
  return store.createBackgroundTask({
    memberId: memberId,
    scopeId: "room:bgroom",
    kind: "recall",
    sessionMode: "fork",
    prompt: "collect memory",
    snapshot: SNAPSHOT,
    ...overrides,
  });
}

describe("background task store", () => {
  it("creates a task in a UTC date folder with the starting record on disk", () => {
    const record = mkTask();
    expect(record.status).toBe("starting");
    expect(record.result).toBeNull();
    expect(record.error).toBeNull();
    // layout: members/<id>/background-tasks/<YYYY-MM-DD>/<taskId>/task.json
    const folder = record.startedAt.slice(0, 10);
    const expected = join(dir, "members", memberId, "background-tasks", folder, record.taskId, "task.json");
    expect(existsSync(expected)).toBe(true);
    const onDisk = JSON.parse(readFileSync(expected, "utf-8"));
    expect(onDisk.taskId).toBe(record.taskId);
    expect(onDisk.snapshot).toEqual(SNAPSHOT);
  });

  it("round-trips via getBackgroundTask and lists across date folders", () => {
    const a = mkTask();
    const loaded = store.getBackgroundTask(memberId, a.taskId);
    expect(loaded?.prompt).toBe("collect memory");
    expect(loaded?.sessionMode).toBe("fork");
    // same-member second task in same folder
    const b = mkTask({ kind: "memorize", sessionMode: "new" });
    const list = store.listBackgroundTasks(memberId);
    expect(list.map((t) => t.taskId).sort()).toEqual([a.taskId, b.taskId].sort());
    expect(store.getBackgroundTask("mem_other", a.taskId)).toBeNull();
  });

  it("runs the legal lifecycle starting→running→cancelling→cancelled and stamps endedAt", () => {
    const a = mkTask();
    store.updateBackgroundTask(memberId, a.taskId, { status: "running" });
    store.updateBackgroundTask(memberId, a.taskId, { status: "cancelling" });
    const done = store.updateBackgroundTask(memberId, a.taskId, { status: "cancelled", error: "cancelled by member" });
    expect(done.status).toBe("cancelled");
    expect(done.error).toBe("cancelled by member");
    expect(done.endedAt).toBeTruthy();
    expect(store.getBackgroundTask(memberId, a.taskId)?.status).toBe("cancelled");
  });

  it("allows cancelling→done when work finished before the cancel took effect, keeping the result", () => {
    const a = mkTask();
    store.updateBackgroundTask(memberId, a.taskId, { status: "running" });
    store.updateBackgroundTask(memberId, a.taskId, { status: "cancelling" });
    const done = store.updateBackgroundTask(memberId, a.taskId, { status: "done", result: "final text" });
    expect(done.status).toBe("done");
    expect(done.result).toBe("final text");
  });

  it("rejects illegal transitions, terminal writes, result without done, error without terminal", () => {
    const a = mkTask();
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { status: "done" })).toThrow(/illegal/);
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { result: "x" })).toThrow(/done/);
    store.updateBackgroundTask(memberId, a.taskId, { status: "running" });
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { error: "boom" })).toThrow(/terminal/);
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { status: "cancelled", error: "by request" })).toThrow(/illegal/);
    store.updateBackgroundTask(memberId, a.taskId, { status: "failed", error: "boom" });
    // terminal is immutable
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { status: "done", result: "late" })).toThrow(/terminal/);
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { error: "again" })).toThrow(/terminal/);
    // unknown task
    expect(() => store.updateBackgroundTask(memberId, "bgt-nope", { status: "running" })).toThrow(/not found/);
  });

  it("whenTerminal resolves immediately for terminal tasks and concurrently for live ones", async () => {
    const a = mkTask();
    store.updateBackgroundTask(memberId, a.taskId, { status: "running" });
    const p1 = store.whenTerminal(memberId, a.taskId);
    const p2 = store.whenTerminal(memberId, a.taskId); // concurrent waiter
    let settled = 0;
    void p1.then(() => { settled += 1; });
    void p2.then(() => { settled += 1; });
    await Promise.resolve();
    expect(settled).toBe(0); // still pending while running
    store.updateBackgroundTask(memberId, a.taskId, { status: "done", result: "answer" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.result).toBe("answer");
    expect(r2.result).toBe("answer");
    // repeatable read: waiting again on a terminal task returns the stored record
    const again = await store.whenTerminal(memberId, a.taskId);
    expect(again.status).toBe("done");
  });

  it("restart sweep marks non-terminal tasks interrupted and keeps terminal records untouched", () => {
    const live = mkTask();
    store.updateBackgroundTask(memberId, live.taskId, { status: "running" });
    const cancelling = mkTask({ kind: "generic", sessionMode: "new" });
    store.updateBackgroundTask(memberId, cancelling.taskId, { status: "running" });
    store.updateBackgroundTask(memberId, cancelling.taskId, { status: "cancelling" });
    const finished = mkTask();
    store.updateBackgroundTask(memberId, finished.taskId, { status: "running" });
    store.updateBackgroundTask(memberId, finished.taskId, { status: "done", result: "kept" });

    const marked = store.sweepInterruptedBackgroundTasks();
    expect(marked).toBe(2);
    expect(store.getBackgroundTask(memberId, live.taskId)?.status).toBe("interrupted");
    expect(store.getBackgroundTask(memberId, live.taskId)?.error).toContain("restart");
    expect(store.getBackgroundTask(memberId, cancelling.taskId)?.status).toBe("interrupted");
    expect(store.getBackgroundTask(memberId, finished.taskId)?.status).toBe("done");
    expect(store.getBackgroundTask(memberId, finished.taskId)?.result).toBe("kept");
    // sweep is idempotent
    expect(store.sweepInterruptedBackgroundTasks()).toBe(0);
  });

  it("sweep with no members directory is a no-op", () => {
    rmSync(join(dir, "members"), { recursive: true, force: true });
    expect(store.sweepInterruptedBackgroundTasks()).toBe(0);
  });

  it("skips unreadable task.json without crashing listing or sweep", () => {
    const a = mkTask();
    const p = join(a.sessionDir, "task.json");
    writeFileSync(p, "{ not json", "utf-8");
    expect(store.listBackgroundTasks(memberId)).toEqual([]);
    expect(store.sweepInterruptedBackgroundTasks()).toBe(0);
    expect(store.getBackgroundTask(memberId, a.taskId)).toBeNull();
  });
});
