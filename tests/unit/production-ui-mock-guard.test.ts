import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readWebSource = (path: string) => readFileSync(resolve(root, "web/src", path), "utf8");

describe("production UI mock guard", () => {
  it("does not let member/contact surfaces import or render mock data sources", () => {
    for (const path of [
      "pages/ChatsPage.tsx",
      "pages/DmPage.tsx",
      "pages/MemberCreatePage.tsx",
      "components/member-float.tsx",
      "components/CreateRoomDialog.tsx",
      "components/MemberPickerDialog.tsx",
    ]) {
      const source = readWebSource(path);
      expect(source).not.toMatch(/team-mock|agentTemplateStats|mock data|mock\/contacts|MOCK_MEMBERS|CreateRoomDraftPrototype|fail-demo/i);
    }
  });

  it("room creation has no template, cloning or draft-name client path", () => {
    for (const path of ["components/CreateRoomDialog.tsx", "components/MemberPickerDialog.tsx"]) {
      expect(readWebSource(path)).not.toMatch(/getAgents|PickedMemberDraft|DraftMemberEditor|suggestMemberName|createMember|createAgent|onPickAgent/);
    }
    const client = readWebSource("api/client.ts");
    expect(client).not.toMatch(/export (?:async function|interface) (?:getAgents|getAgent|createAgent|updateAgent|deleteAgent|forceDeleteAgent|getAgentTemplates|getTemplates|AgentInfo|AgentDetail|CreateRoomMemberInput)\b/);
    expect(client).toContain('"/api/skills/templates"');
    const main = readWebSource("pages/Main.tsx");
    expect(main).toContain("apiCreateRoom(name, memberIds, leaderMemberId)");
    expect(main).not.toContain("promptLeaderMemberName");
  });

  it("does not invent contacts when the real contacts request is empty or fails", () => {
    const source = readWebSource("components/AddMemberDialog.tsx");
    expect(source).not.toMatch(/const fallback\s*=\s*items\.length/);
    expect(source).not.toMatch(/catch\s*\(\)\s*=>\s*\{\s*const fallback/);
    expect(source).toContain("Every contact is already in this room.");
  });
});
