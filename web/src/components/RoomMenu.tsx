import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Pencil, Settings, Trash2 } from "lucide-react";

interface RoomMenuProps {
  onRename: () => void;
  onSettings: () => void;
  onDelete: () => void;
}

export function RoomMenu({ onRename, onSettings, onDelete }: RoomMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="p-0.5 rounded hover:bg-surface-3 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
      >
        <MoreHorizontal size={14} className="text-ink-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-36 bg-surface-3 border border-line-strong rounded-lg shadow-lg overflow-hidden z-50">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onRename();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ink-2 hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <Pencil size={14} />
            Rename
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onSettings();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-ink-2 hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <Settings size={14} />
            Settings
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blocked hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
