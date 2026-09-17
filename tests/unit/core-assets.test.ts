import { writeConfig } from "../../src/config/settings.js";
import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { dirname, join } from "node:path";

// Keep real filesystem IO; expose only a mockable module surface for failure injection.
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

// The npm launcher sets BOSSMODE_DIR before any application import. No real knowledge inputs.
const root = process.env.BOSSMODE_DIR!;
mkdirSync(join(root, "knowledge"), { recursive: true });
mkdirSync(join(root, "memory", "projects"), { recursive: true });
const { createLegacyMemberStorageFixture } = await import("../helpers/legacy-member-storage.js");
const { applyStorageMigrations, bindDatabase, getDatabase, openDatabase } = await import("../../src/data/database.js");
const baseStorageMigration = getMigration("core-base-v1");
const settingsMigration = getMigration("core-settings-v1");
const membersMigration = getMigration("core-members-v1");

const { getDefaultConfig } = await import("../../src/config/settings.js");
const assetsMigration = getMigration("core-assets-v1");
const { getDocument, listDocumentHistory, importDocument, documentContentMeta, documentSnapshotPath, validateDocumentPath, commitDocumentRevision } = await import("../../src/member/assets.js");
const { readPrinciples, writePrinciples, editPrinciples, readPrinciplesWithBudget, AssetBudgetError } = await import("../../src/member/memory/principles-store.js");
const { readMainline, writeMainline, editMainline } = await import("../../src/chat/mainline-store.js");
const { readMemoryLayerInfo, readMemoryLayer, writeMemoryLayer, editMemoryLayer, ensureMemorySkeleton } = await import("../../src/member/memory/member-memory-store.js");
const { saveDocument } = await import("../../src/member/assets.js");
import type { Database } from "../../src/data/database.js";
import type { DocumentIdentity, DocumentImport } from "../../src/member/assets.js";

let db: Database;
const member = "mem_one";
const room = "room-one";
const user = { type: "user" as const };
const actor = { type: "member" as const, memberId: member, name: "original-name" };
const roomPath = `rooms/${room}/memory/room-principles.md`;
const personaPath = `members/${member}/persona.md`;
const roomIdentity: DocumentIdentity = { path: roomPath, layer: "principles", scopeId: room };
function write(path: string, content: string | Uint8Array): void { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
function current(path: string): string { return readFileSync(join(root, path), "utf8"); }
function stageAsset(path: string, bytes: Uint8Array): void {
  validateDocumentPath(path);
  if (existsSync(join(root, path))) { if (!readFileSync(join(root, path)).equals(Buffer.from(bytes))) throw new Error("stage conflict"); return; }
  write(path, bytes);
}
function ready(bind = true): Database {
  // Frozen historical schema fixture, closed before the explicit core context opens.
  createLegacyMemberStorageFixture(join(root, "bossmode.db"));
  const database = openDatabase(join(root, "bossmode.db"));
  applyStorageMigrations(database, [baseStorageMigration, membersMigration, settingsMigration, assetsMigration]);
  writeConfig(getDefaultConfig(), database);
  database.run("INSERT INTO scopes VALUES (?, 'room', ?, NULL)", room, room);
  database.run("INSERT INTO scopes VALUES (?, 'dm', NULL, ?)", `dm:${member}`, member);
  if (bind) bindDatabase(database);
  return database;
}
beforeEach(() => {
  db = ready();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  for (const entry of readdirSync(root)) if (entry !== ".bossmode-test-sandbox") rmSync(join(root, entry), { force: true, recursive: true });
  mkdirSync(join(root, "knowledge"), { recursive: true });
  mkdirSync(join(root, "memory", "projects"), { recursive: true });
});

it("requires explicit binding without opening or migrating from a getter or writer", () => {
  db.close();
  const files = readdirSync(root);
  expect(() => readPrinciples(room, "room")).toThrow("not initialized");
  expect(() => readMemoryLayerInfo(member, "persona")).toThrow("not initialized");
  expect(() => writeMemoryLayer(member, "persona", "new", user)).toThrow("not initialized");
  expect(readdirSync(root)).toEqual(files);
  expect(existsSync(join(root, "members"))).toBe(false);
});

it("returns original missing-document DTOs without DB writes", () => {
  expect(readPrinciples(room, "room")).toEqual({ content: "", revision: 0, ...documentContentMeta(""),
    updatedAt: undefined, updatedBy: undefined, updatedByMemberId: undefined, updatedByName: undefined });
  expect(readMainline(room, member).revision).toBe(0);
  expect(readMemoryLayerInfo(member, "persona")).toMatchObject({ content: "", revision: 0, updatedAt: null, updatedBy: null });
  expect(db.all("SELECT * FROM memory_documents")).toEqual([]);
});

it("persists normalized metadata and immutable Markdown snapshots, never SQL body blobs", () => {
  const bytes = "\uFEFF## Rules\r\n保留 😀\r\n\t \n";
  const first = writePrinciples({ roomId: room, scope: "room", content: bytes, actor, reason: " initial " });
  const second = editPrinciples({ roomId: room, scope: "room", oldText: "保留", newText: "edited", actor: user, reason: " correction " });
  expect(first.revision).toBe(1);
  expect(first.contentLength).toBe(bytes.length);
  expect(second.revision).toBe(2);
  expect(readPrinciples(room, "room")).toEqual(second);
  const events = listDocumentHistory(db, roomPath);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ revision: 1, actorMemberId: member, actorName: "original-name", reason: "initial", operation: "write", contentLength: bytes.length });
  expect(events[1]).toMatchObject({ revision: 2, actorType: "user", actorMemberId: undefined, reason: "correction", operation: "edit" });
  expect(readFileSync(join(root, events[0].snapshotPath))).toEqual(Buffer.from(bytes));
  expect(events[0].snapshotBytes).toBe(Buffer.byteLength(bytes));
  expect(events[0].snapshotPath).toBe(documentSnapshotPath(roomPath, first.contentHash));
  for (const table of ["memory_documents", "memory_document_history"]) {
    const columns = db.all<{ name: string; type: string }>(`PRAGMA table_info(${table})`);
    expect(columns.some(c => c.name === "content" || c.type === "BLOB" || c.name.endsWith("json"))).toBe(false);
  }
  db.close(); db = openDatabase(join(root, "bossmode.db")); bindDatabase(db);
  expect(readPrinciples(room, "room")).toEqual(second);
  expect(listDocumentHistory(db, roomPath)).toEqual(events);
});

