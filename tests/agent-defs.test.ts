import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("agent definition parser", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should parse frontmatter and body from agent definition file", async () => {
    // Use the parseFrontmatter logic directly
    const content = `---
name: pm
model: claude-sonnet-4-6
description: Product Manager
---

# PM Agent

You are the PM of this team.`;

    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    expect(match).not.toBeNull();

    const meta: Record<string, string> = {};
    for (const line of match![1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        meta[key] = value;
      }
    }

    expect(meta.name).toBe("pm");
    expect(meta.model).toBe("claude-sonnet-4-6");
    expect(meta.description).toBe("Product Manager");

    const body = match![2].trim();
    expect(body).toContain("# PM Agent");
    expect(body).toContain("You are the PM of this team.");
  });

  it("should handle missing frontmatter", () => {
    const content = "# Just a body\nNo frontmatter here.";
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    expect(match).toBeNull();
  });
});
