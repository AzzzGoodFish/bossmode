import type { Task } from "../api/client";

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-blocked",
  P1: "bg-think",
  P2: "bg-accent",
};

const STATUS_COLORS: Record<string, string> = {
  todo: "bg-idleg",
  "in-progress": "bg-think",
  review: "bg-accent",
  done: "bg-onair",
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
        className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2/50 border-b border-line-soft cursor-pointer group"
      >
        <button
          onClick={(e) => { e.stopPropagation(); onStatusCycle?.(); }}
          className={`w-3 h-3 rounded-full shrink-0 ${STATUS_COLORS[task.status]} hover:ring-2 hover:ring-offset-1 hover:ring-line-strong cursor-pointer`}
          title={`Status: ${task.status} (click to cycle)`}
        />
        <span className="text-sm text-ink-1 truncate flex-1">{task.title}</span>
        <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_COLORS[task.priority]}`} title={task.priority} />
        {task.references && task.references.length > 0 && (
          <span className="text-[10px] text-ink-4 shrink-0" title={task.references.join(', ')}>📎{task.references.length}</span>
        )}
        {((task.commentCount ?? task.comments?.length ?? 0) > 0) && (
          <span className="text-[10px] text-ink-4 shrink-0">💬{task.commentCount ?? task.comments?.length}</span>
        )}
        {task.linearIssueIdentifier && <span className="text-[10px] text-accent-ink shrink-0">Linear {task.linearIssueIdentifier}</span>}
        {task.assignee && (
          <span className="text-[10px] text-ink-4 shrink-0">@{task.assignee}</span>
        )}
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      className="bg-surface-1 border border-line rounded-lg p-3 cursor-pointer hover:border-line-strong transition-colors group"
    >
      <div className="flex items-start gap-2 mb-1.5">
        <span className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${PRIORITY_COLORS[task.priority]}`} title={task.priority} />
        <span className="text-sm font-medium text-ink-1 leading-snug line-clamp-2">{task.title}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-ink-4 pl-4">
        {task.assignee && <span>@{task.assignee}</span>}
        {task.references && task.references.length > 0 && (
          <span title={task.references.join(', ')}>📎{task.references.length}</span>
        )}
        {((task.commentCount ?? task.comments?.length ?? 0) > 0) && (
          <span>💬{task.commentCount ?? task.comments?.length}</span>
        )}
        {task.linearIssueIdentifier && <span className="text-accent-ink">Linear {task.linearIssueIdentifier}</span>}
        {task.createdBy && <span className="ml-auto">by {task.createdBy}</span>}
      </div>
    </div>
  );
}
