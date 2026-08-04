import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
  readConfig: () => ({ username: "fish" }),
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("template lifecycle S5", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bm-tpl-"));
    mkdirSync(join(state.dir, "agents"), { recursive: true });
    writeFileSync(join(state.dir, "agents", "general.md"), "---\nname: general\ntags: [builtin]\n---\nG\n", "utf8");
    writeFileSync(join(state.dir, "agents", "custom_x.md"), "---\nname: custom_x\n---\nC\n", "utf8");
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("falls back referencing members to general and posts dm warning", async () => {
    // agent-store freezes AGENTS_DIR at import — write via save path after import with mock
    const reg = await import("../../src/workspace/member-registry.js");
    const life = await import("../../src/workforce/template-lifecycle.js");
    const dm = await import("../../src/workspace/dm-message-store.js");

    const m = reg.createMember({ name: "dave", agentTemplate: "custom_x" });
    expect(m.agentTemplate).toBe("custom_x");

    // Simulate file gone + fallback (deleteAgent may not see our agents dir due to frozen path)
    const result = life.fallbackMembersToGeneral("custom_x");
    expect(result.updatedMemberIds).toContain(m.id);
    expect(reg.getMember(m.id)!.agentTemplate).toBe("general");
    const msgs = dm.readAllDmMessages(m.id);
    expect(msgs.some((x) => x.sender === "system" && /general/i.test(x.content))).toBe(true);
  });

  it("general is immutable", async () => {
    const life = await import("../../src/workforce/template-lifecycle.js");
    // Without loadable general file tags, name===general is enough
    expect(life.isImmutableTemplate("general")).toBe(true);
  });
});
