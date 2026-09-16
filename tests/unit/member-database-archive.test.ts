import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { MemberArchivesRepository } from "../../src/data/repositories/member-archives.js";
import { loadShortIdMapping, migrateShortIds } from "../../src/data/migrations/short-id-migration.js";
import { MemberArchiveService } from "../../src/member/archive/member-archive-lifecycle.js";
let fixture: ReturnType<typeof coreFixture>;
let root: string;
beforeEach(() => { fixture = coreFixture(); root = fixture.root; });
afterEach(() => fixture.close());
it("archive retains SQL metadata and literal persona bytes", async () => {
  const { createMember, getMember } = await import("../../src/member/member-registry.js"); const { memberDir } = await import("../../src/files/layout.js");
  const m = createMember({ name: "before", title: "Engineer", model: "p/m", credentialId: "credential-ref", thinkingLevel: "high", skills: ["skill-a"], mcpServers: ["server-a"] });
  const markdown = "---\nname: this is Markdown, not identity\n---\n\n自由正文\n\n";
  writeFileSync(join(memberDir(m.id), "persona.md"), markdown);
  expect(existsSync(join(memberDir(m.id), "member.json"))).toBe(false);
  const { archived } = await new MemberArchiveService(fixture.db, root, { quiesce: async () => {} }).archive(m.id, { confirm: true });
  expect(getMember(m.id)).toBeNull();
  expect(fixture.db.get("SELECT archive_path FROM members WHERE id=?", m.id)).toEqual({ archive_path: archived });
  expect(new MemberArchivesRepository(fixture.db).get(archived, m.name)).toMatchObject({ title: "Engineer", global: m.global });
  expect(existsSync(join(root, archived, "member.json"))).toBe(false);
});
it("recoverPending finishes a pending intent across a short-id migration", async () => {
  const { createMember, getMember } = await import("../../src/member/member-registry.js"); const { memberDir } = await import("../../src/files/layout.js");
  const m = createMember({ name: "pending-recover", title: "Engineer", model: "p/m", credentialId: "credential-ref", thinkingLevel: "high", skills: [], mcpServers: [] });
  writeFileSync(join(memberDir(m.id), "persona.md"), "p\n");
  // As if an archive began and the process died before the move: intent is pending.
  const stat = statSync(join(root, "members", m.id));
  const archivePath = `backups/fired-${m.id}-${randomUUID()}`;
  new MemberArchivesRepository(fixture.db).begin({ memberId: m.id, sourcePath: `members/${m.id}`, archivePath,
    sourceDevice: String(stat.dev), sourceInode: String(stat.ino), createdAt: Date.now() });

  const report = migrateShortIds(root, fixture.db);
  expect(report.status).toBe("migrated");
  const newId = loadShortIdMapping(fixture.db)!.members.get(m.id)!;
  expect(newId).toMatch(/^mem_[0-9a-z]{10}$/);
  const intent = fixture.db.get<{ member_id: string; source_path: string; archive_path: string }>("SELECT member_id,source_path,archive_path FROM member_archive_intents")!;
  expect(intent).toEqual({ member_id: newId, source_path: `members/${newId}`, archive_path: archivePath });

  // Recovery runs against the renamed tree: inode matches at the new path, and the
  // (excluded-zone) archive path keeps its pre-migration form.
  await new MemberArchiveService(fixture.db, root, { quiesce: async () => {} }).recoverPending();
  expect(getMember(newId)).toBeNull();
  expect(fixture.db.get<{ archive_path: string }>("SELECT archive_path FROM members WHERE id=?", newId)).toEqual({ archive_path: archivePath });
  expect(existsSync(join(root, archivePath, "persona.md"))).toBe(true);
  expect(existsSync(join(root, "members", newId))).toBe(false);
  expect(fixture.db.get<{ state: string }>("SELECT state FROM member_archive_intents")!.state).toBe("completed");
});
