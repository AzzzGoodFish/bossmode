import { useState } from "react";
import { Plus } from "lucide-react";
import type { Task, TaskStatus } from "../api/client";
import { TaskCard } from "./TaskCard";

const COLUMNS: Array<{ status: TaskStatus; label: string; color: string }> = [
  { status: "todo", label: "Todo", color: "text-ink-3" },
  { status: "in-progress", label: "In Progress", color: "text-think" },
  { status: "review", label: "Review", color: "text-accent-ink" },
  { status: "done", label: "Done", color: "text-onair" },
];

interface TaskBoardProps {
  tasks: Task[];
  members: string[];
  onCreateTask: (input: { title: string; status: TaskStatus }) => Promise<void>;
  onUpdateTaskStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onOpenTaskDetail: (taskId: string) => void;
}

export function TaskBoard({ tasks, members, onCreateTask, onUpdateTaskStatus, onOpenTaskDetail }: TaskBoardProps) {
  return (
    <div className="flex gap-4 p-4 h-full min-w-0">
      {COLUMNS.map((col) => {
        const colTasks = tasks
          .filter((t) => t.status === col.status)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return (
          <BoardColumn
            key={col.status}
            status={col.status}
            label={col.label}
            color={col.color}
            tasks={colTasks}
            onCreateTask={onCreateTask}
            onUpdateTaskStatus={onUpdateTaskStatus}
            onOpenTaskDetail={onOpenTaskDetail}
          />
        );
      })}
    </div>
  );
}

function BoardColumn({
  status,
  label,
  color,
  tasks,
  onCreateTask,
  onUpdateTaskStatus,
  onOpenTaskDetail,
}: {
  status: TaskStatus;
  label: string;
  color: string;
  tasks: Task[];
  onCreateTask: (input: { title: string; status: TaskStatus }) => Promise<void>;
  onUpdateTaskStatus: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onOpenTaskDetail: (taskId: string) => void;
}) {
  const [quickAdd, setQuickAdd] = useState(false);
  const [quickTitle, setQuickTitle] = useState("");
  const [dragOverThis, setDragOverThis] = useState(false);

  const handleQuickCreate = async () => {
    const title = quickTitle.trim();
    if (!title) { setQuickAdd(false); return; }
    setQuickTitle("");
    await onCreateTask({ title, status });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOverThis(false);
    const taskId = e.dataTransfer.getData("text/plain");
    if (taskId) onUpdateTaskStatus(taskId, status);
  };

  return (
    <div
      className={`flex-1 min-w-[220px] max-w-[360px] flex flex-col rounded-lg bg-surface-1/30 ${dragOverThis ? "ring-2 ring-accent/50" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOverThis(true); }}
      onDragLeave={() => setDragOverThis(false)}
      onDrop={handleDrop}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-line-soft/50">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold uppercase tracking-wider ${color}`}>{label}</span>
          <span className="text-[10px] text-ink-4 tabular-nums">{tasks.length}</span>
        </div>
        <button onClick={() => setQuickAdd(true)} className="text-ink-4 hover:text-ink-2 cursor-pointer">
          <Plus size={14} />
        </button>
      </div>

      {/* Quick add */}
      {quickAdd && (
        <div className="px-2 pt-2">
          <input
            autoFocus
            value={quickTitle}
            onChange={(e) => setQuickTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleQuickCreate();
              if (e.key === "Escape") { setQuickAdd(false); setQuickTitle(""); }
            }}
            onBlur={handleQuickCreate}
            placeholder="Task title..."
            className="w-full bg-surface-3 border border-line rounded px-2 py-1.5 text-xs text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
          />
        </div>
      )}

      {/* Cards */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {tasks.map((task) => (
          <div
            key={task.id}
            draggable
            onDragStart={(e) => { e.dataTransfer.setData("text/plain", task.id); e.dataTransfer.effectAllowed = "move"; }}
          >
            <TaskCard task={task} onClick={() => onOpenTaskDetail(task.id)} />
          </div>
        ))}
        {tasks.length === 0 && !quickAdd && (
          <div className="text-center py-6 text-xs text-ink-4">No tasks</div>
        )}
      </div>
    </div>
  );
}
