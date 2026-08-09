// Remark plugin: trim trailing markdown symbols and CJK/full-width punctuation
// from autolink URLs produced by remark-gfm's autolink-literal.
//
// Problem: GFM autolink only breaks at ASCII whitespace, so a URL followed by
// `**` (markdown bold) or CJK punctuation (。，、：（） etc.) gets those chars
// swallowed into the URL. This plugin walks the parsed mdast and trims
// trailing non-URL chars from link nodes whose URL looks like an autolink.
//
// Runs AFTER remark-gfm in the plugin chain so it sees the final link nodes.

import type { Plugin } from "unified";
import type { Root, Link } from "mdast";
import { visit } from "unist-util-visit";

// Chars to strip from the tail of an autolink URL.
// Includes: markdown symbols (*, ~, _, `), CJK + full-width punctuation,
// ASCII punctuation that GFM already partially handles but not exhaustively.
const TRAILING_STRIP = /[\s\*_~`]+$|[。，、：；！？「」（）【】《》〈〉""''…—]+$|[).,!?:;'\]\}>]+$]/g;

// CJK / full-width char at the boundary (also break before these if mid-URL).
const CJK_BOUNDARY = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

export const remarkAutolinkFix: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "link", (node: Link) => {
      if (!node.url || typeof node.url !== "string") return;
      // Only fix http/https URLs (skip scheme: and mailto:).
      if (!/^https?:\/\//.test(node.url)) return;

      let url = node.url;
      let trimmed = false;

      // First cut at CJK boundary (Punycode domains are ASCII — real URLs
      // don't contain CJK chars after the scheme).
      const cjkMatch = url.slice(8).match(CJK_BOUNDARY); // skip "https://"
      if (cjkMatch && cjkMatch.index !== undefined) {
        url = url.slice(0, 8 + cjkMatch.index);
        trimmed = true;
      }

      // Then strip trailing markdown/punctuation chars exposed by the cut.
      const before = url;
      url = url.replace(TRAILING_STRIP, "");
      if (url !== before) trimmed = true;

      if (trimmed) {
        node.url = url;
        // Also trim the displayed text children to match the shortened URL.
        // remark-gfm autolink-literal creates a single text child whose value
        // equals the original (pre-trim) URL — it still carries the trailing
        // CJK/markdown chars in the visible text.
        if (node.children) {
          for (const child of node.children) {
            if (child.type === "text" && typeof child.value === "string") {
              let text = child.value;
              const cjkText = text.slice(8).match(CJK_BOUNDARY);
              if (cjkText && cjkText.index !== undefined) {
                text = text.slice(0, 8 + cjkText.index);
              }
              text = text.replace(TRAILING_STRIP, "");
              child.value = text;
            }
          }
        }
      }
    });
  };
};
