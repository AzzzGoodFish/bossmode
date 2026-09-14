import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { coreFixture } from "./helpers/core-fixture.js";
import { MembersRepository } from "../src/storage/repositories/members.js";
import { SessionRepository } from "../src/storage/repositories/session-repository.js";
import * as sessionStore from "../src/workspace/session-store.js";

let fixture: ReturnType<typeof coreFixture>;
let tempDir: string;

function insertMember(id: string, name: string): void {
  new MembersRepository(fixture.db).insert({id, name, agentTemplate: "general", global: {},
    createdAt: 1, updatedAt: 2, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}});
  mkdirSync(join(tempDir, "members", id), {recursive: true});
}

describe("session-store member sessions", () => {
  beforeEach(() => {
    fixture = coreFixture();
    tempDir = fixture.root;
    insertMember("rm_pm", "pm");
    insertMember("rm_other", "other");
  });
  afterEach(() => fixture.close());

  it("persists one member session and reset removes only the reference", () => {
    const file = join(tempDir, "members", "rm_pm", "sessions", "2026-09-07", "main", "session.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{\"type\":\"session\"}\n", "utf8");

    sessionStore.saveCurrentSession("rm_pm", { runtime: "pi-cli", sessionId: "session-123", sessionFile: file });
    expect(sessionStore.getCurrentSession("rm_pm")).toEqual({ runtime: "pi-cli", sessionId: "session-123", sessionFile: file });
    expect(new SessionRepository(fixture.db).get("rm_pm")!.session.sessionFile).toBe("sessions/2026-09-07/main/session.jsonl");

    fixture.reopen();
    expect(sessionStore.getCurrentSession("rm_pm")?.sessionFile).toBe(file);
    sessionStore.clearCurrentSession("rm_pm");
    expect(sessionStore.getCurrentSession("rm_pm")).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("{\"type\":\"session\"}\n");
  });

  it("keeps one row per member: a later save replaces the earlier session", () => {
    sessionStore.saveCurrentSession("rm_pm", { runtime: "pi-cli", sessionId: "first" });
    sessionStore.saveCurrentSession("rm_pm", { runtime: "pi-cli", sessionId: "second" });
    expect(sessionStore.getCurrentSession("rm_pm")).toMatchObject({ sessionId: "second" });
    expect(new SessionRepository(fixture.db).get("rm_pm")!.session.sessionId).toBe("second");
  });

  it("keeps member references independent", () => {
    sessionStore.saveCurrentSession("rm_pm", { runtime: "pi-cli", sessionId: "pm" });
    sessionStore.saveCurrentSession("rm_other", { runtime: "pi-cli", sessionId: "other" });
    sessionStore.clearCurrentSession("rm_pm");

    expect(sessionStore.getCurrentSession("rm_pm")).toBeUndefined();
    expect(sessionStore.getCurrentSession("rm_other")).toMatchObject({ sessionId: "other" });
  });

  it("rejects files outside the member session store and missing references", () => {
    const retiredLayout = join(tempDir, "members", "rm_pm", "sessions", "2026-09-07", "rooms", "room_a", "one.jsonl");
    mkdirSync(join(retiredLayout, ".."), { recursive: true });
    writeFileSync(retiredLayout, "{}\n");
    expect(() => sessionStore.saveCurrentSession("rm_pm", { runtime: "pi-sdk", sessionFile: retiredLayout }))
      .toThrow(/outside the member session store/);

    const otherMemberFile = join(tempDir, "members", "rm_other", "sessions", "2026-09-07", "main", "other.jsonl");
    mkdirSync(join(otherMemberFile, ".."), { recursive: true });
    writeFileSync(otherMemberFile, "{}\n");
    expect(() => sessionStore.saveCurrentSession("rm_pm", { runtime: "pi-sdk", sessionFile: otherMemberFile }))
      .toThrow(/outside the member session store/);

    new SessionRepository(fixture.db).importAssociation({memberId: "rm_pm",
      session: {runtime: "pi-sdk", sessionFile: "sessions/2026-09-07/main/missing.jsonl"},
      referenceKind: "member-relative", createdAt: 1, updatedAt: 2});
    expect(() => sessionStore.getCurrentSession("rm_pm")).toThrow(/is missing/);
    sessionStore.clearCurrentSession("rm_pm");
    expect(sessionStore.getCurrentSession("rm_pm")).toBeUndefined();
  });

  it("rejects an invalid member id instead of touching the filesystem", () => {
    expect(() => sessionStore.getCurrentSession("../rm_pm")).toThrow(/Invalid member ID/);
    expect(() => sessionStore.saveCurrentSession("rm/../pm", { runtime: "pi-cli" })).toThrow(/Invalid member ID/);
    expect(() => sessionStore.clearCurrentSession(".")).toThrow(/Invalid member ID/);
  });

  it("ignores malformed retired current.json without overwriting the historical source", () => {
    const path = join(tempDir, "members", "rm_pm", "sessions");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "current.json"), "not json", "utf8");
    sessionStore.saveCurrentSession("rm_pm", { runtime: "pi-cli" });
    expect(sessionStore.getCurrentSession("rm_pm")).toEqual({runtime: "pi-cli"});
    expect(readFileSync(join(path, "current.json"), "utf8")).toBe("not json");
  });
});