it("never consults or updates retained legacy metadata/history", () => {
  write(roomPath, "existing");
  write(`rooms/${room}/memory/principles-meta.json`, JSON.stringify({ room: { revision: 900 } }));
  write(`rooms/${room}/memory/principles-history.jsonl`, "not json\n");
  write(`rooms/${room}/memory/mainline-meta.json`, "not json\n");
  write(`rooms/${room}/memory/mainline-history.jsonl`, "not json\n");
  write(`members/${member}/memory/persona-history.jsonl`, "not json\n");
  expect(readPrinciples(room, "room").revision).toBe(0);
  expect(readMemoryLayerInfo(member, "persona").revision).toBe(0);
  expect(writePrinciples({ roomId: room, scope: "room", content: "next", actor: user, reason: "r" }).revision).toBe(1);
  writeMainline({ roomId: room, memberId: member, content: "main", actor, reason: "r" });
  writeMemoryLayer(member, "persona", "persona", user);
  expect(current(`rooms/${room}/memory/principles-meta.json`)).toBe(JSON.stringify({ room: { revision: 900 } }));
  for (const path of [`rooms/${room}/memory/principles-history.jsonl`, `rooms/${room}/memory/mainline-meta.json`,
    `rooms/${room}/memory/mainline-history.jsonl`, `members/${member}/memory/persona-history.jsonl`]) expect(current(path)).toBe("not json\n");
});

it("preserves user/global, member, room and DM ownership with no fabricated IDs", () => {
  writeMemoryLayer(member, "persona", "global", user);
  expect(getDocument(db, personaPath)).toMatchObject({ memberId: member, scopeId: undefined, meta: { updatedBy: "user", updatedByMemberId: undefined } });
  for (const [scopeId, dir, sqlScope] of [[`room:${room}`, `room-${room}`, room], [`dm:${member}`, "dm", `dm:${member}`]]) {
    for (const layer of ["principles", "mainline"] as const) {
      writeMemoryLayer(member, layer, `text ${scopeId}`, actor, { scopeId });
      expect(readMemoryLayerInfo(member, layer, scopeId).revision).toBe(1);
      expect(getDocument(db, `members/${member}/memory/scopes/${dir}/${layer}.md`)).toMatchObject({ memberId: member, scopeId: sqlScope, layer });
    }
  }
  writePrinciples({ roomId: room, scope: "member", memberId: member, content: "room-member", actor, reason: "r" });
  expect(getDocument(db, `rooms/${room}/memory/members/${member}/principles.md`)).toMatchObject({ memberId: member, scopeId: room });
  // An asset with genuinely global ownership needs no fake room/member row.
  importDocument(db, { stageAsset }, { identity: { path: "memory/user/principles.md", layer: "principles" }, currentContent: "", metadataSource: "file", history: [] });
  expect(getDocument(db, "memory/user/principles.md")).toMatchObject({ memberId: undefined, scopeId: undefined });
});

