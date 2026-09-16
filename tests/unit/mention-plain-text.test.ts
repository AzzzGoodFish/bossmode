/**
 * `!name` gesture retired (fish #19455): bang text is plain text — never parsed,
 * never activating, no urgent snapshot. `@` parsing is unchanged; code segments
 * stay literal (inline + fenced).
 */
import {describe,it,expect} from "vitest";
import {parseMentions} from "../../src/chat/router.js";

const MEMBERS = ["pm", "qa", "dev-ben"];

describe("`!name` is plain text", () => {
  it("parses no mentions from bang text, standing, punctuated or glued", () => {
    expect(parseMentions("!pm please stop and reply", MEMBERS)).toEqual([]);
    expect(parseMentions("see above. !qa now", MEMBERS)).toEqual([]);
    expect(parseMentions("(!dev-ben) asap", MEMBERS)).toEqual([]);
    expect(parseMentions("Hello!pm how are you", MEMBERS)).toEqual([]);
    expect(parseMentions("wow!!pm", MEMBERS)).toEqual([]);
    expect(parseMentions("！pm 全角不算", MEMBERS)).toEqual([]);
    expect(parseMentions("!ghost nobody", MEMBERS)).toEqual([]);
    expect(parseMentions("!all stop everything", MEMBERS)).toEqual([]);
  });

  it("@ mentions are unchanged and coexist with bang text", () => {
    expect(parseMentions("@qa look, and !pm !pm now", MEMBERS)).toEqual(["qa"]);
    expect(parseMentions("@pm and @qa", MEMBERS)).toEqual(["pm", "qa"]);
  });

  it("code segments are literal: backticked @ never parses (inline + fenced)", () => {
    expect(parseMentions("对照 `@pm` 应字面", MEMBERS)).toEqual([]);
    expect(parseMentions("```\n@pm in a fence\n```", MEMBERS)).toEqual([]);
    expect(parseMentions("real @pm plus `@qa`", MEMBERS)).toEqual(["pm"]);
    // unclosed fence runs to end
    expect(parseMentions("```\n@pm", MEMBERS)).toEqual([]);
  });
});
