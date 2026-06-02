// MarkdownField — unified View ↔ Edit toggle for markdown content.
// View: react-markdown rendering + hover Edit button.
// Edit: lazy-loaded MDXEditor + Save/Cancel toolbar.
// See design-spec-markdown-field-v1.md for full spec.

import { useState, useEffect, useCallback } from "react";
import { Pencil, Check } from "lucide-react";
import { Markdown } from "./Markdown";
import { MarkdownEditor } from "./MarkdownEditor";

interface MarkdownFieldProps {
  /** Current markdown content */
  value: string;
  /** Called on Save with new content — parent decides when to persist */
  onChange: (next: string) => void;
  /** Placeholder text for empty state */
  placeholder?: string;
  /** Force read-only: no Edit button, no editing */
  readOnly?: boolean;
  /** Minimum height for view mode (avoids too-short empty state) */
  minHeight?: number;
  /** Additional CSS class */
  className?: string;
  /** Start in Edit mode (e.g. task creation page) */
  autoEdit?: boolean;
  /** Reports unsaved local edits while in manual edit mode */
  onDirtyChange?: (dirty: boolean) => void;
}

export function MarkdownField({
  value,
  onChange,
  placeholder = "Click to add content…",
  readOnly = false,
  minHeight = 120,
  className = "",
  autoEdit = false,
  onDirtyChange,
}: MarkdownFieldProps) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(value);

  // Sync external value into draft when not editing
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  /**
   * In autoEdit mode (e.g. task creation), changes are committed continuously.
   * The parent owns the save semantic via its own page-level button — the
   * field-local Save/Cancel are meaningless because there's no "View" target
   * to switch to yet.
   */
  const handleDraftChange = useCallback((next: string) => {
    setDraft(next);
    if (autoEdit) onChange(next);
  }, [autoEdit, onChange]);

  const enterEdit = useCallback(() => {
    if (readOnly) return;
    setDraft(value);
    setEditing(true);
  }, [readOnly, value]);

  const handleSave = useCallback(() => {
    onChange(draft);
    setEditing(false);
  }, [draft, onChange]);

  const handleCancel = useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  useEffect(() => {
    onDirtyChange?.(!autoEdit && editing && draft !== value);
  }, [autoEdit, draft, editing, onDirtyChange, value]);

  // Keyboard shortcuts: Esc = cancel, Cmd/Ctrl+Enter = save
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleCancel(); }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSave(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, handleSave, handleCancel]);

  // ── Edit mode ──
  if (editing) {
    return (
      <div className={`markdown-field markdown-field--editing ${className}`}>
        {!autoEdit && (
          <div className="sticky top-0 z-20 mb-3 pb-3 border-b border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur flex items-center gap-2">
            <button
              onClick={handleSave}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-md transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Check size={14} /> Save
              <span className="hidden md:inline ml-1 text-[10px] text-blue-100/80 font-mono">⌘↵</span>
            </button>
            <button
              onClick={handleCancel}
              className="px-3 py-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              Cancel
              <span className="hidden md:inline text-[10px] text-zinc-400 font-mono">Esc</span>
            </button>
          </div>
        )}
        <MarkdownEditor
          value={draft}
          onChange={handleDraftChange}
          placeholder={placeholder}
        />
      </div>
    );
  }

  // ── View mode: empty state (whole region clickable) ──
  if (!value.trim()) {
    return (
      <button
        type="button"
        onClick={enterEdit}
        disabled={readOnly}
        style={{ minHeight }}
        className={`markdown-field markdown-field--empty group/field w-full flex items-center justify-start text-left px-3 py-2 rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-900/30 hover:border-zinc-400 dark:hover:border-zinc-600 hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40 transition-colors text-sm text-zinc-400 dark:text-zinc-500 disabled:cursor-not-allowed disabled:opacity-60 cursor-text ${className}`}
      >
        {placeholder}
      </button>
    );
  }

  // ── View mode: rendered markdown + hover Edit button ──
  return (
    <div
      style={{ minHeight }}
      className={`markdown-field markdown-field--view group/field relative ${className}`}
    >
      <div className="prose-rendered">
        <Markdown content={value} />
      </div>
      {!readOnly && (
        <button
          type="button"
          onClick={enterEdit}
          aria-label="Edit"
          className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-white/90 dark:bg-zinc-900/90 backdrop-blur-sm border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-white dark:hover:bg-zinc-800 shadow-sm opacity-0 group-hover/field:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer md:flex"
        >
          <Pencil size={12} /> Edit
        </button>
      )}
    </div>
  );
}
