import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDirectories, locateReadableFile, readFileBytes, writeTemporaryText } from "../../src/files/io.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function temporary(name: string): string { const root = mkdtempSync(join(tmpdir(), name)); roots.push(root); return root; }

describe("generic filesystem reads", () => {
  it("browses sorted child directories without escaping the supplied root", () => {
    const root = temporary("bossmode-files-root-");
    const child = join(root, "child");
    writeFileSync(join(root, "plain.txt"), "ignored");
    for (const name of ["z", "a"]) {
      const directory = join(child, name);
      mkdirSync(directory, { recursive: true });
    }
    expect(browseDirectories(root, "~/child")).toEqual({
      ok: true, path: child, parent: root,
      segments: [{ name: root.split("/").pop()!, path: root }, { name: "child", path: child }],
      dirs: [{ name: "a", path: join(child, "a") }, { name: "z", path: join(child, "z") }], truncated: false,
    });
    expect(browseDirectories(root, join(root, ".."))).toMatchObject({ ok: false, code: "outside" });
    expect(browseDirectories(root, join(root, "plain.txt"))).toMatchObject({ ok: false, code: "not_directory" });
    const outside = temporary("bossmode-files-outside-");
    const link = join(root, "escape");
    symlinkSync(outside, link, "dir");
    expect(browseDirectories(root, link)).toMatchObject({ ok: false, code: "outside" });
  });

  it("selects the first existing regular file and reports its canonical size", () => {
    const root = temporary("bossmode-files-root-");
    const file = join(root, "artifact.md");
    writeFileSync(file, "hello");
    const result = locateReadableFile([join(root, "missing.md"), file], [root], 10);
    expect(result).toEqual({ ok: true, path: file, size: 5 });
    if (result.ok) expect(readFileBytes(result.path).toString("utf8")).toBe("hello");
  });

  it("rejects existing files and symlink targets outside the allowed roots", () => {
    const root = temporary("bossmode-files-root-");
    const outside = temporary("bossmode-files-outside-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    expect(locateReadableFile([secret], [root])).toMatchObject({ ok: false, code: "invalid" });
    const link = join(root, "link.txt");
    symlinkSync(secret, link);
    expect(locateReadableFile([link], [root])).toMatchObject({ ok: false, code: "invalid" });
  });

  it("distinguishes missing candidates from invalid and oversized files", () => {
    const root = temporary("bossmode-files-root-");
    expect(locateReadableFile([join(root, "missing")], [root])).toEqual({ ok: false, code: "not_found", error: "File not found" });
    const large = join(root, "large.txt");
    writeFileSync(large, "12345");
    expect(locateReadableFile([large], [root], 4)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("writes a private temporary text file without mutating the shared temp directory", () => {
    const directoryMode = statSync(tmpdir()).mode & 0o7777;
    const path = writeTemporaryText("hello", "bossmode-chat-read-room:test", ".md");
    try {
      expect(path).toMatch(/\/bossmode-chat-read-room-test-[a-f0-9]{8}\.md$/);
      expect(readFileSync(path, "utf8")).toBe("hello");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(tmpdir()).mode & 0o7777).toBe(directoryMode);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
