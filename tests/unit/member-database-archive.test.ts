import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let root: string;
let old: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-member-db-archive-")); old = process.env.BOSSMODE_DIR;
  process.env.BOSSMODE_DIR = root; vi.resetModules();
});
afterEach(async () => {
  (await import("../../src/workspace/db/sqlite.js")).openDb().close();
  if (old === undefined) delete process.env.BOSSMODE_DIR; else process.env.BOSSMODE_DIR = old;
  rmSync(root, { recursive: true, force: true });
});
it("fire exports DB metadata, import preserves title/configuration and literal persona", async () => {
  const { createMember, fireMember, getMember, memberDir } = await import("../../src/workspace/member-registry.js");
  const { listArchives, importMemberFromArchive } = await import("../../src/workspace/member-archive.js");
  const m = createMember({ name: "before", title: "Engineer", model: "p/m", credentialId: "credential-ref", thinkingLevel: "high", skills: ["skill-a"], mcpServers: ["server-a"] });
  const markdown = "---\nname: this is Markdown, not identity\n---\n\n自由正文\n\n";
  writeFileSync(join(memberDir(m.id), "persona.md"), markdown);
  expect(existsSync(join(memberDir(m.id), "member.json"))).toBe(false);
  const { archived } = fireMember(m.id, { confirm: true });
  expect(getMember(m.id)).toBeNull();
  expect(JSON.parse(readFileSync(join(root, archived, "member.json"), "utf8"))).toMatchObject({ id: m.id, title: "Engineer", global: m.global });
  expect(listArchives().find((a) => a.archivePath === archived)?.hasPersona).toBe(true);
  const imported = importMemberFromArchive({ archivePath: archived, name: "after" });
  expect(imported.id).not.toBe(m.id);
  expect(imported.title).toBe("Engineer");
  expect(imported.global).toEqual(m.global);
  expect(readFileSync(join(memberDir(imported.id), "persona.md"), "utf8")).toBe(markdown);
  expect(existsSync(join(memberDir(imported.id), "member.md"))).toBe(false);
});
