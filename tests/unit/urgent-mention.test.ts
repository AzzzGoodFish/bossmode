/**
 * Urgent `!name` gesture — parser boundaries (SQL routing is covered by core-message-capture) (fish 2026-08-04).
 *
 * Locks:
 * - `!name` matches only real member names with a left boundary
 *   ("Hello!pm", "wow!!pm", full-width `！` never fire)
 * - `!all` is not a thing
 * - persisted urgentMentionMemberIds route through onUrgentMention; the rest
 *   keep the normal onMention path; self-mentions are skipped either way
 */
import {describe,it,expect} from "vitest";
import {parseMentions,parseUrgentMentions,parseUrgentMentionMemberIds} from "../../src/communication/router.js";

const MEMBERS = ["pm", "qa", "dev-ben"];
const MEMBER_RECORDS = [
  { id: "rm_pm", name: "pm" },
  { id: "rm_qa", name: "qa" },
  { id: "rm_devben", name: "dev-ben" },
] as any[];

describe("parseUrgentMentions", () => {
  it("matches member names at message start and after whitespace/punctuation", () => {
    expect(parseUrgentMentions("!pm please stop and reply", MEMBERS)).toEqual(["pm"]);
    expect(parseUrgentMentions("see above. !qa now", MEMBERS)).toEqual(["qa"]);
    expect(parseUrgentMentions("(!dev-ben) asap", MEMBERS)).toEqual(["dev-ben"]);
  });

  it("never fires when glued to a word char or another bang", () => {
    expect(parseUrgentMentions("Hello!pm how are you", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("wow!!pm", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("great!pm", MEMBERS)).toEqual([]);
  });

  it("never fires on full-width ！, non-members, or !all", () => {
    expect(parseUrgentMentions("！pm 全角不算", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("!ghost nobody", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("!all stop everything", MEMBERS)).toEqual([]);
  });

  it("coexists with @ mentions and dedupes", () => {
    expect(parseUrgentMentions("@qa look, and !pm !pm now", MEMBERS)).toEqual(["pm"]);
  });

  it("code segments are literal text: backticked !name never parses (inline + fenced)", () => {
    expect(parseUrgentMentions("对照 `!pm` 应字面", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("```\n!pm in a fence\n```", MEMBERS)).toEqual([]);
    expect(parseUrgentMentions("real !pm plus `!qa`", MEMBERS)).toEqual(["pm"]);
    // unclosed fence runs to end
    expect(parseUrgentMentions("```\n!pm", MEMBERS)).toEqual([]);
  });

  it("@ follows the same rule: code-span @name never activates", () => {
    expect(parseMentions("讨论 `@pm` 这个手势", MEMBERS)).toEqual([]);
    expect(parseMentions("```\n@pm fenced\n```", MEMBERS)).toEqual([]);
    expect(parseMentions("real @pm plus `@qa`", MEMBERS)).toEqual(["pm"]);
    expect(parseMentions("`@all` fenced out", MEMBERS)).toEqual([]);
  });

  it("maps to member ids", () => {
    expect(parseUrgentMentionMemberIds("!pm and !qa", MEMBER_RECORDS)).toEqual(["rm_pm", "rm_qa"]);
    expect(parseUrgentMentionMemberIds("Hello!pm", MEMBER_RECORDS)).toEqual([]);
  });
});
