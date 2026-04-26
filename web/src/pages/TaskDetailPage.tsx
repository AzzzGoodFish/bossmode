import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Save, Trash2 } from "lucide-react";
import type { Task, TaskStatus, TaskPriority } from "../api/client";
import { listRoomTasks, updateTask, deleteTaskApi, createTask, getRoom } from "../api/client";
import { Markdown } from "../components/Markdown";
import { useDialog } from "../components/dialogs";
import { MobileTopBar } from "../components/MobileTopBar";

const STATUS_OPTIONS: TaskStatus[] = ["todo", "in-progress", "done"];
const PRIORITY_OPTIONS: TaskPriority[] = ["P0", "P1", "P2"];

interface TaskDetailPageProps {
  roomId: string;
  taskId: string;  // empty string = create new
  onBack: () => void;
  onOpenMobileSidebar?: () => void;
}

export function TaskDetailPage({ roomId, taskId, onBack, onOpenMobileSidebar }: TaskDetailPageProps) {
  const { toast, confirm } = useDialog();
  const isCreate = !taskId;
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(!isCreate);
  const [roomName, setRoomName] = useState("");
  const [editing, setEditing] = useState(isCreate);

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [priority, setPriority] = useState<TaskPriority>("P1");
  const [assignee, setAssignee] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getRoom(roomId).then((r) => setRoomName(r.name)).catch(() => {});
  }, [roomId]);

  useEffect(() => {
    if (isCreate) return;
    setLoading(true);
    listRoomTasks(roomId)
      .then((tasks) => {
        const found = tasks.find((t) => t.id === taskId);
        if (found) {
          setTask(found);
          setTitle(found.title);
          setDescription(found.description || "");
          setStatus(found.status);
          setPriority(found.priority);
          setAssignee(found.assignee || "");
        }
      })
      .catch((err: any) => toast(err.message, "error"))
      .finally(() => setLoading(false));
  }, [roomId, taskId, isCreate, toast]);

  const handleFieldChange = useCallback(() => setDirty(true), []);

  const handleSave = async () => {
    if (!title.trim()) { toast("Title is required", "error"); return; }
    setSaving(true);
    try {
      if (isCreate) {
        await createTask(roomId, {
          title: title.trim(),
          createdBy: "user",
          status,
          priority,
          assignee: assignee || undefined,
          description: description || undefined,
        });
        toast("Task created", "success");
        onBack();
      } else {
        await updateTask(roomId, taskId, {
          title: title.trim(),
          status,
          priority,
          assignee: assignee || undefined,
          description: description || undefined,
          updatedBy: "user",
        });
        setDirty(false);
        setEditing(false);
        toast("Task saved", "success");
      }
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm(`Delete task "${title}"?`))) return;
    try {
      await deleteTaskApi(roomId, taskId, "user");
      onBack();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && editing) {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500">Loading...</div>;

  const selectCls = "bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title={isCreate ? "New Task" : "Task"} onOpenSidebar={onOpenMobileSidebar || (() => {})} />

      {/* Top bar */}
      <div className="h-10 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={onBack} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer">
            <ArrowLeft size={16} />
          </button>
          <span className="text-xs text-zinc-400 truncate">
            # {roomName} {!isCreate && task && `/ T-${task.id.slice(5, 13)}`}
          </span>
          {dirty && <span className="text-xs text-amber-500">● unsaved</span>}
        </div>
        <div className="flex items-center gap-2">
          {!isCreate && !editing && (
            <button onClick={() => setEditing(true)} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer">Edit</button>
          )}
          {!isCreate && (
            <button onClick={handleDelete} className="text-zinc-400 hover:text-red-500 cursor-pointer">
              <Trash2 size={14} />
            </button>
          )}
          {editing && (
            <button
              onClick={handleSave}
              disabled={saving || !title.trim()}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white rounded cursor-pointer"
            >
              <Save size={12} /> {saving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-6 flex flex-col md:flex-row gap-6">
          {/* Main */}
          <div className="flex-1 min-w-0">
            {editing ? (
              <>
                <input
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); handleFieldChange(); }}
                  placeholder="Task title"
                  className="w-full text-xl font-bold text-zinc-900 dark:text-white bg-transparent border-b border-zinc-300 dark:border-zinc-700 focus:border-blue-500 outline-none pb-2 mb-4"
                  autoFocus={isCreate}
                />
                <textarea
                  value={description}
                  onChange={(e) => { setDescription(e.target.value); handleFieldChange(); }}
                  placeholder="Description (markdown)..."
                  rows={12}
                  className="w-full bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 text-base md:text-sm text-zinc-800 dark:text-zinc-300 font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </>
            ) : (
              <>
                <h1 className="text-xl font-bold text-zinc-900 dark:text-white mb-4">{task?.title}</h1>
                {task?.description ? (
                  <div className="bg-white dark:bg-zinc-800/30 border border-zinc-200 dark:border-zinc-800 rounded-lg px-6 py-5 text-sm text-zinc-800 dark:text-zinc-300">
                    <Markdown content={task.description} />
                  </div>
                ) : (
                  <p className="text-sm text-zinc-400 italic">No description</p>
                )}
              </>
            )}
          </div>

          {/* Sidebar meta */}
          <div className="w-full md:w-56 shrink-0 space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Status</label>
              {editing ? (
                <select value={status} onChange={(e) => { setStatus(e.target.value as TaskStatus); handleFieldChange(); }} className={selectCls}>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ) : (
                <span className="text-sm text-zinc-700 dark:text-zinc-300">{task?.status}</span>
              )}
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Priority</label>
              {editing ? (
                <select value={priority} onChange={(e) => { setPriority(e.target.value as TaskPriority); handleFieldChange(); }} className={selectCls}>
                  {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              ) : (
                <span className="text-sm text-zinc-700 dark:text-zinc-300">{task?.priority}</span>
              )}
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Assignee</label>
              {editing ? (
                <input
                  value={assignee}
                  onChange={(e) => { setAssignee(e.target.value); handleFieldChange(); }}
                  placeholder="member name"
                  className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              ) : (
                <span className="text-sm text-zinc-700 dark:text-zinc-300">{task?.assignee || "—"}</span>
              )}
            </div>
            {task && (
              <>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Created by</label>
                  <span className="text-sm text-zinc-700 dark:text-zinc-300">{task.createdBy}</span>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Created</label>
                  <span className="text-xs text-zinc-400">{new Date(task.createdAt).toLocaleString()}</span>
                </div>
                <div>
                  <label className="block text-xs text-zinc-500 mb-1">Updated</label>
                  <span className="text-xs text-zinc-400">{new Date(task.updatedAt).toLocaleString()}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
