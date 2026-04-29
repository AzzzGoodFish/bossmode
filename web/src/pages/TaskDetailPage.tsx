import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ArrowLeft, Trash2, ChevronDown, User, Circle, CircleDot, CheckCircle2, AlertCircle, AlertOctagon, Minus } from "lucide-react";
import type { Task, TaskStatus, TaskPriority } from "../api/client";
import { listRoomTasks, updateTask, deleteTaskApi, createTask, getRoom } from "../api/client";
import { MarkdownField } from "../components/MarkdownField";
import { useDialog } from "../components/dialogs";
import { MobileTopBar } from "../components/MobileTopBar";

interface TaskDetailPageProps {
  roomId: string;
  taskId: string; // empty string = create new
  onBack: () => void;
  onOpenMobileSidebar?: () => void;
}

const STATUS_META: Record<TaskStatus, { label: string; icon: any; dot: string; chip: string }> = {
  todo:          { label: "Todo",        icon: Circle,        dot: "bg-zinc-400",     chip: "text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800" },
  "in-progress": { label: "In Progress", icon: CircleDot,     dot: "bg-blue-500",     chip: "text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/40" },
  review:        { label: "Review",      icon: CircleDot,     dot: "bg-violet-500",   chip: "text-violet-700 dark:text-violet-300 bg-violet-100 dark:bg-violet-900/40" },
  done:          { label: "Done",        icon: CheckCircle2,  dot: "bg-emerald-500",  chip: "text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900/40" },
};

const PRIORITY_META: Record<TaskPriority, { label: string; icon: any; dot: string; chip: string }> = {
  P0: { label: "P0", icon: AlertOctagon, dot: "bg-red-500",    chip: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20" },
  P1: { label: "P1", icon: AlertCircle,  dot: "bg-amber-500",  chip: "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20" },
  P2: { label: "P2", icon: Minus,        dot: "bg-zinc-400",   chip: "text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800" },
};

const AVATAR_COLORS: Record<string, string> = {
  pm: "bg-purple-700", developer: "bg-blue-700", qa: "bg-emerald-700",
  architect: "bg-amber-700", designer: "bg-pink-700", user: "bg-cyan-700", fish: "bg-cyan-700",
  summarizer: "bg-zinc-600",
};
function avatarColor(name: string) {
  return AVATAR_COLORS[name] || "bg-zinc-600";
}

function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <div className={`${avatarColor(name)} rounded-full flex items-center justify-center text-[10px] text-white font-medium shrink-0`}
         style={{ width: size, height: size }} title={name}>
      {name[0]?.toUpperCase()}
    </div>
  );
}

