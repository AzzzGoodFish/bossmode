import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { coreFixture } from "../helpers/core-fixture.js";
import { openDatabase } from "../../src/storage/database.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import { ExecutionAttemptRepository } from "../../src/storage/repositories/execution-attempt-repository.js";
import { SdkExecutionService } from "../../src/services/sdk-execution-service.js";
import { forkRoomSessionPrefix, getTopicSession } from "../../src/engine/topic-session-fork.js";
import { mainSessionDirectory, saveCurrentSession } from "../../src/workspace/session-store.js";

vi.mock("../../src/foundation/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// Real SQL and installed SDK file/branch APIs. Fault injection wraps public
// methods or uses SQL triggers; tests never write/patch SDK JSONL or private state.
let f: ReturnType<typeof coreFixture>;
let source: SessionManager;
let sourceFile: string;
let sourceBytes: Buffer;
let leafId: string;
const owner = "mem_fork";
const topic = "topic_fork";
const scope = `topic:${topic}`;
const room = "fork-room";
function args() { return { memberId: owner, parentRoomId: room, topicId: topic, cwd: f.root, seedMode: "fork" as const, anchorExcerpt: "investigate the flaky test" }; }
function rows() { return f.db.all<any>("SELECT * FROM execution_attempts ORDER BY rowid"); }
function association() { return getTopicSession(room, topic, owner); }
function artifacts() {
  const provenance = JSON.parse(rows().at(-1).external_reference);
  return existsSync(provenance.sessionDir) ? readdirSync(provenance.sessionDir).filter(name => name.includes(provenance.forkSessionId)).map(name => join(provenance.sessionDir, name)) : [];
}
function assertInterrupted() {
  expect(rows().at(-1)).toMatchObject({ member_id: owner, scope_id: scope, operation: "session-fork", status: "interrupted", diagnosis: expect.stringContaining("not replayed") });
  expect(readFileSync(sourceFile)).toEqual(sourceBytes);
}
function failStatus(status: string) {
  f.db.exec(`CREATE TRIGGER reject_${status} BEFORE UPDATE OF status ON execution_attempts WHEN NEW.status='${status}' BEGIN SELECT RAISE(ABORT,'reject ${status}'); END`);
}
function assistant(text: string) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-responses" as const,
    provider: "offline", model: "fixture", timestamp: 1, stopReason: "stop" as const,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
beforeEach(() => {
  f = coreFixture();
  f.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,'Fork owner','fork owner','test','{}',1,1)", owner);
  const conversations = new ConversationsRepository(f.db);
  conversations.upsertRoom({ id: room, name: "Fork room", createdAt: 1, members: ["Fork owner"], globalMemberIds: [owner] });
  conversations.upsertTopic({ id: topic, roomId: room, title: "Fork", anchorMessageId: "anchor", createdBy: "user", createdAt: 1, status: "active", seedMode: "fork", participants: [owner] });
  const sourceDir = mainSessionDirectory(owner, `room:${room}`);
  mkdirSync(sourceDir, { recursive: true });
  source = SessionManager.create(f.root, sourceDir);
  leafId = source.appendMessage({ role: "user", content: "Please investigate the flaky test", timestamp: 1 });
  source.appendMessage(assistant("investigating"));
  source.appendMessage({ role: "user", content: "later unrelated chatter", timestamp: 2 });
  sourceFile = source.getSessionFile()!;
  sourceBytes = readFileSync(sourceFile);
  saveCurrentSession(owner, `room:${room}`, { runtime: "pi-sdk", sessionId: source.getSessionId(), sessionFile: sourceFile });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in fork test"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); f.close();
});

