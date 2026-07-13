import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readWebSource = (path: string) => readFileSync(resolve(root, "web/src", path), "utf8");

describe("production Team mock guard", () => {
  it("does not let Team routes import or render the former mock data source", () => {
    for (const path of ["pages/AgentsPage.tsx", "pages/AgentProfilePage.tsx", "components/CreateRoomDialog.tsx"]) {
      const source = readWebSource(path);
      expect(source).not.toMatch(/team-mock|agentTemplateStats|mock data|CreateRoomDraftPrototype|fail-demo/i);
    }
  });

  it("does not invent Agent templates when the real Agent request is empty or fails", () => {
    const source = readWebSource("components/AddMemberDialog.tsx");
    expect(source).not.toMatch(/const fallback\s*=\s*items\.length/);
    expect(source).not.toMatch(/catch\s*\(\)\s*=>\s*\{\s*const fallback/);
    expect(source).toContain("Couldn’t load Agent templates.");
    expect(source).toContain("No Agent templates are available yet.");
  });
});
