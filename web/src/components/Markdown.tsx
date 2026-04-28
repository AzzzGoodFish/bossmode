import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import PrismLight from "react-syntax-highlighter/dist/esm/prism-light";
const SyntaxHighlighter = PrismLight;
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import type { Components } from "react-markdown";

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
          className="bg-zinc-200 text-emerald-700 dark:bg-zinc-800 dark:text-emerald-400 px-1.5 py-0.5 rounded text-[0.85em] font-mono"
          {...props}
        >
          {children}
        </code>
      );
    }

    const language = match?.[1] || "text";

    // Prism markdown grammar has token-rendering bugs (table syntax gets split
    // into per-token line breaks). Render markdown code blocks as plain text.
    if (language === "markdown" || language === "md") {
      return (
        <pre className="overflow-x-auto bg-zinc-900 rounded-md p-3 my-2 text-xs text-zinc-200 font-mono">
          <code className="whitespace-pre">{String(children).replace(/\n$/, "")}</code>
        </pre>
      );
    }

    return (
      <SyntaxHighlighter
        style={oneDark}
        language={language}
        PreTag="div"
        customStyle={{
          margin: "0.5rem 0",
          borderRadius: "0.375rem",
          fontSize: "0.8rem",
        }}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
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
    <a href={href} className="text-blue-600 dark:text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-zinc-300 dark:border-zinc-600 pl-3 text-zinc-500 dark:text-zinc-400 my-2">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto bg-zinc-100 dark:bg-zinc-800 rounded-md p-3 my-2 text-sm">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-zinc-300 dark:border-zinc-700 px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-zinc-300 dark:border-zinc-700 px-2 py-1">{children}</td>
  ),
  hr: () => <hr className="border-zinc-300 dark:border-zinc-700 my-3" />,
  del: ({ children }) => <del className="text-zinc-400 dark:text-zinc-500">{children}</del>,
};

interface MarkdownProps {
  content: string;
}

export function Markdown({ content }: MarkdownProps) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
