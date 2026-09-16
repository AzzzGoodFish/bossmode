import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import * as layout from "../../src/files/layout.js";
import { ensureDirectory } from "../../src/files/io.js";

describe("physical layout authority", () => {
  it("preserves member, room and UTC-day session paths without chat-specific assembly", () => {
    const root = process.env.BOSSMODE_DIR!;
    expect(layout.getBossmodeDir()).toBe(root);
    expect(layout.memberDir("mem_example")).toBe(join(root, "members/mem_example"));
    expect(layout.memberProfilePath("mem_example")).toBe(join(root, "members/mem_example/persona.md"));
    expect(layout.memberSkillsDir("mem_example")).toBe(join(root, "members/mem_example/skills"));
    expect(layout.memberExtensionsDir("mem_example")).toBe(join(root, "members/mem_example/extensions"));
    expect(layout.memberArchiveDir("mem_example")).toBe(join(root, "members/mem_example/archive"));
    expect(layout.roomDir("rm_example")).toBe(join(root, "rooms/rm_example"));
    expect(layout.documentsRoot()).toBe(join(root, "memory/projects"));
    expect(layout.knowledgeRoot()).toBe(join(root, "knowledge"));
    expect(layout.mainSessionDirectory("mem_example", new Date("2026-09-16T23:59:00-03:00")))
      .toBe(join(root, "members/mem_example/sessions/2026-09-17/main"));
  });

  it("does not change a running process's root when an extension mutates the environment", () => {
    const previous = process.env.BOSSMODE_DIR;
    const captured = layout.getBossmodeDir();
    try {
      process.env.BOSSMODE_DIR = join(captured, "not-a-new-instance");
      expect(layout.getBossmodeDir()).toBe(captured);
    } finally { process.env.BOSSMODE_DIR = previous; }
  });

  it("creates directories only through the explicit filesystem operation", () => {
    const parent = mkdtempSync(join(tmpdir(), "layout-io-"));
    try {
      const target = join(parent, "new/nested");
      expect(existsSync(target)).toBe(false);
      ensureDirectory(target);
      ensureDirectory(target);
      expect(existsSync(target)).toBe(true);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it.each([true, false])("built layout import has no storage side effects (explicit root: %s)", explicit => {
    const parent = mkdtempSync(join(tmpdir(), "layout-import-"));
    const root = join(parent, explicit ? "absent" : ".bossmode");
    const env = { ...process.env, HOME: parent };
    if (explicit) env.BOSSMODE_DIR = root;
    else delete env.BOSSMODE_DIR;
    const module = pathToFileURL(resolve("dist/files/layout.js")).href;
    try {
      const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { existsSync } from 'node:fs';
        const layout = await import(${JSON.stringify(module)});
        console.log(JSON.stringify({root:layout.getBossmodeDir(), exists:existsSync(layout.getBossmodeDir())}));
      `], { encoding: "utf8", env });
      expect(JSON.parse(result)).toEqual({ root, exists: false });
      expect(existsSync(root)).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
