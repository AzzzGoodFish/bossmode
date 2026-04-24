import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => {},
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
}));

describe("room-store updateRuleDocPathsByPrefix", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bossmode-room-prefix-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates matching ruleDocs prefix and deduplicates", async () => {
    const { createRoom, getRoom, updateRuleDocPathsByPrefix } = await import("../../src/workspace/room-store.js");

    const room = createRoom("r1", "/tmp", ["pm"], [
      "bossmode/rules/a.md",
      "bossmode/rules/sub/b.md",
      "other/rules/x.md",
      "bossmode-new/rules/a.md",
    ]);

    const affected = updateRuleDocPathsByPrefix("bossmode/rules", "bossmode-new/rules");
    expect(affected).toBe(1);

    const updated = getRoom(room.id);
    expect(updated?.ruleDocs).toEqual([
      "bossmode-new/rules/a.md",
      "bossmode-new/rules/sub/b.md",
      "other/rules/x.md",
    ]);
  });

  it("does not affect rooms without matching prefix", async () => {
    const { createRoom, updateRuleDocPathsByPrefix } = await import("../../src/workspace/room-store.js");
    createRoom("r1", "/tmp", ["pm"], ["foo/bar.md"]);
    expect(updateRuleDocPathsByPrefix("bossmode/rules", "bossmode2/rules")).toBe(0);
  });
});
