/**
 * Background task store: lifecycle records, atomic task.json persistence,
 * UTC date folders, strict validation, disposable waiters, restart sweep.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let store: typeof import("../../src/engine/background-task-store.js");
let registry: typeof import("../../src/workspace/member-registry.js");
let loggerMod: typeof import("../../src/foundation/logger.js");

function seed() {
  dir = mkdtempSync(join(tmpdir(), "bm-bgstore-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  vi.resetModules();
}

let errorSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(async () => {
  seed();
  store = await import("../../src/engine/background-task-store.js");
  registry = await import("../../src/workspace/member-registry.js");
  loggerMod = await import("../../src/foundation/logger.js");
  errorSpy = vi.spyOn(loggerMod.logger, "error");
});

afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

let memberRegistered = false;
let memberId = "";
function mkTask(overrides: Partial<Parameters<typeof store.createBackgroundTask>[0]> = {}) {
  if (!memberRegistered) {
    const created = registry.createMember({ name: "bgtester" } as any);
    memberId = created.id;
    memberRegistered = true;
  }
  return store.createBackgroundTask({
    memberId,
    scopeId: "room:bgroom",
    kind: "recall",
    sessionMode: "fork",
    prompt: "collect memory",
    snapshot: { model: "test/model", credentialId: "cred-1", thinkingLevel: "medium" },
    ...overrides,
  });
}

function diagLogged(): boolean {
  return (errorSpy?.mock.calls.length ?? 0) > 0;
}

describe("background task store", () => {
  it("creates a task in a UTC date folder with the starting record on disk (full-UUID id, no tmp leftover)", () => {
    const record = mkTask();
    expect(record.status).toBe("starting");
    expect(record.result).toBeNull();
    expect(record.taskId).toMatch(/^bgt-[0-9a-f-]{36}$/);
    const folder = record.startedAt.slice(0, 10);
    const expected = join(dir, "members", memberId, "background-tasks", folder, record.taskId, "task.json");
    expect(existsSync(expected)).toBe(true);
    expect(existsSync(`${expected}.tmp`)).toBe(false); // atomic write left no temp behind
    const onDisk = JSON.parse(readFileSync(expected, "utf-8"));
    expect(onDisk.taskId).toBe(record.taskId);
    expect(onDisk.snapshot).toEqual({ model: "test/model", credentialId: "cred-1", thinkingLevel: "medium" });
  });

  it("round-trips via getBackgroundTask and lists across date folders", () => {
    const a = mkTask();
    const loaded = store.getBackgroundTask(memberId, a.taskId);
    expect(loaded?.prompt).toBe("collect memory");
    expect(loaded?.sessionMode).toBe("fork");
    const b = mkTask({ kind: "memorize", sessionMode: "new" });
    const list = store.listBackgroundTasks(memberId);
    expect(list.map((t) => t.taskId).sort()).toEqual([a.taskId, b.taskId].sort());
    expect(store.getBackgroundTask("mem_other", a.taskId)).toBeNull();
  });

  it("rejects malformed task ids before any path use", () => {
    const a = mkTask();
    expect(store.getBackgroundTask(memberId, "../other-member")).toBeNull();
    expect(store.getBackgroundTask(memberId, `${a.taskId}x`)).toBeNull();
    expect(() => store.updateBackgroundTask(memberId, "../../etc", { status: "running" })).toThrow(/not found/);
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

  it("allows cancelling a starting task (cancel during initialization)", () => {
    const a = mkTask();
    const cancelled = store.updateBackgroundTask(memberId, a.taskId, { status: "cancelling", error: undefined });
    expect(cancelled.status).toBe("cancelling");
    const final = store.updateBackgroundTask(memberId, a.taskId, { status: "cancelled", error: "cancelled before start" });
    expect(final.status).toBe("cancelled");
    expect(final.error).toBe("cancelled before start");
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
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { status: "done", result: "late" })).toThrow(/terminal/);
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { error: "again" })).toThrow(/terminal/);
    expect(() => store.updateBackgroundTask(memberId, "bgt-nope", { status: "running" })).toThrow(/not found/);
  });

  it("whenTerminal: immediate for terminal, concurrent for live, repeatable, disposable per waiter", async () => {
    const a = mkTask();
    store.updateBackgroundTask(memberId, a.taskId, { status: "running" });
    const w1 = store.whenTerminal(memberId, a.taskId);
    const w2 = store.whenTerminal(memberId, a.taskId); // concurrent waiter
    let settled = 0;
    void w1.promise.then(() => { settled += 1; });
    void w2.promise.then(() => { settled += 1; });
    await Promise.resolve();
    expect(settled).toBe(0); // still pending while running

    // a timed-out waiter disposes itself without touching the other waiter
    const w3 = store.whenTerminal(memberId, a.taskId);
    let settled3 = false;
    void w3.promise.then(() => { settled3 = true; });
    w3.dispose();
    expect(settled3).toBe(false);

    store.updateBackgroundTask(memberId, a.taskId, { status: "done", result: "answer" });
    const [r1, r2] = await Promise.all([w1.promise, w2.promise]);
    expect(r1.result).toBe("answer");
    expect(r2.result).toBe("answer");
    await new Promise((r) => setTimeout(r, 0));
    expect(settled3).toBe(false); // disposed waiter never resolved
    // repeatable read
    const again = await store.whenTerminal(memberId, a.taskId).promise;
    expect(again.status).toBe("done");
  });

  it("whenTerminal for a missing task rejects instead of registering a forever-pending promise", async () => {
    const w = store.whenTerminal(memberId, "bgt-00000000-0000-4000-8000-000000000000");
    await expect(w.promise).rejects.toThrow(/not found/);
  });

  it("restart sweep marks non-terminal tasks interrupted and keeps terminal records untouched", () => {
    const live = mkTask();
    store.updateBackgroundTask(memberId, live.taskId, { status: "running" });
    const cancelling = mkTask({ kind: "generic", sessionMode: "new" });
    store.updateBackgroundTask(memberId, cancelling.taskId, { status: "running" });
    store.updateBackgroundTask(memberId, cancelling.taskId, { status: "cancelling" });
    const starting = mkTask();
    const finished = mkTask();
    store.updateBackgroundTask(memberId, finished.taskId, { status: "running" });
    store.updateBackgroundTask(memberId, finished.taskId, { status: "done", result: "kept" });

    const marked = store.sweepInterruptedBackgroundTasks();
    expect(marked).toBe(3); // running + cancelling + starting
    expect(store.getBackgroundTask(memberId, live.taskId)?.status).toBe("interrupted");
    expect(store.getBackgroundTask(memberId, live.taskId)?.error).toContain("restart");
    expect(store.getBackgroundTask(memberId, starting.taskId)?.status).toBe("interrupted");
    expect(store.getBackgroundTask(memberId, finished.taskId)?.status).toBe("done");
    expect(store.getBackgroundTask(memberId, finished.taskId)?.result).toBe("kept");
    expect(store.sweepInterruptedBackgroundTasks()).toBe(0);
  });

  it("sweep with no members directory is a no-op", () => {
    rmSync(join(dir, "members"), { recursive: true, force: true });
    expect(store.sweepInterruptedBackgroundTasks()).toBe(0);
  });

  it("treats corrupt records as absent with a diagnostic (no guessed defaults)", () => {
    const a = mkTask();
    const p = join(a.sessionDir, "task.json");
    writeFileSync(p, "{ not json", "utf-8");
    expect(store.listBackgroundTasks(memberId)).toEqual([]);
    expect(store.getBackgroundTask(memberId, a.taskId)).toBeNull();
    expect(store.sweepInterruptedBackgroundTasks()).toBe(0);
    expect(diagLogged()).toBe(true);
  });

  it("rejects records with unknown enum values or member mismatch instead of normalizing them", () => {
    const a = mkTask();
    const p = join(a.sessionDir, "task.json");
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    // unknown kind
    writeFileSync(p, JSON.stringify({ ...raw, kind: "mystery" }), "utf-8");
    expect(store.getBackgroundTask(memberId, a.taskId)).toBeNull();
    // unknown status
    writeFileSync(p, JSON.stringify({ ...raw, status: "paused" }), "utf-8");
    expect(store.getBackgroundTask(memberId, a.taskId)).toBeNull();
    // wrong member ownership
    writeFileSync(p, JSON.stringify({ ...raw, memberId: "mem_other" }), "utf-8");
    expect(store.getBackgroundTask(memberId, a.taskId)).toBeNull();
    // forged sessionDir in contents must not leak into the loaded record
    writeFileSync(p, JSON.stringify({ ...raw, sessionDir: "/tmp/elsewhere" }), "utf-8");
    const loaded = store.getBackgroundTask(memberId, a.taskId);
    expect(loaded?.sessionDir).toBe(a.sessionDir);
    expect(diagLogged()).toBe(true);
  });

  it("terminal records missing their terminal evidence fail validation", () => {
    const a = mkTask();
    store.updateBackgroundTask(memberId, a.taskId, { status: "running" });
    store.updateBackgroundTask(memberId, a.taskId, { status: "failed", error: "boom" });
    const p = join(a.sessionDir, "task.json");
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    writeFileSync(p, JSON.stringify({ ...raw, error: null }), "utf-8"); // failed without error
    expect(store.getBackgroundTask(memberId, a.taskId)).toBeNull();
  });

  it("a leftover .tmp file never shadows the last valid record", () => {
    const a = mkTask();
    store.updateBackgroundTask(memberId, a.taskId, { status: "running" });
    // simulated crash mid-write: garbage in the temp file, rename never happened
    writeFileSync(join(a.sessionDir, "task.json.tmp"), "{ partial", "utf-8");
    const loaded = store.getBackgroundTask(memberId, a.taskId);
    expect(loaded?.status).toBe("running");
    // next successful write replaces both record and temp cleanly
    store.updateBackgroundTask(memberId, a.taskId, { status: "done", result: "ok" });
    expect(store.getBackgroundTask(memberId, a.taskId)?.result).toBe("ok");
    expect(existsSync(join(a.sessionDir, "task.json.tmp"))).toBe(false);
  });
});
