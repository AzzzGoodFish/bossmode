import { describe, it, expect } from "vitest";
import { toRulePath } from "../src/member/templates.js";

describe("toRulePath — canonical rule naming", () => {
  it("maps dev-team/team-prompt.md → rules/team-dev-protocol.md", () => {
    expect(toRulePath("dev-team/team-prompt.md")).toBe("rules/team-dev-protocol.md");
  });

  it("maps lite-team/team-prompt.md → rules/team-lite-protocol.md", () => {
    expect(toRulePath("lite-team/team-prompt.md")).toBe("rules/team-lite-protocol.md");
  });

  it("maps dev-team/rules/ssot.md → rules/member-ssot.md", () => {
    expect(toRulePath("dev-team/rules/ssot.md")).toBe("rules/member-ssot.md");
  });

  it("maps lite-team/rules/ssot.md → rules/member-ssot.md", () => {
    expect(toRulePath("lite-team/rules/ssot.md")).toBe("rules/member-ssot.md");
  });

  it("maps universal-principles.md → rules/member-universal-principles.md", () => {
    expect(toRulePath("universal-principles.md")).toBe("rules/member-universal-principles.md");
  });

  it("handles backslash separators (Windows)", () => {
    expect(toRulePath("dev-team\\team-prompt.md")).toBe("rules/team-dev-protocol.md");
    expect(toRulePath("dev-team\\rules\\ssot.md")).toBe("rules/member-ssot.md");
  });
});
