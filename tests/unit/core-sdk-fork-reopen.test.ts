import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { forkRoomSessionPrefix, getTopicSession, pickForkLeafId } from "../../src/engine/topic-session-fork.js";
import { mainSessionDirectory, saveCurrentSession } from "../../src/workspace/session-store.js";

vi.mock("../../src/foundation/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// SDK 0.82.1 public-API investigation, not a claim that the application defect is
// fixed. No synthetic JSONL, private fields, provider calls or persistence hacks.
let f: ReturnType<typeof coreFixture>;
const owner = "mem_reopen";
const room = "reopen-room";
const topic = "reopen-topic";
const scope = `topic:${topic}`;
const anchorText = "selected earlier anchor";
function assistant(text: string) {
  return { role: "assistant" as const, content: [{ type: "text" as const, text }], api: "openai-responses" as const,
    provider: "offline", model: "fixture", timestamp: 1, stopReason: "stop" as const,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function source(withEarlierAssistant: boolean) {
  const manager = SessionManager.create(f.root, mainSessionDirectory(owner, `room:${room}`));
  if (withEarlierAssistant) {
    manager.appendMessage({ role: "user", content: "earlier room work", timestamp: 1 });
    manager.appendMessage(assistant("earlier room answer"));
  }
  const anchor = manager.appendMessage({ role: "user", content: anchorText, timestamp: 2 });
  manager.appendMessage(assistant("later room answer must not leak"));
  const later = manager.appendMessage({ role: "user", content: "later room chatter must not leak", timestamp: 3 });
  const file = manager.getSessionFile()!;
  saveCurrentSession(owner, `room:${room}`, { runtime: "pi-sdk", sessionId: manager.getSessionId(), sessionFile: file });
  return { manager, anchor, later, file, bytes: readFileSync(file) };
}
beforeEach(() => {
  f = coreFixture();
  f.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,'Reopen','reopen','test','{}',1,1)", owner);
  const conversations = new ConversationsRepository(f.db);
  conversations.upsertRoom({ id: room, name: "Reopen room", createdAt: 1, members: ["Reopen"], globalMemberIds: [owner] });
  conversations.upsertTopic({ id: topic, roomId: room, title: "Reopen", anchorMessageId: "anchor", createdBy: "user", createdAt: 1, status: "active", seedMode: "fork", participants: [owner] });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in fork reopen test"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); f.close();
});

describe("installed SDK native prefix creation: capabilities and blockers", () => {
  it("materializes an assistant-containing prefix in the destination, survives immediate reopen and later append/reopen", () => {
    const src = source(true);
    const destination = mainSessionDirectory(owner, scope);
    const brancher = SessionManager.open(src.file, destination, f.root);
    expect(brancher.getSessionFile()).toBe(src.file);
    expect(brancher.getSessionDir()).toBe(destination);
    const prefix = brancher.getBranch(src.anchor);
    const file = brancher.createBranchedSession(src.anchor)!;
    const id = brancher.getSessionId();
    expect(dirname(file)).toBe(destination);
    expect(file).not.toBe(src.file);
    expect(id).not.toBe(src.manager.getSessionId());
    expect(brancher.getHeader()?.parentSession).toBe(src.file);
    expect(readdirSync(destination)).toEqual([file.slice(destination.length + 1)]);
    // SessionManager has no close/dispose API or open file handle. Reopen from
    // disk without using the brancher for any append or carrying its state.
    const reopened = SessionManager.open(file, destination, f.root);
    expect(reopened.getSessionId()).toBe(id);
    expect(reopened.getSessionDir()).toBe(destination);
    expect(reopened.getLeafId()).toBe(src.anchor);
    expect(reopened.getEntries()).toEqual(prefix);
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("must not leak");
    const next = reopened.appendMessage({ role: "user", content: "new topic work", timestamp: 4 });
    const again = SessionManager.open(file, destination, f.root);
    expect(again.getSessionId()).toBe(id);
    expect(again.getBranch().map(e => e.id)).toEqual([...prefix.map(e => e.id), next]);
    expect(JSON.stringify(again.buildSessionContext())).toContain("new topic work");
    expect(JSON.stringify(again.buildSessionContext())).not.toContain("must not leak");
    expect(readFileSync(src.file)).toEqual(src.bytes);
  });

  it("BLOCKER: first-user prefix returns a new SDK path/id but creates no file, even after non-assistant appends", () => {
    const src = source(false);
    const destination = mainSessionDirectory(owner, scope);
    const brancher = SessionManager.open(src.file, destination, f.root);
    const file = brancher.createBranchedSession(src.anchor)!;
    expect(brancher.isPersisted()).toBe(true); // This means persistence mode, not file existence.
    expect(brancher.getSessionId()).not.toBe(src.manager.getSessionId());
    expect(brancher.getBranch().map(e => e.id)).toEqual([src.anchor]);
    expect(dirname(file)).toBe(destination);
    expect(existsSync(file)).toBe(false);
    brancher.appendCustomEntry("offline-probe", { purpose: "not a flush API" });
    brancher.appendMessage({ role: "user", content: "new topic work", timestamp: 4 });
    expect(existsSync(file)).toBe(false);
    const reopened = SessionManager.open(file, destination, f.root);
    expect(reopened.getSessionId()).not.toBe(brancher.getSessionId());
    expect(reopened.getEntries()).toEqual([]);
    expect(readdirSync(destination)).toEqual([]);
    expect(readFileSync(src.file)).toEqual(src.bytes);
  });

  it("native last-user fallback is durable when its prefix includes an assistant", () => {
    const src = source(false);
    const destination = mainSessionDirectory(owner, scope);
    const brancher = SessionManager.open(src.file, destination, f.root);
    const leaf = pickForkLeafId(brancher.getEntries(), "unmatched anchor excerpt")!;
    expect(leaf).toBe(src.later);
    const file = brancher.createBranchedSession(leaf)!;
    expect(SessionManager.open(file, destination, f.root).getBranch()).toEqual(src.manager.getBranch(leaf));
    expect(readFileSync(src.file)).toEqual(src.bytes);
  });

  it("native branching rebuilds labels and parent links rather than preserving exact entry equality", () => {
    const src = source(true);
    src.manager.branch(src.anchor);
    src.manager.appendLabelChange(src.anchor, "selected label");
    const anchor = src.manager.appendMessage({ role: "user", content: "anchor after label", timestamp: 4 });
    src.manager.appendMessage(assistant("later work"));
    const bytes = readFileSync(src.file);
    const destination = mainSessionDirectory(owner, scope);
    const brancher = SessionManager.open(src.file, destination, f.root);
    const selected = brancher.getBranch(anchor);
    const file = brancher.createBranchedSession(anchor)!;
    const reopened = SessionManager.open(file, destination, f.root);
    expect(reopened.getBranch()).not.toEqual(selected);
    expect(reopened.getLeafEntry()?.type).toBe("label");
    expect(reopened.getLabel(src.anchor)).toBe("selected label");
    expect(reopened.getBranch().filter(e => e.type !== "label").map(e => e.id))
      .toEqual(selected.filter(e => e.type !== "label").map(e => e.id));
    expect(reopened.getEntry(anchor)?.parentId).toBe(src.anchor);
    expect(JSON.stringify(reopened.buildSessionContext())).not.toContain("later work");
    expect(readFileSync(src.file)).toEqual(bytes);
  });
});

describe("application reopen defect characterization (not acceptance)", () => {
  it.each([false, true])("BLOCKER: acknowledged association reopens the full room history (earlier assistant=%s)", withEarlierAssistant => {
    const src = source(withEarlierAssistant);
    const result = forkRoomSessionPrefix({ memberId: owner, parentRoomId: room, topicId: topic,
      cwd: f.root, seedMode: "fork", anchorExcerpt: anchorText });
    expect(result.sessionManager!.getLeafId()).toBe(src.anchor);
    expect(result.prefixSummary).not.toContain("must not leak");
    expect(getTopicSession(room, topic, owner)).toMatchObject({ sessionId: result.sessionId, sessionFile: result.sessionFile });
    expect(f.db.get("SELECT status,operation,member_id,scope_id FROM execution_attempts")).toEqual({
      status: "acknowledged", operation: "session-fork", member_id: owner, scope_id: scope,
    });
    expect(dirname(result.sessionFile!)).toBe(mainSessionDirectory(owner, scope));
    f.reopen();
    const saved = getTopicSession(room, topic, owner)!;
    const reopened = SessionManager.open(saved.sessionFile!, mainSessionDirectory(owner, scope), f.root);
    expect(reopened.getSessionId()).toBe(result.sessionId);
    expect(reopened.getLeafId()).toBe(src.later); // Known defect, deliberately explicit.
    expect(JSON.stringify(reopened.buildSessionContext())).toContain("must not leak");
    const next = reopened.appendMessage({ role: "user", content: "topic after restart", timestamp: 5 });
    const again = SessionManager.open(saved.sessionFile!, mainSessionDirectory(owner, scope), f.root);
    expect(again.getLeafId()).toBe(next);
    expect(JSON.stringify(again.buildSessionContext())).toContain("topic after restart");
    expect(JSON.stringify(again.buildSessionContext())).toContain("must not leak");
    expect(readFileSync(src.file)).toEqual(src.bytes);
  });
});
