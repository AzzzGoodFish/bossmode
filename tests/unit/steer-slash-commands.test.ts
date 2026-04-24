import { describe, it, expect } from "vitest";

/**
 * Unit test for slash command detection logic in steerAgent.
 * The actual function is embedded in agent-manager.ts, so we test the logic directly.
 */

function buildUserMessage(instruction: string): string {
  const isSlashCommand = instruction.startsWith('/');
  return isSlashCommand
    ? instruction
    : `[Private message from user @fish]\n\n${instruction}\n\n[ACTION REQUIRED: Call chat tool with target="user". Bare text will NOT be delivered. Do not include mentions. Do not post to the room.]`;
}

describe("steerAgent slash command passthrough", () => {
  it("regular text gets private envelope + footer", () => {
    expect(buildUserMessage("please review the code"))
      .toBe("[Private message from user @fish]\n\nplease review the code\n\n[ACTION REQUIRED: Call chat tool with target=\"user\". Bare text will NOT be delivered. Do not include mentions. Do not post to the room.]");
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
      .toBe("[Private message from user @fish]\n\ncheck the path/to/file\n\n[ACTION REQUIRED: Call chat tool with target=\"user\". Bare text will NOT be delivered. Do not include mentions. Do not post to the room.]");
  });

  it("empty string still gets private envelope", () => {
    expect(buildUserMessage(""))
      .toBe("[Private message from user @fish]\n\n\n\n[ACTION REQUIRED: Call chat tool with target=\"user\". Bare text will NOT be delivered. Do not include mentions. Do not post to the room.]");
  });
});
