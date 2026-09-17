import { expect, it, vi } from "vitest";
vi.mock("node:fs", () => new Proxy({}, { get: (_target, key) => {
  if (key === "then") return undefined;
  return () => { throw new Error(`Unexpected filesystem operation: ${String(key)}`); };
} }));
import { compileMemberPrompt, type MemberPromptSource } from "../../src/agent/prompt.js";

const source: MemberPromptSource = {
  memberId: "mem_snapshot", memberName: "Snapshot", description: "Engineer",
  persona: "  Literal member instructions.  \n", profileOverBudget: false,
  skillsEnabled: "bossmode-guide, editing", platformSkillsDir: "/package/skills", archiveAvailable: false,
};

it("compiles captured member assets without filesystem or database lookup", () => {
  const first = compileMemberPrompt(source);
  expect(first.agentPrompt).toBe("# Persona\n\nI am Snapshot (Engineer), an AI teammate in Bossmode.\n\nLiteral member instructions.");
  expect(first.fullPrompt).toContain("Enabled: bossmode-guide, editing");
  expect(first.fullPrompt).toContain("/package/skills/bossmode-guide/SKILL.md");
  expect(first.fullPrompt).not.toContain("history migrated from the old system");
  expect(compileMemberPrompt(source)).toEqual(first);
});

it("retains identity for an empty persona and reports only the supplied archive and budget facts", () => {
  const result = compileMemberPrompt({ ...source, persona: "", description: undefined, archiveAvailable: true, profileOverBudget: true });
  expect(result.agentPrompt).toBe("# Persona\n\nI am Snapshot, an AI teammate in Bossmode.");
  expect(result.fullPrompt).toContain("history migrated from the old system");
  expect(result.profileOverBudget).toBe(true);
});
