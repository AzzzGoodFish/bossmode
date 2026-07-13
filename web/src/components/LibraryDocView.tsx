import { useState, useEffect, useRef, useCallback } from "react";
import { Download, Trash2, Eye, Pencil, Save } from "lucide-react";
import { Markdown } from "../components/Markdown";
import type { LibraryFileFormat } from "../utils/library-file-format";
import { getLibraryFileFormat } from "../utils/library-file-format";

export type LibraryDocKind = LibraryFileFormat;

/**
 * Library workbench doc view: VSCode-style multi-format editor.
 * - md / html: source Edit ↔ rendered Preview (rendered = not editable), explicit Save + Cmd+S, dirty dot.
 * - png: Preview only (images aren't editable).
 * Save is explicit (button / Cmd+S), not on-blur — matches VSCode dirty/save semantics.
 */

export interface LibraryDoc {
  path: string;
  title: string;
  kind: LibraryDocKind;
  content: string; // for png: an image src
  meta?: string; // e.g. "id · by source"
  readOnly?: boolean;
}

interface LibraryDocViewProps {
  doc: LibraryDoc;
  onSave: (content: string) => Promise<void>;
  onDelete?: () => void;
  onDownload?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onRenameTitle?: (title: string) => void;
}

export function LibraryDocView({ doc, onSave, onDelete, onDownload, onDirtyChange }: LibraryDocViewProps) {
  const editable = doc.kind !== "png";
  const format = getLibraryFileFormat(doc.path);
  const [mode, setMode] = useState<"preview" | "edit">(editable ? "edit" : "preview");
  const [draft, setDraft] = useState(doc.content);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const dirty = editable && draft !== doc.content;

  // Reset when switching documents
  useEffect(() => {
    setDraft(doc.content);
    setMode(doc.kind !== "png" ? "edit" : "preview");
  }, [doc.path]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const handleSave = useCallback(async () => {
    if (!dirty || doc.readOnly) return;
    setSaving(true);
    try { await onSave(draft); } finally { setSaving(false); }
  }, [dirty, draft, doc.readOnly, onSave]);

  // Cmd/Ctrl+S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave]);

  const segBtn = (active: boolean) =>
    `flex items-center gap-1 px-2.5 py-1 text-[12px] rounded cursor-pointer transition-colors ${
      active ? "bg-surface-2 text-ink-1" : "text-ink-4 hover:text-ink-2"
    }`;

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-line-soft">
        <div className="min-w-0 flex items-center gap-2">
          {dirty && <span className="w-2 h-2 rounded-full bg-accent shrink-0" title="Unsaved changes" />}
          <span className="text-[15px] font-semibold text-ink-1 truncate font-mono" title={doc.path}>
            {doc.title}
          </span>
          <span title={format.description} className="text-[10px] font-mono uppercase tracking-wide text-ink-3 bg-surface-2 border border-line px-1.5 py-0.5 rounded shrink-0">{format.label}</span>
          {doc.meta && <span className="text-[10px] text-ink-4 font-mono truncate hidden lg:inline">{doc.meta}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {editable && (
            <div className="flex items-center bg-surface-1 border border-line rounded-md p-0.5">
              <button onClick={() => setMode("edit")} className={segBtn(mode === "edit")}><Pencil size={12} /> Edit</button>
              <button onClick={() => setMode("preview")} className={segBtn(mode === "preview")}><Eye size={12} /> Preview</button>
            </div>
          )}
          {editable && (
            <button onClick={() => void handleSave()} disabled={!dirty || saving || doc.readOnly}
              title={doc.readOnly ? "Read-only file — save disabled" : "Save (⌘S)"}
              className="flex items-center gap-1 px-3 py-1.5 text-[12px] rounded-md bg-accent text-accent-contrast font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
              <Save size={12} /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
          )}
          {onDownload && (
            <button onClick={onDownload} title="Download"
              className="p-1.5 text-ink-3 hover:text-ink-1 border border-line rounded-md cursor-pointer"><Download size={14} /></button>
          )}
          {onDelete && (
            <button onClick={onDelete} title="Delete"
              className="p-1.5 text-ink-3 hover:text-blocked border border-line rounded-md cursor-pointer"><Trash2 size={14} /></button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {doc.readOnly && editable && (
          <div className="px-6 pt-3 text-[11px] text-think">Read-only file — edits aren't persisted.</div>
        )}
        {doc.kind === "png" ? (
          <div className="p-6 flex items-center justify-center">
            <img src={doc.content} alt={doc.title} className="max-w-full rounded-md border border-line" />
          </div>
        ) : mode === "edit" ? (
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="w-full h-full min-h-[400px] resize-none bg-transparent text-ink-1 font-mono text-[12.5px] leading-relaxed px-6 py-4 focus:outline-none placeholder-ink-4"
            placeholder={doc.kind === "html" ? "<!doctype html> …" : "# Start writing… (markdown source)"}
          />
        ) : doc.kind === "html" ? (
          <iframe title={doc.title} sandbox="" srcDoc={draft} className="w-full h-full min-h-[400px] bg-white" />
        ) : (
          <div className="px-6 py-4"><Markdown content={draft} /></div>
        )}
      </div>
    </div>
  );
}