it("keeps exact mainline and member-edit behavior and does not touch skeletons or Pi files", () => {
  const pi = `members/${member}/sessions/pi-session.jsonl`;
  write(pi, "{\"type\":\"session\",\"id\":\"unchanged\"}\n");
  ensureMemorySkeleton(member, `room:${room}`);
  expect(readMemoryLayer(member, "persona").content).toBe("");
  expect(db.all("SELECT * FROM memory_documents")).toEqual([]);
  writeMemoryLayer(member, "persona", "alpha 😀\r\n", actor);
  editMemoryLayer(member, "persona", "alpha", "beta", user, { reason: "source" });
  expect(readMemoryLayerInfo(member, "persona")).toMatchObject({ content: "beta 😀\r\n", revision: 2, contentLength: 9, updatedBy: "user" });
  const m = writeMainline({ roomId: room, memberId: member, content: "## Focus\r\nalpha\r\n", actor, reason: " initial " });
  expect(editMainline({ roomId: room, memberId: member, oldText: "alpha", newText: "beta", actor: user, reason: "edit" }).revision).toBe(2);
  expect(readMainline(room, member).content).toBe(m.content.replace("alpha", "beta"));
  expect(current(pi)).toBe("{\"type\":\"session\",\"id\":\"unchanged\"}\n");
  expect(() => editMemoryLayer(member, "persona", "", "", actor)).toThrow("required");
  expect(() => editMainline({ roomId: room, memberId: member, oldText: "missing", newText: "", actor, reason: "r" })).toThrow("not found");
});

it("uses UTF-16 budgets, exact limits, reason validation and unchanged over-budget bodies", () => {
  writePrinciples({ roomId: room, scope: "room", content: "😀".repeat(4000), actor, reason: "r" });
  expect(readPrinciplesWithBudget(room, "room").budget).toMatchObject({ usage: 8000, overLimit: false });
  expect(() => writePrinciples({ roomId: room, scope: "room", content: "😀".repeat(4001), actor, reason: "r" })).toThrow(AssetBudgetError);
  expect(() => writeMainline({ roomId: room, memberId: member, content: "x", actor, reason: " " })).toThrow("reason is required");
  for (const layer of ["persona", "mainline", "principles"] as const) {
    const scopeId = layer === "persona" ? undefined : `room:${room}`;
    writeMemoryLayer(member, layer, "x".repeat(4000), actor, { scopeId });
    expect(() => writeMemoryLayer(member, layer, "x".repeat(4001), actor, { scopeId })).toThrow(AssetBudgetError);
    expect(readMemoryLayerInfo(member, layer, scopeId).revision).toBe(1);
  }
  write(roomPath, "legacy".repeat(2000));
  expect(readPrinciplesWithBudget(room, "room").budget.overLimit).toBe(true);
  expect(readPrinciples(room, "room").content.length).toBe(12000);
  writePrinciples({ roomId: room, scope: "room", content: "curated", actor: user, reason: "curation" });
  expect(readPrinciples(room, "room").revision).toBe(2);
});

it("rejects ownership collisions and absent shared scope references", () => {
  writeMemoryLayer(member, "principles", "first", actor, { scopeId: `dm:${member}` });
  expect(() => readMemoryLayerInfo(member, "principles", "dm:other")).toThrow("ownership mismatch");
  expect(() => writeMemoryLayer(member, "principles", "second", actor, { scopeId: "dm:other" })).toThrow("ownership mismatch");
  expect(() => writeMemoryLayer(member, "mainline", "missing", actor, { scopeId: "room:missing-room" })).toThrow();
  expect(getDocument(db, `members/${member}/memory/scopes/room-missing-room/mainline.md`)).toBeUndefined();
  expect(existsSync(join(root, `members/${member}/memory/scopes/room-missing-room/mainline.md`))).toBe(false);
});

