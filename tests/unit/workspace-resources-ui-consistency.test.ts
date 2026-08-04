import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("workspace resources UI consistency (Templates / Members / Skills)", () => {
  it("uses shared BackLink on detail pages", () => {
    const back = source("web/src/components/BackLink.tsx");
    expect(back).toContain("ArrowLeft");
    expect(back).toContain("size={18}");

    for (const path of [
      "web/src/pages/SkillDetailPage.tsx",
      "web/src/pages/TemplatesPage.tsx",
      "web/src/pages/MemberSettingsPage.tsx",
      "web/src/pages/MemberCreatePage.tsx",
    ]) {
      const src = source(path);
      expect(src).toContain("BackLink");
      expect(src).not.toMatch(/<ArrowLeft\b/);
      expect(src).not.toMatch(/BackLink[^>]*className=/);
    }
  });

  it("lays pages out on the full-width canvas (no narrow centered column)", () => {
    for (const path of [
      "web/src/pages/TemplatesPage.tsx",
      "web/src/pages/MemberCreatePage.tsx",
      "web/src/pages/MemberSettingsPage.tsx",
      "web/src/pages/ChatsPage.tsx",
      "web/src/pages/ContactsPage.tsx",
    ]) {
      const src = source(path);
      expect(src).not.toMatch(/max-w-(2xl|3xl|4xl) mx-auto/);
      expect(src).not.toContain("max-w-[880px]");
    }
  });

  it("keeps creation entries on their domain pages, not duplicated in lists", () => {
    const templates = source("web/src/pages/TemplatesPage.tsx");
    expect(templates).toContain("New template");
    const contacts = source("web/src/pages/ContactsPage.tsx");
    expect(contacts).toContain("New member");
    const skills = source("web/src/pages/SkillsPage.tsx");
    expect(skills).not.toContain("New Skill");
  });

  it("routes templates and skills as secondary rail domains", () => {
    const sidebar = source("web/src/components/Sidebar.tsx");
    expect(sidebar).toContain('aria-label="Templates"');
    expect(sidebar).toContain('aria-label="Skills"');
    expect(sidebar).toContain("onNavigate({ type: \"skill\", name: null })");
    expect(sidebar).not.toContain('aria-label="Team"');
  });
});
