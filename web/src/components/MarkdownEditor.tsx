// WYSIWYG Markdown editor — lazy-loaded MDXEditor wrapper
// Linear-style: no toolbar, pure markdown shortcuts (`# `, `- `, ` ``` `, etc.).
// Only loaded when TaskDetailPage / KnowledgePage renders; zero impact on other views.
import { Suspense, lazy, useRef, useEffect, useState } from "react";

// Lazy import — only loaded on demand
const LazyMDXEditor = lazy(() =>
  import("@mdxeditor/editor").then((mod) => ({ default: mod.MDXEditor }))
);

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

function EditorFallback({ value, placeholder }: { value?: string; placeholder?: string }) {
  return (
    <div className="min-h-[200px] rounded-md text-sm text-ink-2 whitespace-pre-wrap p-1">
      {value || <span className="text-ink-4">{placeholder || "Loading editor..."}</span>}
    </div>
  );
}

function InnerEditor({ value, onChange, placeholder }: MarkdownEditorProps) {
  const editorRef = useRef<any>(null);
  const [plugins, setPlugins] = useState<any[] | null>(null);

  useEffect(() => {
    import("@mdxeditor/editor").then((mod) => {
      setPlugins([
        mod.headingsPlugin(),
        mod.listsPlugin(),
        mod.quotePlugin(),
        mod.thematicBreakPlugin(),
        mod.linkPlugin(),
        mod.linkDialogPlugin(),
        mod.tablePlugin(),
        mod.codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
        mod.codeMirrorPlugin({
          codeBlockLanguages: {
            js: "JavaScript", javascript: "JavaScript",
            ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
            python: "Python", py: "Python",
            bash: "Bash", sh: "Bash", shell: "Bash",
            json: "JSON", yaml: "YAML", css: "CSS",
            html: "HTML", sql: "SQL", md: "Markdown",
            text: "Plain", "": "Plain",
          },
        }),
        mod.markdownShortcutPlugin(),
        // No toolbarPlugin / diffSourcePlugin — Linear-style minimal chrome.
        // All formatting via markdown shortcuts (`# `, `- `, ` ``` `, etc.) +
        // standard keyboard shortcuts (Cmd+B / Cmd+I / Cmd+K).
      ]);
    });
  }, []);

  // Sync external value into editor when value changes from outside
  useEffect(() => {
    if (editorRef.current) {
      const current = editorRef.current.getMarkdown?.();
      if (current !== undefined && current !== value) {
        editorRef.current.setMarkdown(value);
      }
    }
  }, [value]);

  if (!plugins) return <EditorFallback value={value} placeholder={placeholder} />;

  return (
    <LazyMDXEditor
      ref={editorRef}
      markdown={value}
      onChange={onChange}
      plugins={plugins}
      placeholder={placeholder}
      contentEditableClassName="mdx-content"
    />
  );
}

export function MarkdownEditor({ value, onChange, placeholder, className }: MarkdownEditorProps) {
  return (
    <div className={`markdown-editor relative ${className || ""}`}>
      <Suspense fallback={<EditorFallback value={value} placeholder={placeholder} />}>
        <InnerEditor value={value} onChange={onChange} placeholder={placeholder} />
      </Suspense>
    </div>
  );
}
