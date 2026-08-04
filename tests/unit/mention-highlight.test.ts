/**
 * Mention highlight three tiers (designer mention-highlight v2, fish-approved).
 *
 * Locks the token splitter (tiers + boundaries) and the remark plugin's mdast
 * transform (pill spans in text, never inside code/links).
 */
import { describe, it, expect } from "vitest";
import { splitMentionTokens, mentionNameSet, MENTION_PILL_CLASSES } from "../../web/src/utils/mention-tokens";
import { remarkMentionPills } from "../../web/src/components/Markdown";

const OPTS = {
  names: ["pm", "qa", "fish"],
  urgentNames: ["pm"],
  loginName: "fish",
};

describe("splitMentionTokens — three tiers", () => {
  it("@member → member tier, @loginName → self tier, !member (snapshotted) → urgent tier", () => {
    const parts = splitMentionTokens("@qa please review, @fish 看一下, !pm 立刻停下", OPTS);
    const tinted = parts.filter((p) => p.tier);
    expect(tinted).toEqual([
      { text: "@qa", tier: "member" },
      { text: "@fish", tier: "self" },
      { text: "!pm", tier: "urgent" },
    ]);
  });

  it("! before a non-urgent name stays plain text (parser never fired)", () => {
    const parts = splitMentionTokens("!qa 没快照", { names: ["qa"], urgentNames: [] });
    expect(parts.every((p) => !p.tier)).toBe(true);
    expect(parts.map((p) => p.text).join("")).toBe("!qa 没快照");
  });

  it("Hello!pm never fires; @ keeps its no-left-boundary behavior", () => {
    expect(splitMentionTokens("Hello!pm", { names: ["pm"], urgentNames: ["pm"] }).every((p) => !p.tier)).toBe(true);
    expect(splitMentionTokens("wow!!pm", { names: ["pm"], urgentNames: ["pm"] }).every((p) => !p.tier)).toBe(true);
    // @ matches without a left boundary (long-standing router-consistent behavior)
    expect(splitMentionTokens("mail@pm", { names: ["pm"] }).some((p) => p.tier === "member")).toBe(true);
  });

  it("non-member names never tint; full-width ！ never fires", () => {
    expect(splitMentionTokens("@ghost 和 !ghost", { names: ["pm"], urgentNames: ["pm"] }).every((p) => !p.tier)).toBe(true);
    expect(splitMentionTokens("！pm 全角", { names: ["pm"], urgentNames: ["pm"] }).every((p) => !p.tier)).toBe(true);
  });

  it("pill classes come from existing tokens only", () => {
    expect(MENTION_PILL_CLASSES.member).toContain("bg-accent-dim");
    expect(MENTION_PILL_CLASSES.self).toContain("bg-think-dim");
    expect(MENTION_PILL_CLASSES.urgent).toContain("bg-blocked-dim");
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
  const pluginOpts = { names: ["pm", "qa", "fish"], urgentNames: ["pm"], loginName: "fish" };

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
      ["!pm", "urgent"],
      ["@qa", "member"],
      ["@fish", "self"],
    ]);
    // non-mention text preserved around the pills
    expect(kids.filter((k: any) => !k.data).map((k: any) => k.value).join("")).toBe(" stop,  later,  看");
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
