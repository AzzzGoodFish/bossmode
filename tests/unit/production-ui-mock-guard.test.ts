import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readWebSource = (path: string) => readFileSync(resolve(root, "web/src", path), "utf8");

describe("production UI mock guard", () => {
  it("does not let member/template surfaces import or render mock data sources", () => {
    for (const path of [
      "pages/ChatsPage.tsx",
      "pages/ContactsPage.tsx",
      "pages/DmPage.tsx",
      "pages/MemberCreatePage.tsx",
      "pages/MemberSettingsPage.tsx",
      "components/CreateRoomDialog.tsx",
    ]) {
      const source = readWebSource(path);
      expect(source).not.toMatch(/team-mock|agentTemplateStats|mock data|mock\/contacts|MOCK_MEMBERS|CreateRoomDraftPrototype|fail-demo/i);
    }
  });

  it("does not invent contacts when the real contacts request is empty or fails", () => {
    const source = readWebSource("components/AddMemberDialog.tsx");
    expect(source).not.toMatch(/const fallback\s*=\s*items\.length/);
    expect(source).not.toMatch(/catch\s*\(\)\s*=>\s*\{\s*const fallback/);
    expect(source).toContain("Every contact is already in this room.");
  });
});
