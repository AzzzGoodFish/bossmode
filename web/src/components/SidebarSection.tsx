import { useState, type ReactNode } from "react";
import { Plus, ChevronDown, ChevronRight } from "lucide-react";

export interface SidebarItem {
  id: string;
  icon?: ReactNode;
  label: string;
  sublabel?: string;
  badge?: { text: string; variant: "amber" | "blue" | "purple" | "zinc" };
  hasUnread?: boolean;
}

interface SidebarSectionProps {
  icon: ReactNode;
  label: string;
  count?: number;
  items: SidebarItem[];
  selectedId: string | null;
  defaultOpen?: boolean;
  storageKey?: string;
  onSelect: (id: string) => void;
  onCreate?: () => void;
  renderMenu?: (id: string) => ReactNode;
}

const badgeColors = {
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400",
  purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-400",
  zinc: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-500",
};

export function SidebarSection({
  icon, label, count, items, selectedId, defaultOpen = true,
  storageKey, onSelect, onCreate, renderMenu,
}: SidebarSectionProps) {
  const [open, setOpen] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(`sidebar_${storageKey}`);
      if (saved !== null) return saved === "true";
    }
    return defaultOpen;
  });

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (storageKey) localStorage.setItem(`sidebar_${storageKey}`, String(next));
  };

  return (
    <div>
      <button
        onClick={toggle}
        className="w-full flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-900/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={12} className="text-zinc-400 dark:text-zinc-600" /> : <ChevronRight size={12} className="text-zinc-400 dark:text-zinc-600" />}
          <span className="text-zinc-500">{icon}</span>
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{label}</span>
          {!open && count !== undefined && count > 0 && (
            <span className="text-[10px] text-zinc-500 dark:text-zinc-600 bg-zinc-200 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{count}</span>
          )}
        </div>
        {onCreate && (
          <button
            onClick={(e) => { e.stopPropagation(); onCreate(); }}
            className="text-zinc-400 dark:text-zinc-600 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer"
            title={`New ${label.toLowerCase().replace(/s$/, "")}`}
          >
            <Plus size={14} />
          </button>
        )}
      </button>

      {open && (
        <div className="pb-1">
          {items.length === 0 ? (
            <div className="px-3 py-2 text-center text-zinc-400 dark:text-zinc-700 text-xs">No {label.toLowerCase()} yet</div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                onClick={() => onSelect(item.id)}
                className={`group w-full flex items-center gap-2 px-3 py-1.5 transition-colors cursor-pointer ${
                  selectedId === item.id
                    ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300"
                }`}
              >
                {item.icon && <span className="shrink-0 text-zinc-400 dark:text-zinc-600">{item.icon}</span>}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{item.label}</div>
                  {item.sublabel && <div className="text-xs text-zinc-400 dark:text-zinc-600 truncate">{item.sublabel}</div>}
                </div>
                {item.badge && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${badgeColors[item.badge.variant]}`}>
                    {item.badge.text}
                  </span>
                )}
                {item.hasUnread && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />}
                {renderMenu && <span className="opacity-0 group-hover:opacity-100">{renderMenu(item.id)}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
