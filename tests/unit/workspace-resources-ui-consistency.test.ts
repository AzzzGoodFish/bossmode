import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("workspace resources UI consistency (Members / Chats)", () => {
  it("uses shared BackLink on detail pages", () => {
    const back = source("web/src/components/BackLink.tsx");
    expect(back).toContain("ArrowLeft");
    expect(back).toContain("size={18}");

    // Member detail lives in the peek card + float window (member UI v2) — no page, no BackLink.
    for (const path of [
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
      "web/src/pages/MemberCreatePage.tsx",
      "web/src/pages/ChatsPage.tsx",
      "web/src/pages/ContactsPage.tsx",
    ]) {
      const src = source(path);
      expect(src).not.toMatch(/max-w-(2xl|3xl|4xl) mx-auto/);
      expect(src).not.toContain("max-w-[880px]");
    }
  });

  it("keeps the member creation entry on Contacts, not duplicated in lists", () => {
    const contacts = source("web/src/pages/ContactsPage.tsx");
    expect(contacts).toContain("New member");
  });
});
