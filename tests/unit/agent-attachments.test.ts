import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { resolve, normalize } from "node:path";

describe("agent attachment path validation", () => {
  // Test the path validation logic directly
  function isAllowedAttachmentPath(filePath: string, roomCwd: string): boolean {
    const resolved = resolve(filePath);
    const normalized = normalize(resolved);
    const allowedPrefixes = [
      normalize(roomCwd),
      normalize(tmpdir()),
      normalize(join(homedir(), ".bossmode", "knowledge")),
    ];
    return allowedPrefixes.some((prefix) => normalized.startsWith(prefix + "/") || normalized === prefix);
  }

  const roomCwd = "/home/fish/dev/llm/bossmode";

  it("allows files in room working directory", () => {
    expect(isAllowedAttachmentPath("/home/fish/dev/llm/bossmode/report.md", roomCwd)).toBe(true);
    expect(isAllowedAttachmentPath("/home/fish/dev/llm/bossmode/docs/plan.md", roomCwd)).toBe(true);
  });

  it("allows files in /tmp", () => {
    expect(isAllowedAttachmentPath("/tmp/output.pdf", roomCwd)).toBe(true);
    expect(isAllowedAttachmentPath(join(tmpdir(), "subdir/file.txt"), roomCwd)).toBe(true);
  });

  it("allows files in knowledge directory", () => {
    const knowledgePath = join(homedir(), ".bossmode", "knowledge", "docs", "test.md");
    expect(isAllowedAttachmentPath(knowledgePath, roomCwd)).toBe(true);
  });

  it("rejects system sensitive paths", () => {
    expect(isAllowedAttachmentPath("/etc/passwd", roomCwd)).toBe(false);
    expect(isAllowedAttachmentPath("/root/.ssh/id_rsa", roomCwd)).toBe(false);
    expect(isAllowedAttachmentPath(join(homedir(), ".ssh", "id_rsa"), roomCwd)).toBe(false);
  });

  it("rejects paths outside allowed directories", () => {
    expect(isAllowedAttachmentPath("/var/log/syslog", roomCwd)).toBe(false);
    expect(isAllowedAttachmentPath("/usr/bin/node", roomCwd)).toBe(false);
  });

  it("handles path traversal attempts", () => {
    expect(isAllowedAttachmentPath("/home/fish/dev/llm/bossmode/../../../etc/passwd", roomCwd)).toBe(false);
  });
});
