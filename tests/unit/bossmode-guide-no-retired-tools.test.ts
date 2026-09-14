import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const guideDir = join(process.cwd(), "assets/skills/bossmode-guide");
const files = [
  "SKILL.md",
  "references/memory.md",
  "references/sessions.md",
  "scripts/session-search.mjs",
];

// Tool names and flags retired in 0.25 (background tasks + recall/memorize, and
// the earlier member memory layer tools). The shipped guide must not send
// members to tools that no longer exist.
const RETIRED = /recall\(|memorize\(|background_start|background_wait|background_status|background_cancel|include-background|read_memory|write_memory|edit_memory|background-tasks/;

describe("bossmode-guide has no retired-tool references", () => {
  for (const rel of files) {
    it(rel, () => {
      const text = readFileSync(join(guideDir, rel), "utf8");
      expect(text).not.toMatch(RETIRED);
    });
  }
});
