// WYSIWYG Markdown editor — lazy-loaded MDXEditor wrapper
// Only loaded when TaskDetailPage renders; zero impact on other views.
import { Suspense, lazy, useRef, useEffect, useState, forwardRef, type ForwardedRef } from "react";

// Lazy import — ~250KB gzip only loaded on demand
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
    <div className="min-h-[200px] rounded-md text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap p-1">
      {value || <span className="text-zinc-400 dark:text-zinc-600">{placeholder || "Loading editor..."}</span>}
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
        mod.diffSourcePlugin({ viewMode: "rich-text", diffMarkdown: "" }),
        mod.toolbarPlugin({
          toolbarClassName: "mdx-toolbar",
          toolbarContents: () => (
            <mod.DiffSourceToggleWrapper>
              <mod.UndoRedo />
              <ToolbarSep />
              <mod.BoldItalicUnderlineToggles />
              <ToolbarSep />
              <mod.ListsToggle />
              <mod.BlockTypeSelect />
              <ToolbarSep />
              <mod.CreateLink />
              <mod.InsertCodeBlock />
              <mod.InsertTable />
            </mod.DiffSourceToggleWrapper>
          ),
        }),
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

function ToolbarSep() {
  return <div className="w-px h-5 bg-zinc-200 dark:bg-zinc-700 mx-0.5 self-center" />;
}

export function MarkdownEditor({ value, onChange, placeholder, className }: MarkdownEditorProps) {
  return (
    <div className={`markdown-editor group/editor relative rounded-md transition-all focus-within:ring-2 focus-within:ring-blue-500/30 ${className || ""}`}>
      <Suspense fallback={<EditorFallback value={value} placeholder={placeholder} />}>
        <InnerEditor value={value} onChange={onChange} placeholder={placeholder} />
      </Suspense>
    </div>
  );
}
