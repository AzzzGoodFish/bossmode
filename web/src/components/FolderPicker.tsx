import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, Home } from "lucide-react";
import type { FsDirEntry, FsListDirsResult } from "../api/client";
import { listDirs } from "../api/client";
import { Sheet } from "./Sheet";

interface FolderPickerProps {
  open: boolean;
  initialPath?: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

export function FolderPicker({ open, initialPath, onConfirm, onCancel }: FolderPickerProps) {
  const [current, setCurrent] = useState<FsListDirsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number>(-1);
  const [pathInput, setPathInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  const navigate = useCallback((path: string) => {
    setLoading(true);
    setError(null);
    setSelectedIdx(-1);
    listDirs(path)
      .then((result) => {
        setCurrent(result);
        setPathInput(result.path);
      })
      .catch((err: any) => { setError(String(err?.message || err)); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    navigate(initialPath || "");
  }, [open, initialPath, navigate]);

  const dirs = current?.dirs ?? [];
  const selectedDir = selectedIdx >= 0 && selectedIdx < dirs.length ? dirs[selectedIdx] : null;

  const confirmSelected = useCallback(() => {
    if (selectedDir) {
      onConfirm(selectedDir.path);
    } else if (current) {
      onConfirm(current.path);
    }
  }, [selectedDir, current, onConfirm]);

  const enterSelected = useCallback(() => {
    if (selectedDir) {
      navigate(selectedDir.path);
    }
  }, [selectedDir, navigate]);

  const handleListKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!current) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIdx((prev) => Math.min(prev + 1, dirs.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIdx((prev) => Math.max(prev - 1, current.parent ? -1 : 0));
        break;
      case "Enter":
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          confirmSelected();
        } else {
          enterSelected();
        }
        break;
      case "Backspace":
        e.preventDefault();
        if (current.parent) navigate(current.parent);
        break;
      case "Escape":
        e.preventDefault();
        onCancel();
        break;
    }
  }, [current, dirs, enterSelected, confirmSelected, onCancel, navigate]);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedIdx < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-folder-item]");
    const el = items[selectedIdx + (current?.parent ? 1 : 0)] as HTMLElement;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, current]);

  const handlePathSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pathInput.trim()) navigate(pathInput.trim());
  };

  if (!open) return null;

  return (
    <Sheet open onClose={onCancel} size="md" closeOnOverlayClick={false}>
      <div className="flex flex-col" style={{ minHeight: "60vh", maxHeight: "80vh" }}>
        {/* PathBar (VS Code style) */}
        <div className="px-3 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <form onSubmit={handlePathSubmit} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("")}
              title="Go to home"
              className="shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer p-1 rounded"
            >
              <Home size={15} />
            </button>
            <input
              ref={pathInputRef}
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.currentTarget.blur(); onCancel(); } }}
              className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-xs font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0"
              placeholder="Path..."
              spellCheck={false}
            />
            <button
              type="submit"
              className="shrink-0 px-2 py-1 text-xs bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-200 rounded cursor-pointer"
            >
              OK
            </button>
          </form>
        </div>

        {/* Directory list */}
        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={handleListKeyDown}
          className="flex-1 overflow-y-auto p-1 focus:outline-none"
        >
          {loading && (
            <div className="flex items-center justify-center py-8 text-zinc-400 text-sm">Loading…</div>
          )}
          {error && (
            <div className="text-red-500 text-xs px-3 py-4">{error}</div>
          )}
          {!loading && !error && current && (
            <>
              {current.parent && (
                <button
                  onClick={() => navigate(current.parent!)}
                  className="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <Folder size={13} className="text-zinc-400 shrink-0" />
                  <span className="font-mono">..</span>
                </button>
              )}
              {current.dirs.length === 0 && (
                <div className="text-center py-8 text-xs text-zinc-400">No subfolders</div>
              )}
              {current.dirs.map((dir, i) => (
                <FolderRow
                  key={dir.path}
                  dir={dir}
                  isSelected={i === selectedIdx}
                  onSingleClick={() => setSelectedIdx(i)}
                  onDoubleClick={() => navigate(dir.path)}
                />
              ))}
              {current.truncated && (
                <div className="text-center py-2 text-xs text-zinc-400">
                  Showing first 200 folders
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
          <span className="text-[10px] text-zinc-400 hidden sm:block">
            ↑↓ navigate · Enter open · Cmd+Enter select · Backspace up · Esc cancel
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              disabled={!current}
              onClick={confirmSelected}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white cursor-pointer"
            >
              Select folder
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function FolderRow({
  dir,
  isSelected,
  onSingleClick,
  onDoubleClick,
}: {
  dir: FsDirEntry;
  isSelected: boolean;
  onSingleClick: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <button
      data-folder-item
      onClick={onSingleClick}
      onDoubleClick={(e) => { e.preventDefault(); onDoubleClick(); }}
      className={`w-full text-left flex items-center gap-2 px-3 py-1.5 rounded text-xs cursor-pointer transition-colors ${
        isSelected
          ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
          : dir.name.startsWith(".")
            ? "text-zinc-400 dark:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      <FolderOpen size={13} className={`shrink-0 ${isSelected ? "text-blue-500" : "text-amber-500"}`} />
      <span className="truncate font-mono">{dir.name}</span>
    </button>
  );
}
