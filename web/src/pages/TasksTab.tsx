import { useState, useEffect, useCallback } from "react";
import { LayoutGrid, List, Plus } from "lucide-react";
import type { Task, TaskStatus, TaskPriority } from "../api/client";
import { listRoomTasks, createTask, updateTask } from "../api/client";
import { useDialog } from "../components/dialogs";
import { TaskBoard } from "../components/TaskBoard";
import { TaskList } from "../components/TaskList";
import { userActionError } from "../utils/user-error";

const VIEW_KEY = "bossmode_task_view";

interface TasksTabProps {
  roomId: string;
  members: string[];
  onOpenTaskDetail: (taskId: string) => void;
}

export function TasksTab({ roomId, members, onOpenTaskDetail }: TasksTabProps) {
  const { toast } = useDialog();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"board" | "list">(() =>
    (localStorage.getItem(VIEW_KEY) as "board" | "list") || "board",
  );

  const refresh = useCallback(() => {
    listRoomTasks(roomId).then(setTasks).catch(console.error).finally(() => setLoading(false));
  }, [roomId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => { localStorage.setItem(VIEW_KEY, view); }, [view]);

  const handleCreate = async (input: { title: string; status: TaskStatus }) => {
    try {
      const task = await createTask(roomId, { title: input.title, createdBy: "user", status: input.status });
      setTasks((prev) => [...prev, task]);
    } catch (err) {
      console.error("Failed to create task", err);
      toast(userActionError("create this task"), "error");
    }
  };

  const handleUpdateStatus = async (taskId: string, newStatus: TaskStatus) => {
    // Optimistic update
    setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, status: newStatus, updatedAt: Date.now() } : t));
    try {
      await updateTask(roomId, taskId, { status: newStatus, updatedBy: "user" });
    } catch (err) {
      console.error("Failed to update task", err);
      toast(userActionError("update this task"), "error");
      refresh(); // rollback
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="h-10 border-b border-line-soft flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView("board")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer ${view === "board" ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}
          >
            <LayoutGrid size={12} /> Board
          </button>
          <button
            onClick={() => setView("list")}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs cursor-pointer ${view === "list" ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}
          >
            <List size={12} /> List
          </button>
        </div>
        <button
          onClick={() => onOpenTaskDetail("")}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-accent text-accent-contrast hover:opacity-90 rounded cursor-pointer"
        >
          <Plus size={12} /> New task
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-ink-4">Loading tasks...</div>
        ) : view === "board" ? (
          <TaskBoard
            tasks={tasks}
            members={members}
            onCreateTask={handleCreate}
            onUpdateTaskStatus={handleUpdateStatus}
            onOpenTaskDetail={onOpenTaskDetail}
          />
        ) : (
          <TaskList
            tasks={tasks}
            onUpdateTaskStatus={handleUpdateStatus}
            onOpenTaskDetail={onOpenTaskDetail}
          />
        )}
      </div>
    </div>
  );
}
