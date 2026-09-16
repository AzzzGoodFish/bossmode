import { getDefaultConfig, writeConfig } from "../../src/config/settings.js";
import { coreFixture } from "../helpers/core-fixture.js";


import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tmpDir = process.env.BOSSMODE_DIR!;
let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  writeConfig({ ...getDefaultConfig(), auth: { username: "fish", passwordHash: "fixture-only" } }, fixture.db);
  new ConversationsRepository(fixture.db).upsertRoom({ id: "room-a", name: "Asset tests", createdAt: 1, members: [], roomMembers: [] });
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

describe("member birth skeleton", () => {
  it("createMember writes an empty persona.md and skills dir (no shared memory roots)", async () => {
    const { createMember } = await import("../../src/member/member-registry.js");
    const { memberProfilePath } = await import("../../src/files/layout.js");
    const m = createMember({ name: "nova" });
    const path = memberProfilePath(m.id);
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf-8");
    expect(raw).toBe("");
    expect(path).toMatch(/persona\.md$/);
    expect(raw).not.toMatch(/## Persona/); // empty body at birth
    expect(existsSync(join(tmpDir, "members", m.id, "skills"))).toBe(true);
    // ④ A: the shared memory roots are retired — birth must not recreate them.
    expect(existsSync(join(tmpDir, "memory", "user"))).toBe(false);
    expect(existsSync(join(tmpDir, "memory", "projects"))).toBe(false);
  });

  it("empty name allocates New Member uniquely", async () => {
    const { createMember, allocateUniqueMemberName } = await import("../../src/member/member-registry.js");
    const a = createMember({ name: "" });
    expect(a.name).toBe("New Member");
    const b = createMember({});
    expect(b.name).toBe("New Member 2");
    expect(allocateUniqueMemberName("New Member")).toBe("New Member 3");
  });

  it("database identity updates leave all persona Markdown untouched", async () => {
    const { createMember, getMember, updateMemberIdentity } = await import("../../src/member/member-registry.js");
    const { readMemberProfile, formatMemberPromptSegment } = await import("../../src/member/profile/member-profile.js"); const { memberProfilePath } = await import("../../src/files/layout.js");
    const { writeFileSync } = await import("node:fs");
    const m = createMember({ name: "nova" });
    const raw = "\uFEFF---\nname: not-identity\ntitle: not-title\n---\n\nArbitrary Markdown.\n\n";
    writeFileSync(memberProfilePath(m.id), raw, "utf-8");
    updateMemberIdentity(m.id, { name: "new-nova", title: "Engineer" });
    expect(getMember(m.id)).toMatchObject({ name: "new-nova", title: "Engineer" });
    const profile = readMemberProfile(m.id);
    expect(profile.body).toBe(raw);
    expect(profile.raw).toBe(raw);
    expect(profile).not.toHaveProperty("frontmatter");
    expect(formatMemberPromptSegment(profile, "new-nova")).toBe(`# Persona\n\nI am new-nova, an AI teammate in Bossmode.\n\n${raw.trim()}`);
    // description (title storage) joins the identity sentence when present.
    expect(formatMemberPromptSegment(profile, "new-nova", "Engineer")).toBe(`# Persona\n\nI am new-nova (Engineer), an AI teammate in Bossmode.\n\n${raw.trim()}`);
    updateMemberIdentity(m.id, { title: "" });
    expect(getMember(m.id)?.title).toBeUndefined();
    expect(readFileSync(memberProfilePath(m.id), "utf-8")).toBe(raw);
    fixture.reopen();
    expect(getMember(m.id)).toMatchObject({ name: "new-nova" });
    expect(readMemberProfile(m.id).raw).toBe(raw);
  });

  it("reads persona literally at and above the UTF-16 limit without truncating bytes", async () => {
    const { createMember } = await import("../../src/member/member-registry.js");
    const { readMemberProfile, MEMBER_PROFILE_BUDGET_CHARS } = await import("../../src/member/profile/member-profile.js"); const { memberProfilePath } = await import("../../src/files/layout.js");
    const m = createMember({ name: "literal" });
    expect(MEMBER_PROFILE_BUDGET_CHARS).toBe(4000);
    for (const length of [4000, 4001]) {
      const prefix = "\uFEFF---\r\nname: not-identity\r\n---\r\n😀";
      const raw = prefix + "x".repeat(length - prefix.length);
      writeFileSync(memberProfilePath(m.id), raw);
      expect(readMemberProfile(m.id)).toMatchObject({ raw, body: raw, exists: true, overBudget: length > 4000 });
      expect(readFileSync(memberProfilePath(m.id))).toEqual(Buffer.from(raw));
      expect(Buffer.byteLength(raw)).toBeGreaterThan(length);
    }
  });

  it("missing persona is empty but non-ENOENT read failures are not hidden", async () => {
    const { readMemberProfile } = await import("../../src/member/profile/member-profile.js"); const { memberProfilePath } = await import("../../src/files/layout.js");
    const { mkdirSync } = await import("node:fs");
    expect(readMemberProfile("missing")).toMatchObject({ body: "", raw: "", exists: false, overBudget: false });
    mkdirSync(memberProfilePath("missing"), { recursive: true });
    expect(() => readMemberProfile("missing")).toThrow();
  });
});
