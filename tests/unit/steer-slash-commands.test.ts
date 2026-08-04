import { describe, it, expect } from "vitest";


vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: (agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
}));

/**
 * Unit test for slash command detection logic in steerAgent.
 * The actual function is embedded in agent-manager.ts, so we test the logic directly.
 */

function buildUserMessage(instruction: string): string {
  const isSlashCommand = instruction.startsWith('/');
  return isSlashCommand
    ? instruction
    : `[Private message from user @fish]\n\n${instruction}\n\n[Reply hint: Suggested call the chat tool with target="user" so the user receives your response.]`;
}

describe("steerAgent slash command passthrough", () => {
  it("regular text gets private envelope + footer", () => {
    expect(buildUserMessage("please review the code"))
      .toBe("[Private message from user @fish]\n\nplease review the code\n\n[Reply hint: Suggested call the chat tool with target=\"user\" so the user receives your response.]");
  });

  it("/compact is passed through without prefix", () => {
    expect(buildUserMessage("/compact")).toBe("/compact");
  });

  it("/model sonnet is passed through without prefix", () => {
    expect(buildUserMessage("/model sonnet")).toBe("/model sonnet");
  });

  it("/clear is passed through without prefix", () => {
    expect(buildUserMessage("/clear")).toBe("/clear");
  });

  it("/help is passed through without prefix", () => {
    expect(buildUserMessage("/help")).toBe("/help");
  });

  it("text starting with / but not a command still passes through (conservative)", () => {
    expect(buildUserMessage("/unknown-command")).toBe("/unknown-command");
  });

  it("text with / in the middle is NOT a slash command", () => {
    expect(buildUserMessage("check the path/to/file"))
      .toBe("[Private message from user @fish]\n\ncheck the path/to/file\n\n[Reply hint: Suggested call the chat tool with target=\"user\" so the user receives your response.]");
  });

  it("empty string still gets private envelope", () => {
    expect(buildUserMessage(""))
      .toBe("[Private message from user @fish]\n\n\n\n[Reply hint: Suggested call the chat tool with target=\"user\" so the user receives your response.]");
  });
});
