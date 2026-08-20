import { useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
const SyntaxHighlighter = PrismLight;

/**
 * W1-2 (assistant-ui markdown-text, fish-picked 2026-08-20): fenced code blocks
 * get a header bar — language label + one-click copy with Copied feedback.
 * Members paste code constantly; copy-by-selection was the daily friction.
 */
function CodeBlockFrame({ language, raw, children }: { language: string; raw: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(raw).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <div className="my-2 overflow-hidden rounded-md border border-line-soft">
      <div className="flex items-center gap-2 border-b border-line-soft bg-surface-2 px-2.5 py-1">
        <span className="font-mono text-[10px] lowercase text-ink-3">{language}</span>
        <button
          type="button"
          onClick={copy}
          className={`ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] cursor-pointer ${copied ? "text-onair" : "text-ink-3 hover:text-ink-1 hover:bg-surface-3"}`}
          title={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {children}
    </div>
  );
}
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import { useMemo } from "react";
import type { Components } from "react-markdown";
import { splitMentionTokens, mentionNameSet, MENTION_PILL_CLASSES } from "../utils/mention-tokens";
import { remarkAutolinkFix } from "../utils/remark-autolink-fix";

SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("ts", typescript);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("js", javascript);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("py", python);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sh", bash);
SyntaxHighlighter.registerLanguage("shell", bash);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("markdown", markdown);
SyntaxHighlighter.registerLanguage("md", markdown);

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const isInline = !match && !className;

    if (isInline) {
      return (
        <code
          className="bg-surface-2 text-accent-ink px-1.5 py-0.5 rounded text-[0.85em] font-mono"
          {...props}
        >
          {children}
        </code>
      );
    }

    const language = match?.[1] || "text";
    const raw = String(children).replace(/\n$/, "");

    // Prism markdown grammar has token-rendering bugs (table syntax gets split
    // into per-token line breaks). Render markdown code blocks as plain text.
    if (language === "markdown" || language === "md") {
      return (
        <CodeBlockFrame language={language} raw={raw}>
          <pre className="overflow-x-auto bg-inset p-3 text-xs text-ink-2 font-mono">
            <code className="whitespace-pre">{raw}</code>
          </pre>
        </CodeBlockFrame>
      );
    }

    return (
      <CodeBlockFrame language={language} raw={raw}>
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          PreTag="div"
          customStyle={{
            margin: 0,
            fontSize: "0.8rem",
          }}
        >
          {raw}
        </SyntaxHighlighter>
      </CodeBlockFrame>
    );
  },
  // Compact styling for other elements
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-2">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-bold mb-1.5 mt-2">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-bold mb-1 mt-2">{children}</h3>,
  a: ({ href, children }) => (
    <a href={href} className="text-accent-ink hover:underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-line pl-3 text-ink-3 my-2">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto bg-surface-2 rounded-md p-3 my-2 text-sm">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 bg-surface-2 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-line px-2 py-1">{children}</td>
  ),
  hr: () => <hr className="border-line my-3" />,
  del: ({ children }) => <del className="text-ink-4">{children}</del>,
};

interface MarkdownProps {
  content: string;
  /** Persisted mention snapshot; only members the router activated tint. */
  mentions?: string[];
  /** `!name` urgent targets (persisted snapshot) → blocked-red tier. */
  urgentMentions?: string[];
  /** Room roster fallback when no snapshot exists. */
  members?: string[];
  /** Human user's login name → amber "@me" tier. */
  loginName?: string | null;
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    hChildren?: unknown[];
  };
}

// Node types that never get mention tinting: code spans/blocks and links
// (design v2: code 内、链接内不高亮).
const SKIP_TYPES = new Set(["code", "inlineCode", "link", "linkReference", "definition", "html"]);

/**
 * remark plugin: split @/! mention tokens out of text nodes into pill spans.
 * Works on the mdast text level, so markdown structure (and code) is untouched.
 * The span is emitted via the mdast data.hName escape hatch (remark-rehype
 * honors it on any node).
 */
export function remarkMentionPills(opts: { names: string[]; urgentNames: string[]; loginName?: string | null }) {
  const walk = (node: MdNode): void => {
    if (!node.children || SKIP_TYPES.has(node.type)) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value) {
        const parts = splitMentionTokens(child.value, opts);
        for (const part of parts) {
          if (part.tier) {
            next.push({
              type: "text",
              value: part.text,
              data: {
                hName: "span",
                hProperties: { className: MENTION_PILL_CLASSES[part.tier], "data-mention-tier": part.tier },
                hChildren: [{ type: "text", value: part.text }],
              },
            });
          } else {
            next.push({ type: "text", value: part.text });
          }
        }
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return () => (tree: MdNode) => walk(tree);
}

export function Markdown({ content, mentions, urgentMentions, members, loginName }: MarkdownProps) {
  const names = mentionNameSet(mentions, members, loginName);
  const plugin = useMemo(
    () => remarkMentionPills({ names, urgentNames: urgentMentions ?? [], loginName }),
    // Names are stable per message render; join for a cheap memo key.
    [names.join("\0"), (urgentMentions ?? []).join("\0"), loginName],
  );
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly, remarkAutolinkFix, plugin]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
