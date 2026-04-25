import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Home } from "lucide-react";
import type { FsDirEntry, FsListDirsResult } from "../api/client";
import { listDirs } from "../api/client";
import { Sheet } from "./Sheet";

interface FolderPickerProps {
  open: boolean;
  initialPath?: string;   // default: user home
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

export function FolderPicker({ open, initialPath, onConfirm, onCancel }: FolderPickerProps) {
  const [current, setCurrent] = useState<FsListDirsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback((path: string) => {
    setLoading(true);
    setError(null);
    listDirs(path)
      .then((result) => { setCurrent(result); })
      .catch((err: any) => { setError(String(err?.message || err)); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    navigate(initialPath || "~");
  }, [open, initialPath, navigate]);

  if (!open) return null;

  return (
    <Sheet open onClose={onCancel} size="md" closeOnOverlayClick={false}>
      <div className="flex flex-col" style={{ minHeight: "60vh", maxHeight: "80vh" }}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Select folder</h3>
        </div>

        {/* Breadcrumb */}
        {current && (
          <div className="px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-1 flex-wrap text-xs text-zinc-500 shrink-0">
            <button
              onClick={() => navigate("~")}
              className="flex items-center gap-0.5 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
            >
              <Home size={12} />
            </button>
            {current.segments.slice(1).map((seg, i) => (
              <span key={seg.path} className="flex items-center gap-1">
                <ChevronRight size={12} className="text-zinc-400 shrink-0" />
                <button
                  onClick={() => navigate(seg.path)}
                  className={`hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer truncate max-w-[120px] ${
                    i === current.segments.length - 2 ? "text-zinc-900 dark:text-zinc-100 font-medium" : ""
                  }`}
                  title={seg.path}
                >
                  {seg.name}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto p-2">
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
                  className="w-full text-left flex items-center gap-2 px-3 py-2 rounded text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <Folder size={14} className="text-zinc-400 shrink-0" />
                  ..
                </button>
              )}
              {current.dirs.length === 0 && (
                <div className="text-center py-8 text-xs text-zinc-400">No subfolders</div>
              )}
              {current.dirs.map((dir) => (
                <FolderRow
                  key={dir.path}
                  dir={dir}
                  onSingleClick={() => navigate(dir.path)}
                  onDoubleClick={() => onConfirm(dir.path)}
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
        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between shrink-0">
          <span className="text-xs text-zinc-500 truncate max-w-[60%]" title={current?.path}>
            {current?.path ?? ""}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-sm text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              disabled={!current}
              onClick={() => current && onConfirm(current.path)}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white cursor-pointer"
            >
              Select this folder
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

function FolderRow({
  dir,
  onSingleClick,
  onDoubleClick,
}: {
  dir: FsDirEntry;
  onSingleClick: () => void;
  onDoubleClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSingleClick}
      onDoubleClick={(e) => { e.preventDefault(); onDoubleClick(); }}
      className="w-full text-left flex items-center gap-2 px-3 py-2 rounded text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer group"
    >
      {hovered
        ? <FolderOpen size={14} className="text-amber-500 shrink-0" />
        : <Folder size={14} className="text-amber-500 shrink-0" />}
      <span className="truncate">{dir.name}</span>
      <ChevronRight size={12} className="text-zinc-400 ml-auto opacity-0 group-hover:opacity-100 shrink-0" />
    </button>
  );
}
