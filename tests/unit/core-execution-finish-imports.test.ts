import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { discoverLegacyInventory } from "../../src/app/upgrade/inventory.js";
import { importLegacyMembers } from "../../src/app/upgrade/records.js";
import { importLegacyConversations } from "../../src/app/upgrade/conversations.js";
import { importLegacyDocuments } from "../../src/app/upgrade/assets.js";
import { importLegacyExecution } from "../../src/app/upgrade/records.js";
import { getDocument } from "../../src/member/assets.js";
import { insertMemberIdentity, getMember } from "../../src/member/identity.js";
import { readStoredRoom, readMemberCursors } from "../../src/chat/conversations.js";
import {  } from "../../src/member/sessions.js";
import { RuntimeRepository } from "../../src/data/repositories/runtime-repository.js";
import { UserCursorRepository } from "../../src/data/repositories/user-cursor-repository.js";
import { type UpgradeImportContext } from "../../src/app/upgrade/inventory.js";

let fixture: ReturnType<typeof coreFixture>;
const member = {id: "mem_one", name: "pm", agentTemplate: "general", global: {}, createdAt: 11, updatedAt: 22,
  unifiedModel: true as const, unifiedExtensions: true as const, scopeOverrides: {}};
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => fixture.close());
function source(files: Record<string, unknown>) {
  const sourceRoot = join(fixture.root, "snapshot");
  for (const [path, value] of Object.entries(files)) {
    const file = join(sourceRoot, path);
    mkdirSync(dirname(file), {recursive: true});
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    utimesSync(file, 123, 123);
  }
  const entries = discoverLegacyInventory(sourceRoot).entries;
  const staged = new Map<string, Buffer>();
  const ctx: UpgradeImportContext = {db: fixture.db, root: fixture.root, sourceRoot, previousDatabase: undefined,
    sourceFiles: entries.map(e => e.path), legacy: true, progress() {},
    stageAsset(path, bytes) { staged.set(path, Buffer.from(bytes)); }};
  return {ctx, entries, staged};
}
function seedMember() { insertMemberIdentity(member, fixture.db); }
const conversationSources = {
  "rooms/r/room.json": {id: "r", name: "Historical room", members: [], createdAt: 1},
  "rooms/r/topics/t/topic.json": {id: "t", roomId: "r", title: "Historical topic", anchorMessageId: "anchor",
    createdBy: "user", createdAt: 2, status: "active", seedMode: "fresh", participants: []},
};

