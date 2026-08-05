/**
 * `!` autocomplete trigger unification (fish rc.6 self-test 2026-08-05):
 * typing `!` in the room composer opens the same member menu as `@`.
 *
 * Locks the pure trigger detection: dual gestures, the parser's left-boundary
 * rule for `!` ("Hello!" never pops), filter extraction, and precedence.
 */
import { describe, it, expect } from "vitest";
import { detectMentionTrigger } from "../../web/src/components/MessageInput";

describe("detectMentionTrigger", () => {
  it("@ opens the menu as before, with incremental filter", () => {
    expect(detectMentionTrigger("@")).toEqual({ trigger: "@", filter: "" });
    expect(detectMentionTrigger("hey @p")).toEqual({ trigger: "@", filter: "p" });
    expect(detectMentionTrigger("@dev-b")).toEqual({ trigger: "@", filter: "dev-b" });
  });

  it("! opens the same menu as an urgent trigger", () => {
    expect(detectMentionTrigger("!")).toEqual({ trigger: "!", filter: "" });
    expect(detectMentionTrigger("stop !pm")).toEqual({ trigger: "!", filter: "pm" });
    expect(detectMentionTrigger("(quick !q")).toEqual({ trigger: "!", filter: "q" });
  });

  it("! requires the parser's left boundary — Hello! never pops", () => {
    expect(detectMentionTrigger("Hello!")).toBeNull();
    expect(detectMentionTrigger("Hello!p")).toBeNull();
    expect(detectMentionTrigger("wow!!")).toBeNull();
    expect(detectMentionTrigger("wow!!p")).toBeNull();
    expect(detectMentionTrigger("！pm fullwidth")).toBeNull();
  });

  it("no gesture, no menu", () => {
    expect(detectMentionTrigger("")).toBeNull();
    expect(detectMentionTrigger("plain text")).toBeNull();
    expect(detectMentionTrigger("pm!")).toBeNull();
  });
});
