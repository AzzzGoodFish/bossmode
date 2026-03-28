import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

interface RoomMenuProps {
  onRename: () => void;
  onDelete: () => void;
}

export function RoomMenu({ onRename, onDelete }: RoomMenuProps) {
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
        className="p-0.5 rounded hover:bg-zinc-700 transition-colors cursor-pointer opacity-0 group-hover:opacity-100"
      >
        <MoreHorizontal size={14} className="text-zinc-500" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-36 bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg overflow-hidden z-50">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onRename();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700 transition-colors cursor-pointer"
          >
            <Pencil size={14} />
            Rename
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-zinc-700 transition-colors cursor-pointer"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
