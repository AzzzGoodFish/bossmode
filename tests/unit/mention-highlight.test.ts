/**
 * Mention highlight two tiers (mention-highlight v2; the `!name` urgent tier
 * retired 2026-09-11).
 *
 * Locks the token splitter (tiers + boundaries) and the remark plugin's mdast
 * transform (pill spans in text, never inside code/links).
 */
import { describe, it, expect } from "vitest";
import { splitMentionTokens, mentionNameSet, MENTION_PILL_CLASSES } from "../../web/src/utils/mention-tokens";
import { remarkMentionPills } from "../../web/src/components/Markdown";

const OPTS = {
  names: ["pm", "qa", "fish"],
  loginName: "fish",
};

describe("splitMentionTokens — two tiers", () => {
  it("@member → member tier, @loginName → self tier; `!name` is plain text", () => {
    const parts = splitMentionTokens("@qa please review, @fish 看一下, !pm 立刻停下", OPTS);
    const tinted = parts.filter((p) => p.tier);
    expect(tinted).toEqual([
      { text: "@qa", tier: "member" },
      { text: "@fish", tier: "self" },
    ]);
    expect(parts.map((p) => p.text).join("")).toBe("@qa please review, @fish 看一下, !pm 立刻停下");
  });

  it("`!name` never tints, glued or standing", () => {
    const parts = splitMentionTokens("!qa 没快照", { names: ["qa"] });
    expect(parts.every((p) => !p.tier)).toBe(true);
    expect(parts.map((p) => p.text).join("")).toBe("!qa 没快照");
    expect(splitMentionTokens("Hello!pm", { names: ["pm"] }).every((p) => !p.tier)).toBe(true);
    expect(splitMentionTokens("wow!!pm", { names: ["pm"] }).every((p) => !p.tier)).toBe(true);
  });

  it("@ keeps its no-left-boundary behavior", () => {
    // @ matches without a left boundary (long-standing router-consistent behavior)
    expect(splitMentionTokens("mail@pm", { names: ["pm"] }).some((p) => p.tier === "member")).toBe(true);
  });

  it("non-member names never tint; full-width ！ never fires", () => {
    expect(splitMentionTokens("@ghost 和 !ghost", { names: ["pm"] }).every((p) => !p.tier)).toBe(true);
    expect(splitMentionTokens("！pm 全角", { names: ["pm"] }).every((p) => !p.tier)).toBe(true);
  });

  it("pill classes come from existing tokens only", () => {
    expect(MENTION_PILL_CLASSES.member).toContain("bg-accent-dim");
    expect(MENTION_PILL_CLASSES.self).toContain("bg-think-dim");
  });
});

describe("splitMentionTokens — code is literal", () => {
  it("backticked @ never tints on the plain-text path (user messages)", () => {
    const parts = splitMentionTokens("对照 `@pm` 与 `@qa` 均应字面", OPTS);
    expect(parts.every((p) => !p.tier)).toBe(true);
    // original text preserved byte-for-byte (strip is whitespace-only)
    expect(parts.map((p) => p.text).join("")).toBe("对照 `@pm` 与 `@qa` 均应字面");
  });

  it("fenced blocks never tint; tokens outside code still do", () => {
    const fenced = splitMentionTokens("```\n@pm\n@qa\n```\nreal @qa", OPTS);
    const tinted = fenced.filter((p) => p.tier);
    expect(tinted).toEqual([{ text: "@qa", tier: "member" }]);
  });

  it("backend and web stripCodeSegments are byte-identical", async () => {
    const backend = await import("../../src/kernel/markdown.js");
    const web = await import("../../web/src/utils/mention-tokens");
    const cases = ["plain", "`inline` x", "```\nblock\n``` y", "unclosed ``` tail", "a `b` c `d` e", "`!pm`"];
    for (const c of cases) {
      expect(web.stripCodeSegments(c)).toBe(backend.stripCodeSegments(c));
      expect(web.stripCodeSegments(c)).toHaveLength(c.length);
    }
  });
});

describe("mentionNameSet", () => {
  it("snapshot wins when present; roster is fallback; loginName always included", () => {
    expect(mentionNameSet(["pm"], ["pm", "qa"], "fish").sort()).toEqual(["fish", "pm"]);
    expect(mentionNameSet(undefined, ["pm", "qa"], "fish").sort()).toEqual(["fish", "pm", "qa"]);
    expect(mentionNameSet([], ["pm"], undefined)).toEqual([]);
  });
});

describe("remarkMentionPills mdast transform", () => {
  const pluginOpts = { names: ["pm", "qa", "fish"], loginName: "fish" };

  function transform(tree: any): any {
    remarkMentionPills(pluginOpts)()(tree);
    return tree;
  }

  it("wraps mention tokens in pill spans with tier data", () => {
    const tree = transform({
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "!pm stop, @qa later, @fish 看" }] }],
    });
    const kids = tree.children[0].children;
    const pills = kids.filter((k: any) => k.data?.hName === "span");
    expect(pills.map((p: any) => [p.value, p.data.hProperties["data-mention-tier"]])).toEqual([
      ["@qa", "member"],
      ["@fish", "self"],
    ]);
    // non-mention text preserved around the pills (bang text stays plain)
    expect(kids.filter((k: any) => !k.data).map((k: any) => k.value).join("")).toBe("!pm stop,  later,  看");
  });

  it("never tints inside code spans, code blocks, or links", () => {
    const tree = transform({
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "inlineCode", value: "!pm" }] },
        { type: "code", value: "@pm and !qa" },
        { type: "paragraph", children: [{ type: "link", children: [{ type: "text", value: "!pm link" }] }] },
      ],
    });
    const flat = JSON.stringify(tree);
    expect(flat).not.toContain("data-mention-tier");
  });
});