export function TaskDetailPage({ roomId, taskId, onBack, onOpenMobileSidebar }: TaskDetailPageProps) {
  const { toast, confirm } = useDialog();
  const isCreate = !taskId;
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(!isCreate);
  const [roomName, setRoomName] = useState("");
  const [roomMembers, setRoomMembers] = useState<string[]>([]);

  // Form state — single editable mode (Linear/Notion style)
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [newRef, setNewRef] = useState("");
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [priority, setPriority] = useState<TaskPriority>("P1");
  const [assignee, setAssignee] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Auto-grow textarea


  // Load room (for name + members) and task
  useEffect(() => {
    getRoom(roomId).then((r) => { setRoomName(r.name); setRoomMembers(r.members); }).catch(() => {});
  }, [roomId]);

  useEffect(() => {
    if (isCreate) { setLoading(false); return; }
    setLoading(true);
    listRoomTasks(roomId)
      .then((tasks) => {
        const found = tasks.find((t) => t.id === taskId);
        if (found) {
          setTask(found);
          setTitle(found.title);
          setDescription(found.description || "");
          setReferences(found.references || []);
          setStatus(found.status);
          setPriority(found.priority);
          setAssignee(found.assignee || "");
        }
      })
      .catch((err: any) => toast(err.message, "error"))
      .finally(() => setLoading(false));
  }, [roomId, taskId, isCreate, toast]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleSave = async () => {
    if (!title.trim()) { toast("Title is required", "error"); return; }
    setSaving(true);
    try {
      if (isCreate) {
        await createTask(roomId, {
          title: title.trim(), createdBy: "user", status, priority,
          assignee: assignee || undefined, description: description || undefined,
          references: references.length > 0 ? references : undefined,
        } as any);
        toast("Task created", "success");
        onBack();
      } else {
        await updateTask(roomId, taskId, {
          title: title.trim(), status, priority,
          assignee: assignee || undefined, description: description || undefined,
          references,
          updatedBy: "user",
        } as any);
        setDirty(false);
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
      if (e.key === "Escape" && !dirty) onBack();
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault(); handleSave();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  });

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">Loading…</div>;
  }

  const statusMeta = STATUS_META[status];
  const priorityMeta = PRIORITY_META[priority];


  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-zinc-950">
      <MobileTopBar title={isCreate ? "New task" : "Task"} onOpenSidebar={onOpenMobileSidebar || (() => {})} />

      {/* Top bar */}
      <div className="h-12 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between px-3 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={onBack} title="Back" aria-label="Back"
            className="w-8 h-8 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer shrink-0">
            <ArrowLeft size={16} />
          </button>
          <span className="text-xs text-zinc-500 truncate">
            <span className="text-zinc-400"># </span>{roomName}
            {!isCreate && task && (
              <>
                <span className="text-zinc-600 mx-1.5">/</span>
                <span className="text-zinc-700 dark:text-zinc-300 font-mono">T-{task.id.slice(5, 13)}</span>
              </>
            )}
          </span>
          {/* Inline chips in header — Linear style */}
          {!isCreate && (
            <div className="hidden md:flex items-center gap-1.5 ml-2">
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${statusMeta.chip}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dot}`} />
                {statusMeta.label}
              </span>
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${priorityMeta.chip}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${priorityMeta.dot}`} />
                {priorityMeta.label}
              </span>
              {assignee && (
                <span className="inline-flex items-center gap-1 px-1 py-0.5 rounded text-[10px] text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800">
                  <Avatar name={assignee} size={14} />
                  {assignee}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dirty && <span className="text-[11px] text-amber-500 hidden md:inline">● unsaved</span>}
          {!isCreate && (
            <button onClick={handleDelete} title="Delete" aria-label="Delete"
              className="w-8 h-8 flex items-center justify-center rounded text-zinc-400 hover:text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer">
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !title.trim() || (!isCreate && !dirty)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-800 disabled:text-zinc-400 dark:disabled:text-zinc-600 text-white cursor-pointer disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Saving…" : isCreate ? "Create task" : "Save"}
          </button>
        </div>
      </div>

      {/* Content — full-bleed two columns: main grows, sidebar fixed narrow */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col md:flex-row min-h-full">
          {/* Main column */}
          <div className="flex-1 min-w-0 px-6 md:px-12 py-6 md:py-8">
            <div className="max-w-3xl">
              {/* Title */}
              <input
                value={title}
                onChange={(e) => { setTitle(e.target.value); markDirty(); }}
                placeholder={isCreate ? "Task title…" : "Untitled"}
                autoFocus={isCreate}
                className="w-full text-2xl md:text-3xl font-bold text-zinc-900 dark:text-white bg-transparent focus:outline-none placeholder-zinc-300 dark:placeholder-zinc-700 mb-2 leading-tight"
              />

              {/* Description */}
              <div className="mt-6">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-2">Description</div>
                <MarkdownField
                  value={description}
                  onChange={(v) => { setDescription(v); markDirty(); }}
                  placeholder="Add a description… (markdown supported)"
                  autoEdit={isCreate}
                />
              </div>

              {/* References */}
              <div className="mt-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">References</h3>
                </div>
                {references.length > 0 && (
                  <ul className="space-y-1 mb-2">
                    {references.map((ref, i) => {
                      const isUrl = /^https?:\/\//.test(ref);
                      const label = ref.split("/").pop() || ref;
                      return (
                        <li key={i} className="group flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors">
                          <span className="text-zinc-400 text-xs">{isUrl ? "🔗" : "📄"}</span>
                          {isUrl ? (
                            <a href={ref} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-400 truncate flex-1" title={ref}>{label}</a>
                          ) : (
                            <span className="text-zinc-700 dark:text-zinc-300 truncate flex-1" title={ref}>{label}</span>
                          )}
                          <button
                            onClick={() => { setReferences(references.filter((_, j) => j !== i)); markDirty(); }}
                            className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-500 transition-opacity text-xs"
                            title="Remove reference"
                          >✕</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = newRef.trim();
                    if (v && !references.includes(v)) {
                      setReferences([...references, v]);
                      setNewRef("");
                      markDirty();
                    }
                  }}
                  className="flex items-center gap-1"
                >
                  <input
                    type="text"
                    value={newRef}
                    onChange={(e) => setNewRef(e.target.value)}
                    placeholder="Add reference path or URL…"
                    className="flex-1 text-sm px-2 py-1.5 bg-transparent border border-zinc-200 dark:border-zinc-800 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-zinc-400 dark:placeholder-zinc-600"
                  />
                  <button type="submit" disabled={!newRef.trim()} className="text-xs px-2 py-1.5 text-blue-500 hover:text-blue-400 disabled:opacity-30">
                    + Add
                  </button>
                </form>
              </div>

              {/* Footer hint */}
              <div className="mt-8 text-[11px] text-zinc-400">
                Esc to go back · ⌘/Ctrl + Enter to save
              </div>
            </div>
          </div>

          {/* Right meta sidebar */}
          <aside className="w-full md:w-72 shrink-0 border-t md:border-t-0 md:border-l border-zinc-200 dark:border-zinc-800 px-5 md:px-6 py-6 md:py-8 bg-zinc-50/50 dark:bg-zinc-900/30">
            <div className="space-y-5 max-w-md md:max-w-none">

              <MetaRow label="Status">
                <ChipPicker
                  current={status}
                  options={STATUS_META}
                  onChange={(v) => { setStatus(v); markDirty(); }}
                />
              </MetaRow>

              <MetaRow label="Priority">
                <ChipPicker
                  current={priority}
                  options={PRIORITY_META}
                  onChange={(v) => { setPriority(v); markDirty(); }}
                />
              </MetaRow>

              <MetaRow label="Assignee">
                <AssigneePicker
                  value={assignee}
                  members={roomMembers}
                  onChange={(v) => { setAssignee(v); markDirty(); }}
                />
              </MetaRow>

              {!isCreate && task && (
                <>
                  <MetaRow label="Created by">
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <Avatar name={task.createdBy} size={20} />
                      <span className="text-sm text-zinc-700 dark:text-zinc-300">{task.createdBy}</span>
                    </div>
                  </MetaRow>
                  <MetaRow label="Created">
                    <div className="text-xs text-zinc-500 px-2">{formatDate(task.createdAt)}</div>
                  </MetaRow>
                  <MetaRow label="Updated">
                    <div className="text-xs text-zinc-500 px-2">{formatDate(task.updatedAt)}</div>
                  </MetaRow>
                </>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-1.5 px-1">{label}</div>
      {children}
    </div>
  );
}

function ChipPicker<T extends string>({
  current, options, onChange,
}: {
  current: T;
  options: Record<T, { label: string; dot: string; chip: string; icon: any }>;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const meta = options[current];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer text-zinc-700 dark:text-zinc-200 ${open ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
      >
        <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
        <span className="flex-1 text-left">{meta.label}</span>
        <ChevronDown size={12} className="text-zinc-400" />
      </button>
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg p-1">
          {(Object.keys(options) as T[]).map((k) => {
            const o = options[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => { onChange(k); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer ${current === k ? "bg-zinc-50 dark:bg-zinc-800/60" : ""}`}
              >
                <span className={`w-2 h-2 rounded-full ${o.dot}`} />
                <span className="flex-1 text-left">{o.label}</span>
                {current === k && <span className="text-[10px] text-zinc-400">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssigneePicker({
  value, members, onChange,
}: { value: string; members: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer text-zinc-700 dark:text-zinc-200 ${open ? "bg-zinc-100 dark:bg-zinc-800" : ""}`}
      >
        {value ? (
          <>
            <Avatar name={value} size={18} />
            <span className="flex-1 text-left">{value}</span>
          </>
        ) : (
          <>
            <div className="w-[18px] h-[18px] rounded-full border border-dashed border-zinc-400 dark:border-zinc-600 flex items-center justify-center">
              <User size={10} className="text-zinc-400" />
            </div>
            <span className="flex-1 text-left text-zinc-400">Unassigned</span>
          </>
        )}
        <ChevronDown size={12} className="text-zinc-400" />
      </button>
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg p-1 max-h-64 overflow-y-auto">
          <button
            type="button"
            onClick={() => { onChange(""); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer ${!value ? "bg-zinc-50 dark:bg-zinc-800/60" : ""}`}
          >
            <div className="w-[18px] h-[18px] rounded-full border border-dashed border-zinc-400 dark:border-zinc-600" />
            <span className="flex-1 text-left">Unassigned</span>
          </button>
          {members.length === 0 && (
            <div className="px-2 py-2 text-xs text-zinc-400 italic">No members in this room</div>
          )}
          {members.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { onChange(m); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer ${value === m ? "bg-zinc-50 dark:bg-zinc-800/60" : ""}`}
            >
              <Avatar name={m} size={18} />
              <span className="flex-1 text-left">{m}</span>
              {value === m && <span className="text-[10px] text-zinc-400">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = (now - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}
