import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareCoreStorage } from "../../src/storage/core-startup.js";
import { bindDatabase, type Database } from "../../src/storage/database.js";
import { commitDocumentRevision, documentContentMeta, getDocument, listDocumentHistory } from "../../src/storage/document-repository.js";
import { MemberArchivesRepository } from "../../src/storage/repositories/member-archives.js";
import { getDefaultConfig } from "../../src/shared/config.js";
import { catalogFromFiredExport, importMemberFromArchive, type ArchiveImportHooks } from "../../src/workspace/member-archive.js";
import { createMember, createMemberWithPersona, getMember, updateMemberIdentity } from "../../src/workspace/member-registry.js";
import { readMemberProfile } from "../../src/workspace/member-profile.js";
import { writeMemoryLayer } from "../../src/workspace/member-memory-store.js";

const root = process.env.BOSSMODE_DIR!;
const literal = "\uFEFF---\r\nname: Not identity\r\n---\r\n内 文 😀 `literal`  \r\n\t\n";
let db: Database | undefined;
const personaPath = (id: string) => `members/${id}/persona.md`;

beforeEach(() => { mkdirSync(join(root, "knowledge"), { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });
async function start() {
  const result = await prepareCoreStorage({ root, initialConfig: getDefaultConfig(), bundledCatalog: [] });
  db = result.db;
  bindDatabase(db);
  return result;
}
function archiveSource(body: string) {
  const archivePath = "backups/birth-import";
  mkdirSync(join(root, archivePath), { recursive: true });
  writeFileSync(join(root, archivePath, "persona.md"), body, "utf8");
  new MemberArchivesRepository(db!).importCatalog(catalogFromFiredExport({ archivePath,
    member: { id: "mem_historical", name: "Archived", agentTemplate: "general", global: {} },
    persona: { path: `${archivePath}/persona.md`, format: "plain", hasContent: !!body.trim() },
  }));
  return archivePath;
}
function assertPersona(id: string, body: string, revision = 0) {
  expect(readFileSync(join(root, personaPath(id)))).toEqual(Buffer.from(body, "utf8"));
  expect(getDocument(db!, personaPath(id))).toMatchObject({
    path: personaPath(id), layer: "persona", memberId: id, scopeId: undefined,
    meta: { revision, ...documentContentMeta(body) },
  });
}

it.each(["", literal])("ordinary startup reopens a newly born contact with literal persona %j", async persona => {
  expect((await start()).migrated).toBe(true);
  const member = persona ? createMemberWithPersona({ name: "言 实" }, persona) : createMember({ name: "Empty" });
  // Close the creation connection. Exercise the real startup guard, not just a raw DB reopen or getter.
  db!.close();
  expect((await start()).migrated).toBe(false);
  expect(getMember(member.id)).toEqual(member);
  assertPersona(member.id, persona);
  expect(getDocument(db!, personaPath(member.id))!.meta).toEqual({ revision: 0, ...documentContentMeta(persona),
    updatedAt: undefined, updatedBy: undefined, updatedByMemberId: undefined, updatedByName: undefined });
  expect(listDocumentHistory(db!, personaPath(member.id))).toEqual([]);
  expect(existsSync(join(root, "members", member.id, "history"))).toBe(false);
  expect(db!.get("SELECT kind, member_id FROM scopes WHERE id=?", `dm:${member.id}`)).toEqual({ kind: "dm", member_id: member.id });
  expect(db!.get("SELECT 1 FROM workspace_registries WHERE member_id=?", member.id)).toBeDefined();
  expect(db!.get("SELECT 1 FROM ssh_credentials WHERE member_id=?", member.id)).toBeDefined();
});

it("commits initial ownership before returning, preserves it across profile updates, and starts real revisions at one", async () => {
  await start();
  const member = createMemberWithPersona({ name: "Before", title: "Old title" }, literal);
  // SQL assertions precede any profile/document getters, which must never repair birth metadata.
  const initial = db!.get("SELECT * FROM memory_documents WHERE path=?", personaPath(member.id));
  expect(initial).toMatchObject({ member_id: member.id, layer: "persona", scope_id: null, revision: 0,
    content_hash: documentContentMeta(literal).contentHash, content_length: literal.length });
  updateMemberIdentity(member.id, { name: "After", title: "New title" });
  expect(db!.get("SELECT * FROM memory_documents WHERE path=?", personaPath(member.id))).toEqual(initial);
  expect(readMemberProfile(member.id).body).toBe(literal);
  expect(listDocumentHistory(db!, personaPath(member.id))).toEqual([]);
  for (const content of ["", literal + "edited\r\n"]) {
    writeMemoryLayer(member.id, "persona", content, { type: "user" }, { reason: "profile edit" });
  }
  const history = listDocumentHistory(db!, personaPath(member.id));
  expect(history.map(event => [event.ordinal, event.revision, event.reason])).toEqual([[1, 1, "profile edit"], [2, 2, "profile edit"]]);
  for (const [index, body] of ["", literal + "edited\r\n"].entries()) {
    expect(readFileSync(join(root, history[index].snapshotPath))).toEqual(Buffer.from(body, "utf8"));
  }
  db!.close(); await start();
  expect(getMember(member.id)).toMatchObject({ name: "After", title: "New title" });
  assertPersona(member.id, literal + "edited\r\n", 2);
  expect(listDocumentHistory(db!, personaPath(member.id))).toEqual(history);
});

it.each(["", " \t\r\n", literal])("archive birth retains literal bytes and only records an actual import revision: %j", async body => {
  await start();
  const archivePath = archiveSource(body);
  const commitPersona = vi.fn<ArchiveImportHooks["commitPersona"]>((tx, prepared) => {
    expect(() => tx.assertOutsideTransaction()).toThrow(/enclosing/);
    expect(getDocument(tx, prepared.identity.path)?.meta.revision).toBe(0);
    commitDocumentRevision(tx, prepared.identity, prepared.meta, prepared.event, 0);
  });
  const member = importMemberFromArchive({ archivePath, name: "Imported" }, body.trim() ? { commitPersona } : undefined);
  const revision = body.trim() ? 1 : 0;
  expect(commitPersona).toHaveBeenCalledTimes(revision);
  expect(member.id).not.toBe("mem_historical");
  db!.close(); expect((await start()).migrated).toBe(false);
  assertPersona(member.id, body, revision);
  const history = listDocumentHistory(db!, personaPath(member.id));
  expect(history).toHaveLength(revision);
  if (revision) {
    expect(history[0]).toMatchObject({ ordinal: 1, revision: 1, reason: "importFromArchive", actorType: "user" });
    expect(readFileSync(join(root, history[0].snapshotPath))).toEqual(Buffer.from(body, "utf8"));
  }
  expect(readFileSync(join(root, archivePath, "persona.md"))).toEqual(Buffer.from(body, "utf8"));
  writeMemoryLayer(member.id, "persona", "next", { type: "user" });
  assertPersona(member.id, "next", revision + 1);
});

it.each(["memory_documents", "memory_document_history"])("rolls back identity, metadata and owned assets when %s insertion fails", async table => {
  await start();
  const survivor = createMemberWithPersona({ name: "Keep" }, literal);
  const archivePath = archiveSource(literal);
  const tables = ["members", "scopes", "workspace_registries", "ssh_credentials", "memory_documents", "memory_document_history"];
  const before = tables.map(name => db!.all(`SELECT * FROM ${name}`));
  db!.exec(`CREATE TRIGGER fail_birth BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'birth metadata failure'); END`);
  expect(() => table === "memory_documents"
    ? createMemberWithPersona({ name: "Failed" }, literal)
    : importMemberFromArchive({ archivePath, name: "Failed" }, {
      commitPersona: (tx, prepared) => commitDocumentRevision(tx, prepared.identity, prepared.meta, prepared.event, 0),
    })).toThrow("birth metadata failure");
  for (const [index, name] of tables.entries()) expect(db!.all(`SELECT * FROM ${name}`)).toEqual(before[index]);
  expect(readdirSync(join(root, "members"))).toEqual([survivor.id]);
  expect(readFileSync(join(root, archivePath, "persona.md"))).toEqual(Buffer.from(literal, "utf8"));
  db!.exec("DROP TRIGGER fail_birth");
  db!.close(); expect((await start()).migrated).toBe(false);
  assertPersona(survivor.id, literal);
});

it("prepares body and snapshots outside SQL and removes them if a later metadata hook fails", async () => {
  await start();
  expect(() => createMemberWithPersona({ name: "Hook failure" }, literal, record => {
    db!.assertOutsideTransaction();
    expect(readFileSync(join(root, personaPath(record.id)))).toEqual(Buffer.from(literal, "utf8"));
    expect(db!.get("SELECT 1 FROM members WHERE id=?", record.id)).toBeUndefined();
    const snapshot = join(root, "members", record.id, "history", "persona");
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(join(snapshot, "prepared.md"), literal, "utf8");
    return tx => {
      expect(() => tx.assertOutsideTransaction()).toThrow(/enclosing/);
      expect(getDocument(tx, personaPath(record.id))?.meta.revision).toBe(0);
      throw new Error("later metadata failure");
    };
  })).toThrow("later metadata failure");
  for (const table of ["members", "scopes", "workspace_registries", "ssh_credentials", "memory_documents", "memory_document_history"]) {
    expect(db!.all(`SELECT * FROM ${table}`)).toEqual([]);
  }
  expect(readdirSync(join(root, "members"))).toEqual([]);
  db!.close(); expect((await start()).migrated).toBe(false);
});