it("deduplicates identical snapshots but never overwrites different retained content", () => {
  const args = { roomId: room, scope: "room" as const, content: "same", actor, reason: "r" };
  writePrinciples(args); writePrinciples(args);
  const events = listDocumentHistory(db, roomPath);
  expect(events[0].snapshotPath).toBe(events[1].snapshotPath);
  const hash = documentContentMeta("third").contentHash;
  write(documentSnapshotPath(roomPath, hash), "conflicting retained body");
  expect(() => writePrinciples({ ...args, content: "third" })).toThrow("snapshot content conflict");
  expect(readPrinciples(room, "room").revision).toBe(2);
  expect(current(roomPath)).toBe("same");
  expect(current(documentSnapshotPath(roomPath, hash))).toBe("conflicting retained body");
});

it("does not commit history if snapshot/current preparation fails", () => {
  const hash = documentContentMeta("x").contentHash;
  const snapshot = documentSnapshotPath(roomPath, hash);
  mkdirSync(join(root, snapshot), { recursive: true });
  expect(() => writePrinciples({ roomId: room, scope: "room", content: "x", actor, reason: "r" })).toThrow("Invalid document asset");
  expect(getDocument(db, roomPath)).toBeUndefined();
  expect(existsSync(join(root, roomPath))).toBe(false);
  rmSync(join(root, snapshot), { recursive: true });
  mkdirSync(join(root, roomPath));
  expect(() => saveDocument(roomIdentity, "x", actor, { reason: "r", operation: "write" })).toThrow("Invalid document asset");
  expect(listDocumentHistory(db, roomPath)).toEqual([]);
});

describe("snapshot retry durability", () => {
  for (const failure of ["link", "mkdir"] as const) {
    it(`syncs matching snapshots and the data-root directory chain before history after failed ${failure}`, () => {
      const content = "retry exact bytes\r\n😀";
      const snapshot = join(root, documentSnapshotPath(roomPath, documentContentMeta(content).contentHash));
      // Fail deep in the chain, leaving both existing ancestors and the new entry visible.
      const createdDirectory = dirname(dirname(snapshot));
      const required = [snapshot];
      for (let path = dirname(snapshot); ; path = dirname(path)) {
        required.push(path);
        if (path === root) break;
      }
      const events: string[] = [];
      const descriptors = new Map<number, string>();
      const realOpen = fs.openSync, realSync = fs.fsyncSync, realLink = fs.linkSync, realMkdir = fs.mkdirSync;
      let failSync: string | undefined;
      vi.spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        const fd = realOpen(path, flags, mode);
        descriptors.set(fd, String(path));
        return fd;
      });
      const link = vi.spyOn(fs, "linkSync").mockImplementation((existing, path) => {
        realLink(existing, path);
        if (failure === "link" && String(path) === snapshot) failSync = dirname(snapshot);
      });
      const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
        const result = realMkdir(path, options);
        if (failure === "mkdir" && String(path) === createdDirectory) failSync = dirname(createdDirectory);
        return result;
      }) as typeof fs.mkdirSync);
      const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
        const path = descriptors.get(fd)!;
        if (path === failSync) throw new Error(`injected ${failure} parent fsync failure`);
        realSync(fd);
        events.push(path);
      });
      const chmod = vi.spyOn(fs, "chmodSync");
      const transaction = db.transaction.bind(db);
      vi.spyOn(db, "transaction").mockImplementation(fn => {
        // All required successful fsyncs must precede even the history transaction's BEGIN.
        for (const path of required) expect(events, `missing fsync: ${path}`).toContain(path);
        expect(events).not.toContain(dirname(root));
        events.push("history begin");
        const result = transaction(fn);
        events.push("history committed");
        return result;
      });
      const save = () => saveDocument(roomIdentity, content, user, { operation: "write", reason: "retry" });
      expect(save).toThrow(`injected ${failure} parent fsync failure`);
      expect(listDocumentHistory(db, roomPath)).toEqual([]);
      expect(getDocument(db, roomPath)).toBeUndefined();
      expect(existsSync(failure === "link" ? snapshot : createdDirectory)).toBe(true);

      // An identical retry must not mistake the leftover visible entry for a durable one.
      events.length = 0;
      failSync = undefined;
      link.mockImplementation(realLink);
      mkdir.mockImplementation(realMkdir);
      expect(save().revision).toBe(1);
      expect(events.at(-1)).toBe("history committed");
      expect(listDocumentHistory(db, roomPath)).toHaveLength(1);
      expect(readFileSync(snapshot)).toEqual(Buffer.from(content));
      expect(chmod).not.toHaveBeenCalled();

      // Existing matching paths must still fail closed if their file or any ancestor cannot sync.
      for (const failingPath of required) {
        events.length = 0;
        failSync = failingPath;
        expect(save).toThrow(`injected ${failure} parent fsync failure`);
        expect(events).not.toContain("history begin");
        expect(listDocumentHistory(db, roomPath)).toHaveLength(1);
      }
      expect(sync).toHaveBeenCalled();
    });
  }
});

