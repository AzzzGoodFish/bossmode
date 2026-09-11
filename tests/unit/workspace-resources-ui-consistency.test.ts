import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("workspace resources UI consistency (Members / Chats)", () => {
  it("uses shared BackLink on detail pages", () => {
    const back = source("web/src/components/BackLink.tsx");
    expect(back).toContain("ArrowLeft");
    expect(back).toContain("size={18}");
  });

  it("lays pages out on the full-width canvas (no narrow centered column)", () => {
    for (const path of [
      "web/src/pages/ChatsPage.tsx",
    ]) {
      const src = source(path);
      expect(src).not.toMatch(/max-w-(2xl|3xl|4xl) mx-auto/);
      expect(src).not.toContain("max-w-[880px]");
    }
  });

  it("keeps the one-click member creation entry in the sidebar, not duplicated in lists", () => {
    const sidebar = source("web/src/components/Sidebar.tsx");
    expect(sidebar).toContain("创建成员");
    expect(sidebar).toContain("createGlobalMember({})");
  });
});
