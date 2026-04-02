import { describe, it, expect } from "vitest";

/**
 * Unit test for slash command detection logic in steerAgent.
 * The actual function is embedded in agent-manager.ts, so we test the logic directly.
 */

function buildUserMessage(instruction: string): string {
  const isSlashCommand = instruction.startsWith('/');
  return isSlashCommand
    ? instruction
    : `[Private instruction from user]: ${instruction}`;
}

describe("steerAgent slash command passthrough", () => {
  it("regular text gets [Private instruction] prefix", () => {
    expect(buildUserMessage("please review the code"))
      .toBe("[Private instruction from user]: please review the code");
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
    // Any /xxx is treated as a potential slash command — Claude CLI will handle unknown ones
    expect(buildUserMessage("/unknown-command")).toBe("/unknown-command");
  });

  it("text with / in the middle is NOT a slash command", () => {
    expect(buildUserMessage("check the path/to/file"))
      .toBe("[Private instruction from user]: check the path/to/file");
  });

  it("empty string gets prefix", () => {
    expect(buildUserMessage("")).toBe("[Private instruction from user]: ");
  });
});
