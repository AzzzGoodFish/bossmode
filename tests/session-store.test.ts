import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { coreFixture } from "./helpers/core-fixture.js";
import { MembersRepository } from "../src/storage/repositories/members.js";
import { ConversationsRepository } from "../src/storage/repositories/conversations.js";
import { SessionRepository } from "../src/storage/repositories/session-repository.js";
import * as sessionStore from "../src/workspace/session-store.js";

let fixture: ReturnType<typeof coreFixture>;
let tempDir: string;
describe("session-store SQL associations", () => {
  beforeEach(() => {
    fixture = coreFixture();
    tempDir = fixture.root;
    new MembersRepository(fixture.db).insert({id: "rm_pm", name: "pm", agentTemplate: "general", global: {},
      createdAt: 1, updatedAt: 2, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}});
    mkdirSync(join(tempDir, "members", "rm_pm"), {recursive: true});
    const conversations = new ConversationsRepository(fixture.db);
    conversations.ensureDmScope("rm_pm");
    conversations.upsertRoom({id: "room_a", name: "test", members: [], globalMemberIds: ["rm_pm"], createdAt: 1});
  });
  afterEach(() => fixture.close());

  it("persists one SQL association and reset removes only that reference", () => {
    const room = {id: "room_a"};
    const archive = join(tempDir, "members", "rm_pm", "sessions", "2026-09-07", "rooms", room.id, "session.jsonl");
    mkdirSync(join(archive, ".."), { recursive: true });
    writeFileSync(archive, "{\"type\":\"session\"}\n", "utf8");

    sessionStore.saveSession(room.id, "rm_pm", { runtime: "pi-cli", sessionId: "session-123", sessionFile: archive });
    expect(sessionStore.getSessions(room.id, "rm_pm")).toEqual({ rm_pm: { runtime: "pi-cli", sessionId: "session-123", sessionFile: archive } });
    const raw = new SessionRepository(fixture.db).get("rm_pm", room.id)!;
    expect(raw.session.sessionFile).toBe(`sessions/2026-09-07/rooms/${room.id}/session.jsonl`);

    fixture.reopen();
    expect(sessionStore.getCurrentSession("rm_pm", room.id)?.sessionFile).toBe(archive);
    sessionStore.clearSession(room.id, "rm_pm", "pi-cli");
    expect(sessionStore.getSessions(room.id, "rm_pm")).toEqual({});
    expect(readFileSync(archive, "utf8")).toBe("{\"type\":\"session\"}\n");
  });

  it("ignores malformed retired current.json without overwriting the historical source", () => {
    const path = join(tempDir, "members", "rm_pm", "sessions");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "current.json"), "not json", "utf8");
    sessionStore.saveSession("room:room_a", "rm_pm", { runtime: "pi-cli" });
    expect(sessionStore.getCurrentSession("rm_pm", "room:room_a")).toEqual({runtime: "pi-cli"});
    expect(readFileSync(join(path, "current.json"), "utf8")).toBe("not json");
  });

  it("rejects wrong-scope and missing current session files", () => {
    const roomFile = join(tempDir, "members", "rm_pm", "sessions", "2026-09-07", "rooms", "room_a", "one.jsonl");
    mkdirSync(join(roomFile, ".."), { recursive: true });
    writeFileSync(roomFile, "{}\n");
    expect(() => sessionStore.saveSession("topic:topic_a", "rm_pm", { runtime: "pi-sdk", sessionFile: roomFile })).toThrow(/outside the topic:topic_a archive/);
    new SessionRepository(fixture.db).importAssociation({memberId: "rm_pm", scopeId: "room:room_a",
      session: {runtime: "pi-sdk", sessionFile: "sessions/2026-09-07/rooms/room_a/missing.jsonl"},
      referenceKind: "member-relative", createdAt: 1, updatedAt: 2});
    expect(() => sessionStore.getCurrentSession("rm_pm", "room:room_a")).toThrow(/is missing/);
    sessionStore.clearCurrentSession("rm_pm", "room:room_a");
    expect(sessionStore.getCurrentSession("rm_pm", "room:room_a")).toBeUndefined();
  });

  it("keeps member scope references independent", () => {
    sessionStore.saveSession("room:room_a", "rm_pm", { runtime: "pi-cli", sessionId: "room" });
    sessionStore.saveSession("dm:rm_pm", "rm_pm", { runtime: "pi-cli", sessionId: "dm" });
    sessionStore.deleteSessionEntry("room:room_a", "rm_pm");

    expect(sessionStore.getCurrentSession("rm_pm", "room:room_a")).toBeUndefined();
    expect(sessionStore.getCurrentSession("rm_pm", "dm:rm_pm")).toMatchObject({ sessionId: "dm" });
  });
});
