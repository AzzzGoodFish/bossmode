import type { Task, TaskStatus } from "../api/client";
import { TaskCard } from "./TaskCard";

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in-progress",
  "in-progress": "done",
  done: "todo",
};

const STATUS_ORDER: TaskStatus[] = ["todo", "in-progress", "done"];
const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  "in-progress": "In Progress",
  done: "Done",
};

interface TaskListProps {
  tasks: Task[];
  onUpdateTaskStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onOpenTaskDetail: (taskId: string) => void;
}

export function TaskList({ tasks, onUpdateTaskStatus, onOpenTaskDetail }: TaskListProps) {
  return (
    <div className="p-4">
      {STATUS_ORDER.map((status) => {
        const group = tasks
          .filter((t) => t.status === status)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        if (group.length === 0) return null;
        return (
          <div key={status} className="mb-4">
            <div className="sticky top-0 bg-zinc-50/95 dark:bg-zinc-950/95 backdrop-blur-sm z-10 flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800">
              <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">{STATUS_LABELS[status]}</span>
              <span className="text-[10px] text-zinc-400 tabular-nums">{group.length}</span>
            </div>
            {group.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                variant="row"
                onClick={() => onOpenTaskDetail(task.id)}
                onStatusCycle={() => onUpdateTaskStatus(task.id, NEXT_STATUS[task.status])}
              />
            ))}
          </div>
        );
      })}
      {tasks.length === 0 && (
        <div className="text-center py-12 text-sm text-zinc-400">No tasks yet</div>
      )}
    </div>
  );
}
