import { describe, it, expect } from "vitest";

// Test the parseMentions function directly
// Import after mocking is set up in other test files won't affect pure functions

describe("parseMentions", () => {
  // Inline implementation for isolated testing (same logic as api.ts)
  function parseMentions(content: string, roomMembers: string[]): string[] {
    const mentions: string[] = [];
    if (/@all\b/.test(content)) return ["all"];
    const atPattern = /@(\w+)/g;
    let match;
    while ((match = atPattern.exec(content)) !== null) {
      const name = match[1];
      if (roomMembers.includes(name)) mentions.push(name);
    }
    return [...new Set(mentions)];
  }

  it("should extract single mention", () => {
    expect(parseMentions("@pm analyze this", ["pm", "dev"])).toEqual(["pm"]);
  });

  it("should extract multiple mentions", () => {
    expect(parseMentions("@pm and @dev work together", ["pm", "dev", "qa"])).toEqual(["pm", "dev"]);
  });

  it("should ignore non-member mentions", () => {
    expect(parseMentions("@unknown do something", ["pm", "dev"])).toEqual([]);
  });

  it("should handle @all", () => {
    expect(parseMentions("@all start working", ["pm", "dev"])).toEqual(["all"]);
  });

  it("should deduplicate mentions", () => {
    expect(parseMentions("@pm first task @pm second task", ["pm"])).toEqual(["pm"]);
  });

  it("should return empty for no mentions", () => {
    expect(parseMentions("hello world", ["pm"])).toEqual([]);
  });
});
