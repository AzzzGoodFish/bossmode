import { useState, useEffect, useCallback } from "react";
import { Search } from "lucide-react";
import type { Task, TaskStatus } from "../api/client";
import { listAllTasks } from "../api/client";
import { TaskCard } from "../components/TaskCard";
import { MobileTopBar } from "../components/MobileTopBar";

const STATUS_CHIPS: Array<{ value: TaskStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "in-progress", label: "In Progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

interface AllTasksPageProps {
  onSelectTask: (roomId: string, taskId: string) => void;
  onOpenMobileSidebar?: () => void;
}

export function AllTasksPage({ onSelectTask, onOpenMobileSidebar }: AllTasksPageProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "">("");
  const [query, setQuery] = useState("");

  const refresh = useCallback(() => {
    setLoading(true);
    listAllTasks({
      status: statusFilter || undefined,
      query: query.trim() || undefined,
    })
      .then(setTasks)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [statusFilter, query]);

  useEffect(() => { refresh(); }, [refresh]);

  // Group by room
  const grouped = new Map<string, { roomName: string; tasks: Task[] }>();
  for (const t of tasks) {
    const key = t.roomId;
    if (!grouped.has(key)) grouped.set(key, { roomName: (t as any).roomName || t.roomId, tasks: [] });
    grouped.get(key)!.tasks.push(t);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title="All Tasks" onOpenSidebar={onOpenMobileSidebar || (() => {})} />

      {/* Header */}
      <div className="px-6 pt-5 pb-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="mx-auto w-full max-w-6xl">
        <h1 className="text-lg font-bold text-zinc-900 dark:text-white mb-3">All Tasks</h1>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Status chips */}
          <div className="flex items-center gap-1">
            {STATUS_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => setStatusFilter(chip.value as TaskStatus | "")}
                className={`px-2.5 py-1 rounded-full text-xs cursor-pointer ${statusFilter === chip.value
                  ? "bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"}`}
              >
                {chip.label}
              </button>
            ))}
          </div>
          {/* Search */}
          <div className="flex items-center gap-1 bg-zinc-100 dark:bg-zinc-800 rounded px-2 py-1">
            <Search size={12} className="text-zinc-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks..."
              className="bg-transparent text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none w-40"
            />
          </div>
        </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-6xl">
        {loading ? (
          <div className="text-center py-12 text-sm text-zinc-400">Loading...</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-12 text-sm text-zinc-400">No tasks found</div>
        ) : (
          Array.from(grouped.entries()).map(([roomId, group]) => (
            <div key={roomId} className="mb-6">
              <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
                # {group.roomName}
              </div>
              <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
                {group.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    variant="row"
                    onClick={() => onSelectTask(roomId, task.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
        </div>
      </div>
    </div>
  );
}