describe("explicit historical identity import, not recurring name/marker repair", () => {
  it("imports identified members, literal persona and room links with original timestamps", async () => {
    const room = {id: "r", name: "Imported", members: ["old display label"], globalMemberIds: [member.id],
      promptLeaderGlobalMemberId: member.id, createdAt: 3};
    const {ctx, entries, staged} = source({"members/mem_one/member.json": member,
      "members/mem_one/member.md": "---\nname: historical-label\n---\n## Persona\nLead well.\n",
      "rooms/r/room.json": room});
    const imported = importLegacyMembers(ctx, entries, "files");
    await importLegacyConversations(ctx, entries);
    expect(getMember(member.id, fixture.db)).toMatchObject(member);
    expect(staged.get("members/mem_one/persona.md")?.toString()).toBe("## Persona\nLead well.\n");
    expect(imported.personas[0].updatedAt).toBe(22);
    fixture.reopen();
    expect(readStoredRoom("r", fixture.db)).toMatchObject(room);
    expect(fixture.db.get("SELECT member_id FROM scopes WHERE id='dm:mem_one'")).toEqual({member_id: member.id});
    // Reimporting identical conversation metadata is idempotent and emits no live work.
    await importLegacyConversations({...ctx, db: fixture.db}, entries);
    expect(fixture.db.all("SELECT * FROM room_members")).toHaveLength(1);
    expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
  });

  it("ignores a stale done marker and preserves an unstamped roster instead of guessing current owners", async () => {
    seedMember();
    const room = {id: "r", name: "Poisoned-era room", members: ["pm"], createdAt: 1};
    const {ctx, entries} = source({"rooms/r/room.json": room,
      ".migrations/member-global-v1.json": {done: true, at: 1}});
    await importLegacyConversations(ctx, entries);
    const repo = fixture.db;
    expect(readStoredRoom("r", repo)).toEqual(room);
    expect(readStoredRoom("r", repo)?.globalMemberIds).toBeUndefined();
    await importLegacyConversations(ctx, entries);
    expect(readStoredRoom("r", repo)).toEqual(room);
    expect(fixture.db.all("SELECT * FROM room_members")).toEqual([]);
  });

  it("retains every historical roster entry when only some names match today's registry", async () => {
    seedMember();
    const room = {id: "r", name: "Partial", members: ["pm", "ghost"], createdAt: 1,
      roomMembers: ["pm", "ghost"].map(name => ({id: `rm_${name}`, roomId: "r", name, sourceAgent: name, createdAt: 2, updatedAt: 3}))};
    const {ctx, entries} = source({"rooms/r/room.json": room});
    await importLegacyConversations(ctx, entries);
    expect(readStoredRoom("r", fixture.db)).toEqual(room);
    expect(fixture.db.all("SELECT * FROM room_members")).toEqual([]);
  });

  it("retires old per-room mainline/principles documents without rehoming by a reused name", async () => {
    seedMember();
    const mainline = "rooms/r/memory/members/rm_pm/mainline.md";
    const principles = "rooms/r/memory/members/rm_pm/principles.md";
    const {ctx, entries} = source({[mainline]: "## Focus\nShip 0.19\n", [principles]: "## Rules\nLead well.\n"});
    const consumed = await importLegacyDocuments(ctx, entries, []);
    expect(consumed.size).toBe(entries.length);
    expect(getDocument(fixture.db, mainline)).toBeUndefined();
    expect(getDocument(fixture.db, principles)).toBeUndefined();
    expect(readFileSync(join(ctx.sourceRoot, mainline), "utf8")).toBe("## Focus\nShip 0.19\n");
    expect(getDocument(fixture.db, "members/mem_one/persona.md")).toBeUndefined();
    expect(getDocument(fixture.db, "members/mem_one/memory/scopes/room-r/mainline.md")).toBeUndefined();
  });
});

