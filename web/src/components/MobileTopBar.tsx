import { Menu, Users } from "lucide-react";

interface MobileTopBarProps {
  title: string;
  onOpenSidebar: () => void;
  showMembers?: boolean;
  onOpenMembers?: () => void;
}

export function MobileTopBar({ title, onOpenSidebar, showMembers = false, onOpenMembers }: MobileTopBarProps) {
  return (
    <div className="md:hidden h-12 flex items-center justify-between px-2 shrink-0
                    bg-surface-0 border-b border-line-soft
                    pt-[env(safe-area-inset-top)]">
      {/* Hamburger */}
      <button
        onClick={onOpenSidebar}
        aria-label="Open sidebar"
        className="w-11 h-11 flex items-center justify-center text-ink-2 hover:text-ink-1 cursor-pointer"
      >
        <Menu size={20} />
      </button>

      {/* Title */}
      <span className="flex-1 text-sm font-semibold text-ink-1 truncate text-center px-2">
        {title}
      </span>

      {/* Members or spacer */}
      {showMembers ? (
        <button
          onClick={onOpenMembers}
          aria-label="Open members"
          className="w-11 h-11 flex items-center justify-center text-ink-2 hover:text-ink-1 cursor-pointer"
        >
          <Users size={20} />
        </button>
      ) : (
        <div className="w-11 h-11" />
      )}
    </div>
  );
}