it("rejects symlink/traversal assets without modifying the target", () => {
  write("memory/target.md", "outside document");
  mkdirSync(dirname(join(root, roomPath)), { recursive: true });
  symlinkSync(join(root, "memory/target.md"), join(root, roomPath));
  expect(() => saveDocument(roomIdentity, "new", user, { operation: "write", reason: "r" })).toThrow("Invalid document asset");
  expect(current("memory/target.md")).toBe("outside document");
  expect(() => validateDocumentPath("members/../memory/a.md")).toThrow("Invalid document");
  expect(() => validateDocumentPath("/members/a.md")).toThrow("Invalid document");
  expect(() => validateDocumentPath("members/a.jsonl")).toThrow("Invalid document");
});

it("rolls back SQL/history and restores exact prior bytes on a commit failure", () => {
  writePrinciples({ roomId: room, scope: "room", content: "old\r\n😀", actor, reason: "r" });
  const before = readPrinciples(room, "room");
  db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON memory_document_history BEGIN SELECT RAISE(ABORT, 'injected history failure'); END");
  expect(() => writePrinciples({ roomId: room, scope: "room", content: "new", actor: user, reason: "r" })).toThrow("injected history failure");
  expect(readPrinciples(room, "room")).toEqual(before);
  expect(listDocumentHistory(db, roomPath)).toHaveLength(1);
  // Prepared but unreferenced assets are retained; not advertised as saved revisions.
  expect(current(documentSnapshotPath(roomPath, documentContentMeta("new").contentHash))).toBe("new");
});

it("removes a new current body when its first metadata commit fails", () => {
  db.exec("CREATE TRIGGER fail_document BEFORE INSERT ON memory_documents BEGIN SELECT RAISE(ABORT, 'injected document failure'); END");
  expect(() => writeMemoryLayer(member, "persona", "new", actor)).toThrow("injected document failure");
  expect(existsSync(join(root, personaPath))).toBe(false);
  expect(getDocument(db, personaPath)).toBeUndefined();
  expect(listDocumentHistory(db, personaPath)).toEqual([]);
});

