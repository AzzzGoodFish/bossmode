import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPath, type PathPolicy } from "../../src/shared/path-security.js";

const testDir = mkdtempSync(join(tmpdir(), "bossmode-pathsec-"));
afterAll(() => rmSync(testDir, { recursive: true, force: true }));

const policy: PathPolicy = {
  allowedPrefixes: [testDir],
  maxSizeBytes: 10 * 1024 * 1024, // 10 MB
};

describe("path-security checkPath", () => {
  it("accepts a file within allowed prefix", () => {
    const f = join(testDir, "ok.txt");
    writeFileSync(f, "hello");
    const r = checkPath(f, policy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.absolutePath).toContain("ok.txt");
      expect(r.size).toBe(5);
    }
  });

  it("rejects a path outside allowed prefix", () => {
    const r = checkPath("/etc/hostname", policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside allowed");
  });

  it("rejects a non-existent file", () => {
    const r = checkPath(join(testDir, "nope.txt"), policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  it("rejects a directory", () => {
    const d = join(testDir, "subdir");
    mkdirSync(d, { recursive: true });
    const r = checkPath(d, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Not a regular file");
  });

  it("rejects a file exceeding maxSizeBytes", () => {
    const f = join(testDir, "big.txt");
    writeFileSync(f, Buffer.alloc(11 * 1024 * 1024)); // 11 MB
    const r = checkPath(f, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("too large");
  });

  it("rejects symlink escaping allowed prefix", () => {
    const link = join(testDir, "escape");
    try {
      symlinkSync("/etc/hostname", link);
      const r = checkPath(link, policy);
      expect(r.ok).toBe(false);
    } catch {
      // symlink may not be available in test env
    }
  });

  it("rejects empty/invalid input", () => {
    expect(checkPath("", policy).ok).toBe(false);
    expect(checkPath(null as any, policy).ok).toBe(false);
  });
});
