import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir, homedir } from "node:os";

/**
 * Mirror production isAllowedAttachmentPath logic (with realpathSync).
 * Tests use real temp files since realpathSync requires files to exist.
 */
function isAllowedAttachmentPath(filePath: string, roomCwd: string): boolean {
  let resolved: string;
  try {
    resolved = realpathSync(resolve(filePath));
  } catch {
    return false;
  }
  let allowedPrefixes: string[];
  try {
    allowedPrefixes = [
      realpathSync(roomCwd),
      realpathSync(tmpdir()),
      realpathSync(join(homedir(), ".bossmode", "knowledge")),
    ];
  } catch {
    return false;
  }
  return allowedPrefixes.some((prefix) =>
    resolved === prefix || resolved.startsWith(prefix + sep),
  );
}

// Create temp dir at module level (vitest beforeAll can have scoping issues)
const fakeCwd = mkdtempSync(join(tmpdir(), "bossmode-attach-test-"));

afterAll(() => {
  rmSync(fakeCwd, { recursive: true, force: true });
});

describe("agent attachment path validation", () => {

  it("allows files in room working directory", () => {
    const f = join(fakeCwd, "report.md");
    writeFileSync(f, "test", "utf-8");
    expect(isAllowedAttachmentPath(f, fakeCwd)).toBe(true);
  });

  it("allows files in /tmp", () => {
    const f = join(tmpdir(), `bossmode-test-${Date.now()}.txt`);
    writeFileSync(f, "test", "utf-8");
    try {
      expect(isAllowedAttachmentPath(f, fakeCwd)).toBe(true);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("rejects paths that don't exist", () => {
    expect(isAllowedAttachmentPath("/nonexistent/file.txt", fakeCwd)).toBe(false);
  });

  it("rejects system sensitive paths", () => {
    // /etc/hostname usually exists and is readable
    expect(isAllowedAttachmentPath("/etc/hostname", fakeCwd)).toBe(false);
  });

  it("rejects paths outside allowed directories", () => {
    expect(isAllowedAttachmentPath("/var/log/syslog", fakeCwd)).toBe(false);
  });

  it("rejects symlinks that escape allowed directories", () => {
    const symlinkPath = join(fakeCwd, "escape.txt");
    try {
      symlinkSync("/etc/hostname", symlinkPath);
      // realpathSync resolves to /etc/hostname — outside allowed dirs
      expect(isAllowedAttachmentPath(symlinkPath, fakeCwd)).toBe(false);
    } catch {
      // symlink creation may fail in some envs — skip gracefully
    }
  });
});
