import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe("member runtime normalization", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-members-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizes legacy claude-cli members to pi-cli on read", async () => {
    writeFileSync(join(dir, "members.json"), JSON.stringify([
      { id: "m1", name: "dev", agent: "developer", model: "sonnet", runtime: "claude-cli", thinkingLevel: "off" },
    ]));

    const { loadMembers } = await import("../../src/workforce/member-store.js");

    expect(loadMembers()[0].runtime).toBe("pi-cli");
  });

  it("persists saved members as pi-cli even if caller supplies legacy runtime", async () => {
    const { saveMember } = await import("../../src/workforce/member-store.js");

    const saved = saveMember({
      name: "dev",
      agent: "developer",
      model: "sonnet",
      runtime: "claude-cli" as any,
      thinkingLevel: "off",
    });

    const raw = JSON.parse(readFileSync(join(dir, "members.json"), "utf-8"));
    expect(saved.runtime).toBe("pi-cli");
    expect(raw[0].runtime).toBe("pi-cli");
  });
});
