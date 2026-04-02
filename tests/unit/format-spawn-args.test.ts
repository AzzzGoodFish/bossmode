import { describe, it, expect } from "vitest";

/**
 * Unit test for formatSpawnArgs (MembersPage.tsx).
 * Extracted logic: split on ` --` boundaries, truncate long values.
 */

function formatSpawnArgs(raw: string): string {
  const parts = raw.split(/\s(?=--)/).map((p) => p.trim()).filter(Boolean);
  return parts
    .map((part) => {
      if (part.length > 120) return part.slice(0, 117) + "...";
      return part;
    })
    .join("\n");
}

describe("formatSpawnArgs (MembersPage)", () => {
  it("splits --flags onto separate lines", () => {
    const result = formatSpawnArgs("claude --output-format stream-json --input-format stream-json --verbose");
    expect(result).toBe(
      "claude\n--output-format stream-json\n--input-format stream-json\n--verbose"
    );
  });

  it("truncates values longer than 120 chars", () => {
    const longValue = "--system-prompt " + "x".repeat(200);
    const result = formatSpawnArgs(`claude ${longValue}`);
    const lines = result.split("\n");
    expect(lines[1].length).toBe(120);
    expect(lines[1].endsWith("...")).toBe(true);
  });

  it("handles single command with no flags", () => {
    expect(formatSpawnArgs("claude")).toBe("claude");
  });

  it("handles empty string", () => {
    expect(formatSpawnArgs("")).toBe("");
  });

  it("preserves flag values that are under 120 chars", () => {
    const result = formatSpawnArgs("claude --model sonnet --effort low");
    expect(result).toBe("claude\n--model sonnet\n--effort low");
  });
});
