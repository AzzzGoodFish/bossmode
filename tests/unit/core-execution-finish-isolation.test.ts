import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { SessionRepository } from "../../src/storage/repositories/session-repository.js";
import { RuntimeRepository } from "../../src/storage/repositories/runtime-repository.js";
import { UserCursorRepository } from "../../src/storage/repositories/user-cursor-repository.js";
import * as runtime from "../../src/workspace/runtime-state.js";
import * as sessions from "../../src/workspace/session-store.js";
import * as cursors from "../../src/workspace/user-read-cursors.js";
import { stampGlobalMemberIds, getCursors } from "../../src/workspace/room-store.js";

let fixture: ReturnType<typeof coreFixture>;
const owners = ["mem_one", "mem_two"];
const scopes = ["room:r", "dm:mem_one", "dm:mem_two"];
beforeEach(() => {
  fixture = coreFixture();
  const conversations = new ConversationsRepository(fixture.db);
  for (const [i, id] of owners.entries()) {
    new MembersRepository(fixture.db).insert({id, name: `member${i}`, agentTemplate: "general", global: {},
      createdAt: 1, updatedAt: 2, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}});
    conversations.ensureDmScope(id);
  }
  conversations.upsertRoom({id: "r", name: "Room", members: [], globalMemberIds: owners, createdAt: 1});
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

describe("execution metadata isolation and transactional failures", () => {
  it("keeps runtime fields, drift versions and notification timestamps isolated over rename and reopen", () => {
    for (const id of owners) {
      for (const scope of ["room:r", `dm:${id}`]) {
        runtime.setContractFingerprint(scope, id, `${scope}:${id}`, 3);
        runtime.markDriftNotified(scope, id, 4);
      }
    }
    vi.spyOn(Date, "now").mockReturnValue(100);
    runtime.markStaleMounts("r", owners[0], ["mcpServers"]);
    vi.mocked(Date.now).mockReturnValue(200);
    runtime.markStaleMounts("room:r", owners[0], ["mcpServers", "skills"]);
    runtime.setContractFingerprint("r", owners[0], "refreshed", 5);
    fixture.db.run("UPDATE members SET name='Renamed',name_key='renamed' WHERE id=?", owners[0]);
    fixture.reopen();
    expect(runtime.getRuntimeStateEntry("room:r", owners[0])).toEqual({contractFingerprint: "refreshed", contractVersion: 5,
      staleMounts: {since: 200, fields: ["mcpServers", "skills"]}});
    expect(runtime.readRuntimeState("r")[`room:r:${owners[1]}`]).toEqual({contractFingerprint: `room:r:${owners[1]}`, contractVersion: 3, driftNotified: 4});
    runtime.clearRuntimeStateEntry("r", owners[0]);
    expect(runtime.getRuntimeStateEntry("r", owners[0])).toEqual({});
    expect(fixture.db.all("SELECT * FROM runtime_stale_fields")).toEqual([]);
    expect(runtime.getRuntimeStateEntry(`dm:${owners[0]}`, owners[0]).contractFingerprint).toBe(`dm:${owners[0]}:${owners[0]}`);
    expect(() => runtime.setContractFingerprint(`dm:${owners[0]}`, owners[1], "wrong", 1)).toThrow(/belong/);
    expect(() => runtime.setContractFingerprint("r", "Renamed", "wrong", 1)).toThrow(/member ID/);
  });

  it("rolls back runtime parent and ordered child fields with the original timestamp on failure", () => {
    const repo = new RuntimeRepository(fixture.db);
    const original = {contractVersion: 2, staleMounts: {since: 1, fields: ["old"]}};
    repo.importEntry("r", owners[0], original, 10);
    fixture.db.exec("CREATE TRIGGER reject_stale BEFORE INSERT ON runtime_stale_fields WHEN NEW.field='bad' BEGIN SELECT RAISE(ABORT,'stale full'); END");
    expect(() => repo.importEntry("r", owners[0], {contractVersion: 3, staleMounts: {since: 20, fields: ["new", "bad"]}}, 30)).toThrow("stale full");
    fixture.reopen();
    expect(new RuntimeRepository(fixture.db).get("r", owners[0])).toEqual(original);
    expect(fixture.db.get("SELECT updated_at FROM runtime_checkpoints")).toEqual({updated_at: 10});
    runtime.clearStaleMounts(`dm:${owners[0]}`, owners[0]);
    expect(runtime.readRuntimeState(`dm:${owners[0]}`)).toEqual({});
  });

  it("preserves session creation time and atomically rolls back a multi-scope clear", () => {
    const repo = new SessionRepository(fixture.db);
    for (const id of owners) for (const scope of ["r", `dm:${id}`]) {
      repo.importAssociation({memberId: id, scopeId: scope, session: {runtime: "pi-sdk", sessionId: `${scope}:${id}`},
        referenceKind: "member-relative", createdAt: 10, updatedAt: 20});
    }
    vi.spyOn(Date, "now").mockReturnValue(30);
    sessions.saveCurrentSession(owners[0], "room:r", {runtime: "pi-sdk", sessionId: "replacement"});
    expect(repo.get(owners[0], "r")).toMatchObject({createdAt: 10, updatedAt: 30});
    fixture.db.exec(`CREATE TRIGGER reject_clear BEFORE DELETE ON current_sessions WHEN OLD.scope_id='dm:mem_one' BEGIN SELECT RAISE(ABORT,'clear blocked'); END`);
    expect(() => sessions.clearCurrentSessions(owners[0], ["r", `dm:${owners[0]}`])).toThrow("clear blocked");
    expect(sessions.getCurrentSession(owners[0], "r")?.sessionId).toBe("replacement");
    fixture.db.exec("DROP TRIGGER reject_clear");
    sessions.clearCurrentSessions(owners[0], ["r", `dm:${owners[0]}`]);
    expect(sessions.getCurrentSession(owners[0], `dm:${owners[0]}`)).toBeUndefined();
    expect(sessions.getCurrentSession(owners[1], "r")?.sessionId).toBe(`r:${owners[1]}`);
  });

  it("keeps member and user positions independent across room and both DMs, including null/zero and backward patches", () => {
    const repo = new ConversationsRepository(fixture.db);
    for (const [i, scope] of scopes.entries()) {
      repo.setCursor(scope.startsWith("room:") ? scope.slice(5) : scope, owners[0], `member-${i}`);
      new UserCursorRepository(fixture.db).importCursor(scope, {messageId: `user-${i}`, seq: i + 10, updatedAt: i});
    }
    vi.spyOn(Date, "now").mockReturnValue(50);
    cursors.setUserReadCursor("room:r", {seq: 0});
    cursors.setUserReadCursor("dm:mem_one", {messageId: null});
    fixture.reopen();
    expect(cursors.listUserReadCursors()).toEqual({
      "room:r": {messageId: "user-0", seq: 0, updatedAt: 50},
      "dm:mem_one": {messageId: null, seq: 11, updatedAt: 50},
      "dm:mem_two": {messageId: "user-2", seq: 12, updatedAt: 2},
    });
    for (const [i, scope] of scopes.entries()) {
      expect(new ConversationsRepository(fixture.db).getCursors(scope.startsWith("room:") ? scope.slice(5) : scope)).toEqual({mem_one: `member-${i}`});
    }
  });

  it("rolls back both user cursor columns and timestamp when message-reference persistence fails", () => {
    const repo = new UserCursorRepository(fixture.db);
    const original = {messageId: "before", seq: 9, updatedAt: 10};
    repo.importCursor("r", original);
    fixture.db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE ON user_cursor_messages BEGIN SELECT RAISE(ABORT,'cursor full'); END");
    expect(() => cursors.setUserReadCursor("room:r", {messageId: "after", seq: 11})).toThrow("cursor full");
    fixture.reopen();
    expect(cursors.getUserReadCursor("room:r")).toEqual(original);
    expect(fixture.db.get("SELECT value,typeof(value) AS value_type FROM read_cursors")).toEqual({value: "9", value_type: "text"});
  });

  it("moves only proven historical cursor links and never overwrites an existing stable-ID position", () => {
    const repo = new ConversationsRepository(fixture.db);
    repo.upsertRoom({id: "r", name: "Room", members: ["member0", "member1"], createdAt: 1,
      roomMembers: [
        {id: "rm_one", roomId: "r", name: "member0", sourceAgent: "general", sourceMemberId: owners[0], createdAt: 1, updatedAt: 1},
        {id: "rm_two", roomId: "r", name: "member1", sourceAgent: "general", createdAt: 1, updatedAt: 1},
      ]});
    repo.setCursor("r", "rm_one", "proven-old");
    repo.setCursor("r", "rm_two", "unresolved-old");
    repo.setCursor("r", owners[0], "newer-position");
    stampGlobalMemberIds("r", owners);
    expect(getCursors("r")).toEqual({mem_one: "newer-position", rm_two: "unresolved-old"});
    repo.deleteCursor("r", owners[0]);
    repo.setCursor("r", "rm_one", "proven-old");
    stampGlobalMemberIds("r", owners);
    fixture.reopen();
    expect(getCursors("r")).toEqual({mem_one: "proven-old", rm_two: "unresolved-old"});
    expect(new ConversationsRepository(fixture.db).getCursors("dm:mem_two")).toEqual({});
  });

  it("propagates closed storage errors from session/runtime/cursor reads and writes instead of returning empty success", () => {
    fixture.db.close();
    for (const read of [() => sessions.getCurrentSession(owners[0], "r"), () => runtime.readRuntimeState("room:r"),
      () => cursors.getUserReadCursor("room:r")]) expect(read).toThrow(/initialized|closed/);
    for (const write of [() => sessions.saveCurrentSession(owners[0], "r", {runtime: "pi-sdk"}),
      () => runtime.setContractFingerprint("r", owners[0], "unsaved", 1),
      () => cursors.setUserReadCursor("room:r", {seq: 0})]) expect(write).toThrow(/initialized|closed/);
  });
});
