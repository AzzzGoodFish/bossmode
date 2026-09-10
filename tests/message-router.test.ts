import { describe, it, expect } from "vitest";
import { parseMentionMemberIds, parseMentions } from "../src/communication/router.js";

describe("parseMentions", () => {
  const members = ["pm", "dev", "qa", "dev-opus", "arch-sonnet"];

  it("should extract single mention", () => {
    expect(parseMentions("@pm analyze this", members)).toEqual(["pm"]);
  });

  it("should extract multiple mentions", () => {
    expect(parseMentions("@pm and @dev work together", members)).toEqual(["pm", "dev"]);
  });

  it("should ignore non-member mentions", () => {
    expect(parseMentions("@unknown do something", members)).toEqual([]);
  });

  it("should handle @all", () => {
    expect(parseMentions("@all start working", members)).toEqual(["all"]);
  });

  it("should deduplicate mentions", () => {
    expect(parseMentions("@pm first task @pm second task", members)).toEqual(["pm"]);
  });

  it("should return empty for no mentions", () => {
    expect(parseMentions("hello world", members)).toEqual([]);
  });

  it("should match hyphenated member names", () => {
    expect(parseMentions("@dev-opus please review", members)).toEqual(["dev-opus"]);
  });

  it("should match multiple hyphenated names", () => {
    expect(parseMentions("@dev-opus and @arch-sonnet collaborate", members)).toEqual(["dev-opus", "arch-sonnet"]);
  });

  it("should match mix of hyphenated and simple names", () => {
    expect(parseMentions("@pm and @dev-opus work together", members)).toEqual(["pm", "dev-opus"]);
  });

  it("keeps @dev-a bound to its exact stable member id", () => {
    expect(parseMentionMemberIds("@dev-a please review", [
      { id: "member-dev", name: "dev", agent: "developer" },
      { id: "member-dev-a", name: "dev-a", agent: "developer" },
    ])).toEqual(["member-dev-a"]);
  });
});
