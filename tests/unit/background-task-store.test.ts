/**
 * Background task store: lifecycle records, transactional SQL persistence,
 * UTC date folders, strict validation, disposable waiters, restart sweep.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { coreFixture } from "../helpers/core-fixture.js";
import { createMember } from "../../src/workspace/member-registry.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { BackgroundRepository } from "../../src/storage/repositories/background-repository.js";
import * as store from "../../src/engine/background-task-store.js";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
let memberId: string;
beforeEach(() => {
  fixture = coreFixture();
  dir = fixture.root;
  memberId = createMember({name: "bgtester"}).id;
  new ConversationsRepository(fixture.db).upsertRoom({id: "bgroom", name: "Background", members: [], globalMemberIds: [memberId], createdAt: 1});
});
afterEach(async () => {
  await Promise.resolve(); // Drain committed terminal notifications before closing storage.
  vi.useRealTimers();
  vi.restoreAllMocks();
  fixture.close();
});
function mkTask(overrides: Partial<Parameters<typeof store.createBackgroundTask>[0]> = {}) {
  return store.createBackgroundTask({memberId, scopeId: "room:bgroom", kind: "recall", sessionMode: "fork",
    prompt: "collect memory", snapshot: {model: "test/model", credentialId: "cred-1", thinkingLevel: "medium"}, ...overrides});
}

describe("background task store", () => {
  it("creates a UTC SDK directory with a full UUID and SQL metadata, no task.json", () => {
    const record = mkTask();
    expect(record.status).toBe("starting");
    expect(record.result).toBeNull();
    expect(record.taskId).toMatch(/^bgt-[0-9a-f-]{36}$/);
    expect(record.sessionDir).toBe(join(dir, "members", memberId, "background-tasks", record.startedAt.slice(0, 10), record.taskId));
    expect(existsSync(record.sessionDir)).toBe(true);
    expect(existsSync(join(record.sessionDir, "task.json"))).toBe(false);
    fixture.reopen();
    expect(store.getBackgroundTask(memberId, record.taskId)).toEqual(record);
  });

  it("round-trips via getBackgroundTask and lists records in start-time order across UTC dates", () => {
    const a = mkTask();
    const loaded = store.getBackgroundTask(memberId, a.taskId);
    expect(loaded?.prompt).toBe("collect memory");
    expect(loaded?.sessionMode).toBe("fork");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(a.startedAt) + 86400000));
    const b = mkTask({ kind: "memorize", sessionMode: "new" });
    vi.useRealTimers();
    const list = store.listBackgroundTasks(memberId);
    expect(list.map((t) => t.taskId)).toEqual([a.taskId, b.taskId]);
    expect(store.getBackgroundTask("mem_other", a.taskId)).toBeNull();
  });

  it("isolates known members and room/DM/topic records, including terminal waiters", async () => {
    const other = createMember({name: "other"}).id;
    const conversations = new ConversationsRepository(fixture.db);
    conversations.upsertTopic({id: "topic", roomId: "bgroom", title: "Topic", anchorMessageId: "anchor", createdBy: "user",
      createdAt: 1, status: "active", seedMode: "fresh", participants: [memberId, other]});
    const roomTask = mkTask();
    const dmTask = mkTask({scopeId: `dm:${memberId}`});
    const topicTask = mkTask({scopeId: "topic:topic"});
    const otherTask = mkTask({memberId: other, scopeId: `dm:${other}`});
    expect(store.listBackgroundTasks(memberId).map(t => t.scopeId).sort()).toEqual(["room:bgroom", `dm:${memberId}`, "topic:topic"].sort());
    expect(store.listBackgroundTasks(other)).toEqual([otherTask]);
    expect(store.getBackgroundTask(other, roomTask.taskId)).toBeNull();
    expect(() => store.updateBackgroundTask(other, roomTask.taskId, {status: "running"})).toThrow(/not found/);
    const waiting = store.whenTerminal(memberId, dmTask.taskId);
    let settled = false;
    void waiting.promise.then(() => { settled = true; });
    store.updateBackgroundTask(memberId, topicTask.taskId, {status: "failed", error: "topic failed"});
    await Promise.resolve();
    expect(settled).toBe(false);
    store.updateBackgroundTask(memberId, dmTask.taskId, {status: "failed", error: "DM failed"});
    expect((await waiting.promise).scopeId).toBe(`dm:${memberId}`);
    expect(store.getBackgroundTask(memberId, roomTask.taskId)?.status).toBe("starting");
    expect(store.getBackgroundTask(other, otherTask.taskId)?.status).toBe("starting");
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
    expect(() => store.updateBackgroundTask(memberId, a.taskId, { result: "x" })).toThrow(/nonterminal outcome/);
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

  it("ignores corrupt historical task.json and temp files, even with a missing SDK directory", () => {
    const a = mkTask();
    writeFileSync(join(a.sessionDir, "task.json"), "{ not json");
    writeFileSync(join(a.sessionDir, "task.json.tmp"), "{ partial");
    expect(store.getBackgroundTask(memberId, a.taskId)).toEqual(a);
    rmSync(a.sessionDir, {recursive: true});
    expect(store.listBackgroundTasks(memberId)).toEqual([a]);
    expect(store.sweepInterruptedBackgroundTasks()).toBe(1);
    expect(store.getBackgroundTask(memberId, a.taskId)?.status).toBe("interrupted");
  });

  it("rejects unknown enums, forged ownership and directory references during explicit import", () => {
    const a = mkTask();
    const repo = new BackgroundRepository(fixture.db);
    for (const patch of [{kind: "mystery"}, {status: "paused"}, {memberId: "mem_other"}, {sessionDir: "/tmp/elsewhere"}]) {
      expect(() => repo.importRecord({...a, ...patch} as typeof a)).toThrow(/Invalid|member/);
      expect(store.getBackgroundTask(memberId, a.taskId)).toEqual(a);
    }
  });

  it("rejects terminal historical records missing their terminal evidence", () => {
    const a = mkTask();
    const repo = new BackgroundRepository(fixture.db);
    expect(() => repo.importRecord({...a, status: "failed", endedAt: a.startedAt, error: null})).toThrow(/terminal result/);
    expect(() => repo.importRecord({...a, status: "done", endedAt: null, result: "answer"})).toThrow(/terminal endedAt/);
    expect(store.getBackgroundTask(memberId, a.taskId)).toEqual(a);
  });

  it("rolls back terminal metadata when outbox persistence fails, with no false waiter success", async () => {
    const a = mkTask();
    store.updateBackgroundTask(memberId, a.taskId, {status: "running"});
    const waiter = store.whenTerminal(memberId, a.taskId);
    fixture.db.exec("CREATE TRIGGER reject_terminal BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'outbox full'); END");
    expect(() => store.updateBackgroundTask(memberId, a.taskId, {status: "done", result: "unsaved"})).toThrow("outbox full");
    expect(store.getBackgroundTask(memberId, a.taskId)).toMatchObject({status: "running", endedAt: null, result: null});
    expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
    const rejection = expect(waiter.promise).rejects.toThrow(/unsaved diagnosis/);
    store.failBackgroundTaskUnsaved(memberId, a.taskId, "outbox full");
    await rejection;
  });
});
