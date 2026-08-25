import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => { mkdirSync(tmpDir, { recursive: true }); },
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-member-birth-"));
  mkdirSync(join(tmpDir, "members"), { recursive: true });
});
afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("member birth skeleton", () => {
  it("createMember writes member.md frontmatter skeleton and skills dir", async () => {
    const { createMember } = await import("../../src/workspace/member-registry.js");
    const { memberProfilePath, sharedUserMemoryDir, sharedProjectsMemoryDir } = await import(
      "../../src/workspace/member-profile.js"
    );
    const m = createMember({ name: "nova" });
    const path = memberProfilePath(m.id);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf-8");
    expect(raw).toMatch(/^---\nname: nova\n---\n/);
    expect(raw).not.toMatch(/## Persona/); // empty body at birth
    expect(existsSync(join(tmpDir, "members", m.id, "skills"))).toBe(true);
    expect(existsSync(sharedUserMemoryDir())).toBe(true);
    expect(existsSync(sharedProjectsMemoryDir())).toBe(true);
  });

  it("empty name allocates New Member uniquely", async () => {
    const { createMember, allocateUniqueMemberName } = await import("../../src/workspace/member-registry.js");
    const a = createMember({ name: "" });
    expect(a.name).toBe("New Member");
    const b = createMember({});
    expect(b.name).toBe("New Member 2");
    expect(allocateUniqueMemberName("New Member")).toBe("New Member 3");
  });

  it("updateMemberProfileFrontmatter writes title/description and preserves body", async () => {
    const { createMember } = await import("../../src/workspace/member-registry.js");
    const {
      updateMemberProfileFrontmatter,
      readMemberProfile,
      memberProfilePath,
    } = await import("../../src/workspace/member-profile.js");
    const { writeFileSync } = await import("node:fs");

    const m = createMember({ name: "nova" });
    writeFileSync(
      memberProfilePath(m.id),
      "---\nname: nova\n---\n\n## Persona\nI ship carefully.\n",
      "utf-8",
    );

    updateMemberProfileFrontmatter(
      m.id,
      { title: "Architect", description: "Designs systems" },
      m.name,
    );
    let p = readMemberProfile(m.id, m.name);
    expect(p.frontmatter.title).toBe("Architect");
    expect(p.frontmatter.description).toBe("Designs systems");
    expect(p.body).toContain("## Persona");
    expect(p.body).toContain("I ship carefully.");

    // Clear title, leave description; body still intact.
    updateMemberProfileFrontmatter(m.id, { title: "" }, m.name);
    p = readMemberProfile(m.id, m.name);
    expect(p.frontmatter.title).toBeUndefined();
    expect(p.frontmatter.description).toBe("Designs systems");
    expect(p.body).toContain("I ship carefully.");
  });
});
