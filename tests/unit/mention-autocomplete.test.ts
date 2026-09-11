/**
 * Composer mention menu trigger: `@` opens the member menu.
 *
 * The `!` urgent gesture retired 2026-09-11 — `!` no longer opens a menu and
 * its left-boundary behavior is gone with it.
 */
import { describe, it, expect } from "vitest";
import { detectMentionTrigger } from "../../web/src/components/MessageInput";

describe("detectMentionTrigger", () => {
  it("@ opens the menu, with incremental filter", () => {
    expect(detectMentionTrigger("@")).toEqual({ trigger: "@", filter: "" });
    expect(detectMentionTrigger("hey @p")).toEqual({ trigger: "@", filter: "p" });
    expect(detectMentionTrigger("@dev-b")).toEqual({ trigger: "@", filter: "dev-b" });
  });

  it("! never opens the menu (urgent gesture retired)", () => {
    expect(detectMentionTrigger("!")).toBeNull();
    expect(detectMentionTrigger("stop !pm")).toBeNull();
    expect(detectMentionTrigger("(quick !q")).toBeNull();
    expect(detectMentionTrigger("Hello!p")).toBeNull();
    expect(detectMentionTrigger("！pm fullwidth")).toBeNull();
  });

  it("no gesture, no menu", () => {
    expect(detectMentionTrigger("")).toBeNull();
    expect(detectMentionTrigger("plain text")).toBeNull();
    expect(detectMentionTrigger("pm!")).toBeNull();
  });
});
