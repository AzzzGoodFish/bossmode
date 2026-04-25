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
                    bg-white dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800
                    pt-[env(safe-area-inset-top)]">
      {/* Hamburger */}
      <button
        onClick={onOpenSidebar}
        aria-label="Open sidebar"
        className="w-11 h-11 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
      >
        <Menu size={20} />
      </button>

      {/* Title */}
      <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate text-center px-2">
        {title}
      </span>

      {/* Members or spacer */}
      {showMembers ? (
        <button
          onClick={onOpenMembers}
          aria-label="Open members"
          className="w-11 h-11 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
        >
          <Users size={20} />
        </button>
      ) : (
        <div className="w-11 h-11" />
      )}
    </div>
  );
}
