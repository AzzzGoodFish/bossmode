import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, symlinkSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

/**
 * Unit test for the skill symlink logic extracted from claude-cli.ts createAgent().
 * Tests the symlink creation logic in isolation.
 */

// Extract the symlink logic as a testable function
function createSkillSymlinks(skillPaths: string[]): string[] {
  const createdSymlinks: string[] = [];
  const claudeSkillsDir = join(homedir(), ".claude", "skills");
  mkdirSync(claudeSkillsDir, { recursive: true });
  for (const sp of skillPaths) {
    if (!existsSync(sp)) continue;
    const skillName = basename(sp);
    const target = join(claudeSkillsDir, skillName);
    if (!existsSync(target)) {
      try {
        symlinkSync(sp, target);
        createdSymlinks.push(target);
      } catch {
        // skip
      }
    }
  }
  return createdSymlinks;
}

// Mock fs and os
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  symlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

describe("claude-cli skill symlink creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates symlinks for existing skill paths", () => {
    const mockExistsSync = vi.mocked(existsSync);
    // Skill source exists, target does not
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("/.claude/skills/")) return false; // target doesn't exist yet
      return true; // source exists
    });

    const result = createSkillSymlinks(["/home/testuser/.bossmode/skills/my-skill"]);

    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(
      "/home/testuser/.claude/skills",
      { recursive: true }
    );
    expect(vi.mocked(symlinkSync)).toHaveBeenCalledWith(
      "/home/testuser/.bossmode/skills/my-skill",
      "/home/testuser/.claude/skills/my-skill"
    );
    expect(result).toEqual(["/home/testuser/.claude/skills/my-skill"]);
  });

  it("skips non-existent skill paths", () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = createSkillSymlinks(["/nonexistent/skill"]);

    expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("skips if symlink target already exists", () => {
    vi.mocked(existsSync).mockReturnValue(true); // both source and target exist

    const result = createSkillSymlinks(["/home/testuser/.bossmode/skills/existing-skill"]);

    expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("handles multiple skill paths", () => {
    const mockExistsSync = vi.mocked(existsSync);
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("/.claude/skills/")) return false;
      return true;
    });

    const paths = [
      "/home/testuser/.bossmode/skills/skill-a",
      "/home/testuser/.bossmode/skills/skill-b",
    ];
    const result = createSkillSymlinks(paths);

    expect(vi.mocked(symlinkSync)).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it("handles empty skill paths array", () => {
    const result = createSkillSymlinks([]);
    expect(vi.mocked(symlinkSync)).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("continues on symlink error (e.g. permission denied)", () => {
    const mockExistsSync = vi.mocked(existsSync);
    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.includes("/.claude/skills/")) return false;
      return true;
    });
    vi.mocked(symlinkSync).mockImplementation(() => { throw new Error("EACCES"); });

    const result = createSkillSymlinks(["/home/testuser/.bossmode/skills/no-perm"]);

    expect(result).toEqual([]);
  });
});