describe("topic SDK prefix-fork execution boundary", () => {
  it("commits dispatch before SDK IO and acknowledges only durable provenance, reopened prefix and committed association", () => {
    const observer = openDatabase(f.path);
    const originalOpen = SessionManager.open;
    const originalFork = SessionManager.forkFrom;
    const originalAssociate = SessionRepository.prototype.importAssociation;
    const originalAck = ExecutionAttemptRepository.prototype.acknowledge;
    const order: string[] = [];
    const dispatched = () => {
      f.db.assertOutsideTransaction();
      expect(observer.get("SELECT status,operation FROM execution_attempts")).toEqual({ status: "dispatched", operation: "session-fork" });
    };
    let forked: SessionManager;
    vi.spyOn(SessionManager, "open").mockImplementation((...a) => { order.push("open"); dispatched(); return originalOpen(...a); });
    vi.spyOn(SessionManager, "forkFrom").mockImplementation((...a) => {
      order.push("fork"); dispatched(); forked = originalFork(...a);
      const branch = forked.branch.bind(forked);
      vi.spyOn(forked, "branch").mockImplementation(id => { order.push("branch"); dispatched(); branch(id); });
      const append = forked.appendCustomEntry.bind(forked);
      vi.spyOn(forked, "appendCustomEntry").mockImplementation((...a) => { order.push("provenance"); dispatched(); return append(...a); });
      return forked;
    });
    vi.spyOn(SessionRepository.prototype, "importAssociation").mockImplementation(function(a) {
      order.push("associate"); dispatched(); expect(forked.getLeafEntry()?.parentId).toBe(leafId); return originalAssociate.call(this, a);
    });
    vi.spyOn(ExecutionAttemptRepository.prototype, "acknowledge").mockImplementation(function(...a) {
      order.push("ack"); dispatched();
      expect(observer.get<any>("SELECT sdk_session_id FROM current_sessions WHERE scope_id=?", scope)?.sdk_session_id).toBe(forked.getSessionId());
      return originalAck.apply(this, a);
    });
    try {
      const result = forkRoomSessionPrefix(args());
      expect(order).toEqual(["open", "fork", "branch", "provenance", "open", "associate", "ack"]);
      expect(result.mode).toBe("fork"); expect(result.sessionManager).not.toBe(forked!);
      expect(result.sessionManager!.getBranch()).toEqual(forked!.getBranch());
      expect(result.prefixSummary).toContain("investigate the flaky test");
      expect(result.prefixSummary).not.toContain("later unrelated");
      const marker = result.sessionManager!.getLeafEntry()!;
      expect(marker).toMatchObject({ type: "custom", customType: "bossmode:topic-fork", parentId: leafId, data: { attemptId: rows()[0].id } });
      expect(result.sessionManager!.getBranch().map(e => e.id)).toEqual([leafId, marker.id]);
      expect(association()).toMatchObject({ sessionId: result.sessionId, sessionFile: result.sessionFile });
      expect(rows()[0].status).toBe("acknowledged");
      expect(JSON.parse(rows()[0].external_reference)).toMatchObject({ operation: "pi-sdk:SessionManager.forkFrom", sourceFile, sourceSessionId: source.getSessionId(), parentRoomId: room, forkSessionId: result.sessionId });
      // The non-message SDK provenance commits the cut before any conversation append.
      expect(originalOpen(result.sessionFile!, mainSessionDirectory(owner, scope), f.root).getLeafId()).toBe(marker.id);
      const nextId = result.sessionManager!.appendMessage({ role: "user", content: "topic continuation", timestamp: 3 });
      const reopened = originalOpen(result.sessionFile!, mainSessionDirectory(owner, scope), f.root);
      expect(reopened.getBranch().map(e => e.id)).toEqual([leafId, marker.id, nextId]);
      expect(readFileSync(sourceFile)).toEqual(sourceBytes);
    } finally { observer.close(); }
  });

  it.each(["fresh", "missing"])("%s source path does no SDK fork and creates no attempt", mode => {
    if (mode === "missing") new SessionRepository(f.db).clear(owner, [`room:${room}`]);
    const open = vi.spyOn(SessionManager, "open");
    expect(forkRoomSessionPrefix({ ...args(), ...(mode === "fresh" ? { seedMode: "fresh" as const } : {}) })).toMatchObject({ mode: "fresh", reason: mode === "fresh" ? "seedMode=fresh" : "no-room-session" });
    expect(open).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  });

  it("an unforkable SDK source records interruption, not a successful fork, before fresh fallback", () => {
    const original = SessionManager.open;
    vi.spyOn(SessionManager, "open").mockImplementation((...a) => { const manager = original(...a); vi.spyOn(manager, "getEntries").mockReturnValue([]); return manager; });
    const fork = vi.spyOn(SessionManager, "forkFrom");
    expect(forkRoomSessionPrefix(args())).toMatchObject({ mode: "fresh", reason: "no-forkable-entry" });
    assertInterrupted(); expect(association()).toBeUndefined(); expect(fork).not.toHaveBeenCalled();
  });

  it("uses the last SDK user entry when the anchor misses", () => {
    const result = forkRoomSessionPrefix({ ...args(), anchorExcerpt: "no such anchor excerpt" });
    expect(result.sessionManager!.getLeafEntry()?.parentId).toBe(source.getLeafId());
    expect(result.prefixSummary).toContain("later unrelated chatter");
  });

  it("retains stable ownership across a member rename", () => {
    f.db.run("UPDATE members SET name='Renamed',name_key='renamed' WHERE id=?", owner);
    expect(forkRoomSessionPrefix(args()).mode).toBe("fork");
    expect(rows()[0].member_id).toBe(owner);
    expect(association()).toBeDefined();
  });

  it.each(["dispatched", "prepared"])("%s SQL admission failure prevents every SDK operation and rolls back the attempt", status => {
    if (status === "dispatched") failStatus(status);
    else f.db.exec("CREATE TRIGGER reject_prepare BEFORE INSERT ON execution_attempts BEGIN SELECT RAISE(ABORT,'reject prepared'); END");
    const open = vi.spyOn(SessionManager, "open");
    expect(() => forkRoomSessionPrefix(args())).toThrow(`reject ${status}`);
    expect(open).not.toHaveBeenCalled(); expect(rows()).toEqual([]); expect(association()).toBeUndefined();
  });

  it("a deferred foreign-key commit failure prevents SDK IO", () => {
    f.db.exec(`CREATE TABLE admission_guard(member_id TEXT REFERENCES members(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON execution_attempts BEGIN INSERT INTO admission_guard VALUES('absent'); END`);
    const open = vi.spyOn(SessionManager, "open");
    expect(() => forkRoomSessionPrefix(args())).toThrow(/FOREIGN KEY/);
    expect(open).not.toHaveBeenCalled(); expect(rows()).toEqual([]); expect(f.db.all("SELECT * FROM admission_guard")).toEqual([]);
  });

  it("rejects an enclosing SQL transaction before SDK IO", () => {
    const open = vi.spyOn(SessionManager, "open");
    expect(() => f.db.transaction(() => forkRoomSessionPrefix(args()))).toThrow(/enclosing/);
    expect(open).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  });

  it("an unknown target scope is not disguised as fresh fallback", () => {
    const open = vi.spyOn(SessionManager, "open");
    expect(() => forkRoomSessionPrefix({ ...args(), topicId: "absent" })).toThrow(/scope_not_found/);
    expect(open).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  });

  it("missing SQL context is not disguised as fresh fallback", () => {
    const open = vi.spyOn(SessionManager, "open"); f.db.close();
    expect(() => forkRoomSessionPrefix(args())).toThrow("Core database is not initialized");
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["open", "forkFrom"] as const)("SDK %s rejection is interrupted and propagated", method => {
    vi.spyOn(SessionManager, method).mockImplementation(() => { throw new Error(`${method} failed`); });
    expect(() => forkRoomSessionPrefix(args())).toThrow(`${method} failed`);
    assertInterrupted(); expect(association()).toBeUndefined();
  });

  it("a forkFrom throw after SDK writing preserves an artifact discoverable from committed provenance", () => {
    const original = SessionManager.forkFrom;
    vi.spyOn(SessionManager, "forkFrom").mockImplementation((...a) => { original(...a); throw new Error("post-write failure"); });
    expect(() => forkRoomSessionPrefix(args())).toThrow("post-write failure");
    assertInterrupted(); expect(association()).toBeUndefined();
    expect(artifacts()).toHaveLength(1);
    expect(SessionManager.open(artifacts()[0]).getHeader()?.parentSession).toBe(sourceFile);
  });

  it.each(["throw", "no-op"])("branch %s is never labeled a successful prefix fork", fault => {
    const original = SessionManager.forkFrom;
    vi.spyOn(SessionManager, "forkFrom").mockImplementation((...a) => {
      const manager = original(...a);
      vi.spyOn(manager, "branch").mockImplementation(() => { if (fault === "throw") throw new Error("branch failed"); });
      return manager;
    });
    expect(() => forkRoomSessionPrefix(args())).toThrow(/branch/);
    assertInterrupted(); expect(association()).toBeUndefined(); expect(artifacts()).toHaveLength(1);
    expect(rows()[0].diagnosis).toContain(artifacts()[0]);
  });

  it.each(["throw", "post-write throw", "no-op", "memory-only"])("provenance %s cannot be acknowledged and preserves discoverable evidence", fault => {
    saveCurrentSession(owner, scope, { runtime: "pi-sdk", sessionId: "previous" });
    const original = SessionManager.forkFrom;
    vi.spyOn(SessionManager, "forkFrom").mockImplementation((...a) => {
      const manager = original(...a);
      const append = manager.appendCustomEntry.bind(manager);
      vi.spyOn(manager, "appendCustomEntry").mockImplementation((customType, data) => {
        if (fault === "post-write throw") { append(customType, data); throw new Error("provenance post-write failed"); }
        if (fault === "throw") throw new Error("provenance failed");
        if (fault === "no-op") return leafId;
        // Simulate a public method reporting success with only in-memory state.
        // No JSONL edits or SDK private state: fresh open must reject the absence.
        const marker = { type: "custom" as const, customType, data, id: "unpersisted-marker", parentId: leafId, timestamp: new Date().toISOString() };
        const getEntry = manager.getEntry.bind(manager);
        vi.spyOn(manager, "getEntry").mockImplementation(id => id === marker.id ? marker : getEntry(id));
        return marker.id;
      });
      return manager;
    });
    expect(() => forkRoomSessionPrefix(args())).toThrow(/provenance|durable prefix/);
    assertInterrupted(); expect(association()?.sessionId).toBe("previous"); expect(artifacts()).toHaveLength(1);
    const reopened = SessionManager.open(artifacts()[0]);
    if (fault === "post-write throw") {
      expect(reopened.getLeafEntry()).toMatchObject({ type: "custom", customType: "bossmode:topic-fork", parentId: leafId, data: { attemptId: rows()[0].id } });
      expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("later unrelated");
    } else expect(reopened.getLeafId()).toBe(source.getLeafId());
    f.reopen();
    expect(rows()[0].status).toBe("interrupted");
    expect(association()?.sessionId).toBe("previous");
  });

  it.each(["throw", "wrong branch", "wrong context"])("fresh reopen %s is interrupted before association even with a persisted marker", fault => {
    const original = SessionManager.open;
    vi.spyOn(SessionManager, "open").mockImplementation((...a) => {
      if (a[0] === sourceFile) return original(...a);
      if (fault === "throw") throw new Error("reopen failed");
      const manager = original(...a);
      if (fault === "wrong branch") manager.branch(source.getLeafId()!);
      else vi.spyOn(manager, "buildSessionContext").mockReturnValue(source.buildSessionContext());
      return manager;
    });
    expect(() => forkRoomSessionPrefix(args())).toThrow(/reopen failed|durable prefix/);
    assertInterrupted(); expect(association()).toBeUndefined(); expect(artifacts()).toHaveLength(1);
    const reopened = original(artifacts()[0]);
    expect(reopened.getLeafEntry()).toMatchObject({ type: "custom", customType: "bossmode:topic-fork", parentId: leafId });
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("later unrelated");
  });

  it.each(["file", "identity"])("unverified fork %s cannot be acknowledged", fault => {
    const original = SessionManager.forkFrom;
    vi.spyOn(SessionManager, "forkFrom").mockImplementation((...a) => {
      const manager = original(...a);
      if (fault === "file") vi.spyOn(manager, "getSessionFile").mockReturnValue(undefined);
      else vi.spyOn(manager, "getSessionId").mockReturnValue(source.getSessionId());
      return manager;
    });
    expect(() => forkRoomSessionPrefix(args())).toThrow(/verification failed/);
    assertInterrupted(); expect(association()).toBeUndefined(); expect(artifacts()).toHaveLength(1);
  });

  it("SQL association failure propagates and preserves both the artifact and previous association", () => {
    saveCurrentSession(owner, scope, { runtime: "pi-sdk", sessionId: "previous" });
    f.db.exec(`CREATE TRIGGER reject_association BEFORE INSERT ON current_sessions WHEN NEW.scope_id='${scope}' BEGIN SELECT RAISE(ABORT,'association failed'); END`);
    expect(() => forkRoomSessionPrefix(args())).toThrow("association failed");
    assertInterrupted(); expect(association()?.sessionId).toBe("previous"); expect(artifacts()).toHaveLength(1);
  });

  it("a silently lost association fails readback verification instead of acknowledging", () => {
    f.db.exec(`CREATE TRIGGER lose_association AFTER INSERT ON current_sessions WHEN NEW.scope_id='${scope}' BEGIN DELETE FROM current_sessions WHERE member_id=NEW.member_id AND scope_id=NEW.scope_id; END`);
    expect(() => forkRoomSessionPrefix(args())).toThrow("association verification failed");
    assertInterrupted(); expect(association()).toBeUndefined(); expect(artifacts()).toHaveLength(1);
  });

  it("SQL acknowledgement failure propagates while keeping the verified association and fork", () => {
    failStatus("acknowledged");
    expect(() => forkRoomSessionPrefix(args())).toThrow("reject acknowledged");
    assertInterrupted(); expect(artifacts()).toHaveLength(1);
    expect(association()?.sessionFile).toBe(artifacts()[0]);
    f.reopen();
    const reopened = SessionManager.open(association()!.sessionFile!);
    expect(reopened.getLeafEntry()).toMatchObject({ type: "custom", customType: "bossmode:topic-fork", parentId: leafId, data: { attemptId: rows()[0].id } });
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("later unrelated");
    expect(rows()[0].status).toBe("interrupted"); // The SDK marker never implies SQL acknowledgement.
  });

  it("simultaneous SDK and recording failures stay visible and leave dispatched evidence, never success", () => {
    failStatus("interrupted");
    vi.spyOn(SessionManager, "forkFrom").mockImplementation(() => { throw new Error("SDK failure"); });
    let caught: any;
    try { forkRoomSessionPrefix(args()); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught.errors.map((e: Error) => e.message).join(" | ")).toMatch(/SDK failure.*reject interrupted/);
    expect(rows()[0].status).toBe("dispatched"); expect(association()).toBeUndefined();
  });

  it("fresh fallback also propagates a failed interruption recording", () => {
    const original = SessionManager.open;
    vi.spyOn(SessionManager, "open").mockImplementation((...a) => { const manager = original(...a); vi.spyOn(manager, "getEntries").mockReturnValue([]); return manager; });
    failStatus("interrupted");
    expect(() => forkRoomSessionPrefix(args())).toThrow("recording failed");
    expect(rows()[0].status).toBe("dispatched"); expect(association()).toBeUndefined();
  });

  it("failure interrupts only its own attempt and reopening does not replay SDK IO", () => {
    const unrelated = new SdkExecutionService(owner, room).dispatch("input", "unrelated");
    const fork = vi.spyOn(SessionManager, "forkFrom").mockImplementation(() => { throw new Error("fork failure"); });
    expect(() => forkRoomSessionPrefix(args())).toThrow("fork failure");
    assertInterrupted(); f.reopen();
    expect(rows().map(r => [r.id, r.status])).toEqual([[unrelated.id, "dispatched"], [rows()[1].id, "interrupted"]]);
    expect(fork).toHaveBeenCalledOnce(); expect(artifacts()).toEqual([]);
  });
});