describe("pure startup import", () => {
  it("uses explicit unbound DB/context, stages historical Markdown and preserves revisions/audit exactly", () => {
    db.close(); db = openDatabase(join(root, "bossmode.db")); // deliberately not bound
    expect(() => getDatabase()).toThrow("not initialized");
    const old = "old\r\n😀";
    const latest = "manually edited current body";
    write(roomPath, latest);
    const meta = { revision: 17, ...documentContentMeta(latest), updatedAt: 123, updatedBy: "user" as const };
    const stageCalls: string[] = [];
    importDocument(db, { stageAsset(path, bytes) { stageCalls.push(path); stageAsset(path, bytes); } }, {
      identity: roomIdentity, currentContent: latest, metadataSource: "file", meta,
      history: [{ revision: 4, ts: 10, content: old, actorType: "member", actorMemberId: "deleted-member", actorName: "historical-name", operation: "edit", reason: "source", contentHash: "legacyhash", contentLength: 99 },
        { revision: 4, ts: 20, content: "", actorType: "user", reason: "empty revision" }],
    });
    expect(current(roomPath)).toBe(latest);
    expect(getDocument(db, roomPath)?.meta).toEqual({ ...meta, updatedByMemberId: undefined, updatedByName: undefined });
    const history = listDocumentHistory(db, roomPath);
    expect(history.map(h => h.ordinal)).toEqual([1, 2]);
    expect(history.map(h => h.revision)).toEqual([4, 4]);
    expect(history[0]).toMatchObject({ ts: 10, actorMemberId: "deleted-member", actorName: "historical-name", operation: "edit", reason: "source", contentHash: "legacyhash", contentLength: 99, snapshotHash: documentContentMeta(old).contentHash });
    expect(current(stageCalls[0])).toBe(old);
    expect(current(stageCalls[1])).toBe("");
    bindDatabase(db);
    expect(writePrinciples({ roomId: room, scope: "room", content: "next", actor: user, reason: "r" }).revision).toBe(18);
    expect(listDocumentHistory(db, roomPath).at(-1)).toMatchObject({ ordinal: 3, revision: 18 });
  });

  it("derives member-memory revisions from event count and current hashes from current bytes", () => {
    const content = "current different from history";
    write(personaPath, content);
    importDocument(db, { stageAsset }, { identity: { path: personaPath, memberId: member, layer: "persona" }, currentContent: content, metadataSource: "history",
      history: [{ content: "one", contentHash: documentContentMeta("one").contentHash.slice(0, 16), ts: 1 },
        { content: "two", actorType: "member", actorMemberId: member, actorName: "old name", ts: 2 }] });
    expect(readMemoryLayerInfo(member, "persona")).toMatchObject({ revision: 2, updatedByMemberId: member, updatedByName: "old name", updatedAt: 2, ...documentContentMeta(content) });
    expect(listDocumentHistory(db, personaPath)[0].contentHash).toHaveLength(16);
    writeMemoryLayer(member, "persona", "three", user);
    expect(readMemoryLayerInfo(member, "persona").revision).toBe(3);
  });

  it("never reports a missing snapshot or failed staging/SQL import as saved", () => {
    const input: DocumentImport = { identity: roomIdentity, currentContent: "current", metadataSource: "file", history: [{ content: "snapshot" }] };
    expect(() => importDocument(db, { stageAsset() { throw new Error("injected stage failure"); } }, input)).toThrow("injected stage failure");
    expect(getDocument(db, roomPath)).toBeUndefined();
    expect(() => importDocument(db, { stageAsset }, { ...input, history: [{} as any] })).toThrow("Missing historical document body");
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON memory_document_history BEGIN SELECT RAISE(ABORT, 'injected import failure'); END");
    expect(() => importDocument(db, { stageAsset }, input)).toThrow("injected import failure");
    expect(getDocument(db, roomPath)).toBeUndefined();
    expect(listDocumentHistory(db, roomPath)).toEqual([]);
    db.exec("DROP TRIGGER fail_import");
    importDocument(db, { stageAsset }, input);
    expect(() => importDocument(db, { stageAsset }, input)).toThrow("already imported");
    expect(listDocumentHistory(db, roomPath)).toHaveLength(1);
  });
});

it("preserves revision zero for absent room metadata despite historical writes", () => {
  write(roomPath, "current");
  importDocument(db, { stageAsset }, { identity: roomIdentity, currentContent: "current", metadataSource: "file", history: [{ content: "old", revision: 8, ts: 3, actorType: "user" }] });
  expect(readPrinciples(room, "room")).toMatchObject({ revision: 0, updatedAt: undefined, ...documentContentMeta("current") });
  expect(listDocumentHistory(db, roomPath)[0].revision).toBe(8);
  expect(writePrinciples({ roomId: room, scope: "room", content: "next", actor, reason: "r" }).revision).toBe(1);
});

it("rejects stale revision commits without changing metadata or history", () => {
  const saved = writePrinciples({ roomId: room, scope: "room", content: "first", actor, reason: "r" });
  const event = listDocumentHistory(db, roomPath)[0];
  expect(() => commitDocumentRevision(db, roomIdentity, { ...saved, revision: 2 }, { ...event, revision: 2 }, 0)).toThrow("revision changed");
  expect(getDocument(db, roomPath)?.meta.revision).toBe(1);
  expect(listDocumentHistory(db, roomPath)).toHaveLength(1);
});

it.each(["managed", "raw"])("rejects live file publication inside an enclosing %s transaction", mode => {
  write(roomPath, "before");
  const publish = () => saveDocument(roomIdentity, "must not publish", user, { operation: "write", reason: "guard" });
  if (mode === "managed") expect(() => db.transaction(publish)).toThrow(/enclosing/);
  else {
    db.exec("BEGIN");
    try { expect(publish).toThrow(/enclosing/); }
    finally { db.exec("ROLLBACK"); }
  }
  expect(current(roomPath)).toBe("before");
  expect(getDocument(db, roomPath)).toBeUndefined();
  expect(existsSync(join(root, "rooms", room, "memory", "history"))).toBe(false);
});