describe("historical execution metadata uses stable IDs, explicit imports and source time", () => {
  it("quarantines legacy per-scope sessions while runtime checkpoints keep exact source times", async () => {
    seedMember();
    const session = {runtime: "pi-sdk", sessionId: "historical-sdk-id"};
    const checkpoint = {contractFingerprint: "historical", contractVersion: 4, driftNotified: 5,
      staleMounts: {since: 99, fields: ["mcpServers", "skills"]}};
    const {ctx, entries} = source({
      ...conversationSources,
      "members/mem_one/sessions/current.json": {"room:r": session, "dm:mem_one": session, "topic:t": session},
      "rooms/r/runtime-state.json": {"room:r:mem_one": checkpoint, "room:r:pm": {contractFingerprint: "ambiguous"}},
      "rooms/runtime-state.json": {"topic:t:mem_one": checkpoint},
      "members/mem_one/runtime-state.json": {"dm:mem_one:mem_one": checkpoint},
    });
    const consumed = await importLegacyConversations(ctx, entries);
    importLegacyExecution(ctx, entries);
    // Topic feature retired (fish #19358): topic sources and topic-scoped keys are
    // consumed by the source-retire flow, never imported — no topic scopes,
    // checkpoints or cursors survive an upgrade.
    expect(consumed.has("rooms/r/topics/t/topic.json")).toBe(true);
    fixture.reopen();
    // Member-centric sessions (① A1/A3): legacy per-scope associations are a retired
    // generation — preserved as quarantine records, never resumed as live sessions.
    expect(fixture.db.all("SELECT * FROM current_sessions")).toEqual([]);
    expect(fixture.db.all("SELECT source_key,reason FROM execution_import_ambiguities WHERE domain='session' ORDER BY source_key"))
      .toEqual([{source_key:"dm:mem_one",reason:"retired-scope-session-generation"},
        {source_key:"room:r",reason:"retired-scope-session-generation"}]);
    // ① B8 / C3: checkpoints converge to the member — the room and DM sources
    // collapse into one member-keyed row with the exact source timestamp.
    expect(new RuntimeRepository(fixture.db).get(member.id)).toEqual(checkpoint);
    expect(fixture.db.get("SELECT 1 FROM scopes WHERE kind='topic'")).toBeUndefined();
    expect(fixture.db.all("SELECT member_id, updated_at FROM runtime_checkpoints")).toEqual([{member_id: member.id, updated_at: 123000}]);
    expect(fixture.db.all("SELECT source_key,reason,record_json FROM execution_import_ambiguities WHERE domain='runtime'")).toEqual([
      {source_key: "room:r:pm", reason: "unresolved-runtime-owner", record_json: JSON.stringify({contractFingerprint: "ambiguous"})}]);
  });

  it("aborts explicit malformed current.json import rather than treating corruption as empty", () => {
    seedMember();
    const {ctx, entries} = source({"members/mem_one/sessions/current.json": "{ not json"});
    expect(() => importLegacyExecution(ctx, entries)).toThrow();
    expect(fixture.db.all("SELECT * FROM current_sessions")).toEqual([]);
    expect(readFileSync(join(ctx.sourceRoot, entries[0].path), "utf8")).toBe("{ not json");
  });

  it("consumes retired background task sources without import or replay", () => {
    seedMember();
    const taskId = "bgt-00000000-0000-4000-8000-000000000001";
    const path = `members/mem_one/background-tasks/2026-09-09/${taskId}/task.json`;
    const task = {taskId, memberId: member.id, scopeId: "dm:mem_one", kind: "recall", sessionMode: "fork", prompt: "literal prompt",
      snapshot: {model: "p/m", credentialId: "old-account", thinkingLevel: "high"}, status: "done",
      startedAt: "2026-09-09T01:00:00Z", endedAt: "2026-09-09T02:00:00Z", result: " exact answer\r\n", error: null,
      sessionDir: "/forged/path", parentSessionRef: "/historical/sdk/session.jsonl"};
    const {ctx, entries} = source({[path]: task});
    const consumed = importLegacyExecution(ctx, entries);
    importLegacyExecution(ctx, entries);
    expect(consumed.has(path)).toBe(true);
    expect(fixture.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_tasks'")).toBeUndefined();
    expect(fixture.db.all("SELECT * FROM outbox")).toEqual([]);
  });

  it("preserves user/member cursor kinds, timestamps and unresolved historical actor keys separately", async () => {
    seedMember();
    const user = {messageId: "historical-message", seq: 0, updatedAt: 77};
    const {ctx, entries} = source({...conversationSources, "rooms/r/cursors.json": {pm: "label-position", mem_one: "id-position"},
      "user-read-cursors.json": {"room:r": user, "dm:mem_one": {...user, seq: null}, "topic:t": {...user, seq: 9}}});
    await importLegacyConversations(ctx, entries);
    fixture.reopen();
    expect(readMemberCursors("r", fixture.db)).toEqual({pm: "label-position", mem_one: "id-position"});
    // Retired topic cursor keys are consumed by the retire flow, never imported.
    expect(new UserCursorRepository(fixture.db).list()).toEqual({"room:r": user, "dm:mem_one": {...user, seq: null}});
    expect(fixture.db.get("SELECT 1 FROM read_cursors WHERE scope_id LIKE 'topic:%'")).toBeUndefined();
    expect(fixture.db.all("SELECT updated_at FROM read_cursors WHERE kind='member'")).toEqual([{updated_at: 123000}, {updated_at: 123000}]);
  });
});
