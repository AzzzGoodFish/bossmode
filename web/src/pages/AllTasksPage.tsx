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
      <div className="px-6 pt-5 pb-3 border-b border-line-soft shrink-0">
        <div className="mx-auto w-full max-w-6xl">
        <h1 className="text-lg font-bold text-ink-1 mb-3">All Tasks</h1>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Status chips */}
          <div className="flex items-center gap-1">
            {STATUS_CHIPS.map((chip) => (
              <button
                key={chip.value}
                onClick={() => setStatusFilter(chip.value as TaskStatus | "")}
                className={`px-2.5 py-1 rounded-full text-xs cursor-pointer ${statusFilter === chip.value
                  ? "bg-accent text-accent-contrast"
                  : "bg-surface-2 text-ink-2 hover:bg-surface-2"}`}
              >
                {chip.label}
              </button>
            ))}
          </div>
          {/* Search */}
          <div className="flex items-center gap-1 bg-surface-2 rounded px-2 py-1">
            <Search size={12} className="text-ink-4" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks..."
              className="bg-transparent text-xs text-ink-1 placeholder:text-ink-4 focus:outline-none w-40"
            />
          </div>
        </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-6xl">
        {loading ? (
          <div className="text-center py-12 text-sm text-ink-4">Loading...</div>
        ) : tasks.length === 0 ? (
          <div className="text-center py-12 text-sm text-ink-4">No tasks found</div>
        ) : (
          Array.from(grouped.entries()).map(([roomId, group]) => (
            <div key={roomId} className="mb-6">
              <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-2">
                # {group.roomName}
              </div>
              <div className="border border-line-soft rounded-lg overflow-hidden">
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
