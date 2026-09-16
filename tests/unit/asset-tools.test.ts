/**
 * Identity batch-2: read/edit/write_memory retired.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir = "";
vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));
vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bossmode-asset-gone-"));
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "rooms"), { recursive: true });
});
afterEach(() => {
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

describe("asset tools retired", () => {
  it("read/edit/write_memory are unknown tools", async () => {
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    for (const tool of ["read_memory", "edit_memory", "write_memory"]) {
      await expect(handleToolCallback(tool, "room-x", "pm", { asset: "mainline" })).rejects.toThrow(/Unknown tool/);
    }
  });
});
