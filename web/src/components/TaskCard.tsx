import type { Task } from "../api/client";

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-500",
  P1: "bg-amber-500",
  P2: "bg-blue-400",
};

const STATUS_COLORS: Record<string, string> = {
  todo: "bg-zinc-400",
  "in-progress": "bg-amber-500",
  review: "bg-violet-500",
  done: "bg-emerald-500",
};

interface TaskCardProps {
  task: Task;
  variant?: "card" | "row";
  onClick?: () => void;
  onStatusCycle?: () => void;
  draggable?: boolean;
}

export function TaskCard({ task, variant = "card", onClick, onStatusCycle }: TaskCardProps) {
  if (variant === "row") {
    return (
      <div
        onClick={onClick}
        className="flex items-center gap-3 px-3 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 border-b border-zinc-100 dark:border-zinc-900 cursor-pointer group"
      >
        <button
          onClick={(e) => { e.stopPropagation(); onStatusCycle?.(); }}
          className={`w-3 h-3 rounded-full shrink-0 ${STATUS_COLORS[task.status]} hover:ring-2 hover:ring-offset-1 hover:ring-zinc-400 cursor-pointer`}
          title={`Status: ${task.status} (click to cycle)`}
        />
        <span className="text-sm text-zinc-800 dark:text-zinc-200 truncate flex-1">{task.title}</span>
        <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_COLORS[task.priority]}`} title={task.priority} />
        {task.references && task.references.length > 0 && (
          <span className="text-[10px] text-zinc-400 shrink-0" title={task.references.join(', ')}>📎{task.references.length}</span>
        )}
        {task.assignee && (
          <span className="text-[10px] text-zinc-400 shrink-0">@{task.assignee}</span>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors group"
    >
      <div className="flex items-start gap-2 mb-1.5">
        <span className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${PRIORITY_COLORS[task.priority]}`} title={task.priority} />
        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 leading-snug line-clamp-2">{task.title}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-zinc-400 pl-4">
        {task.assignee && <span>@{task.assignee}</span>}
        {task.references && task.references.length > 0 && (
          <span title={task.references.join(', ')}>📎{task.references.length}</span>
        )}
        {task.createdBy && <span className="ml-auto">by {task.createdBy}</span>}
      </div>
    </div>
  );
}
