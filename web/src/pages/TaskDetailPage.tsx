import { useMemberProfileRevision } from "../hooks/useMemberProfileRevision";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ArrowLeft, Trash2, ChevronDown, User, Circle, CircleDot, CheckCircle2, AlertCircle, AlertOctagon, Minus } from "lucide-react";
import type { Task, TaskStatus, TaskPriority, TaskComment } from "../api/client";
import { getTask, updateTask, deleteTaskApi, createTask, getRoom, commentTask, getContacts } from "../api/client";
import { Markdown } from "../components/Markdown";
import { MarkdownField } from "../components/MarkdownField";
import { useDialog } from "../components/dialogs";
import { MobileTopBar } from "../components/MobileTopBar";
import { userActionError } from "../utils/user-error";

interface TaskDetailPageProps {
  roomId: string;
  taskId: string; // empty string = create new
  onBack: () => void;
  onOpenMobileSidebar?: () => void;
}

const STATUS_META: Record<TaskStatus, { label: string; icon: any; dot: string; chip: string }> = {
  todo:          { label: "Todo",        icon: Circle,        dot: "bg-idleg",     chip: "text-ink-2 bg-surface-2" },
  "in-progress": { label: "In Progress", icon: CircleDot,     dot: "bg-accent",     chip: "text-accent-ink bg-accent-dim" },
  review:        { label: "Review",      icon: CircleDot,     dot: "bg-accent",   chip: "text-accent-ink bg-accent-dim" },
  done:          { label: "Done",        icon: CheckCircle2,  dot: "bg-onair",  chip: "text-onair bg-onair-dim" },
};

const PRIORITY_META: Record<TaskPriority, { label: string; icon: any; dot: string; chip: string }> = {
  P0: { label: "P0", icon: AlertOctagon, dot: "bg-blocked",    chip: "text-blocked bg-blocked-dim" },
  P1: { label: "P1", icon: AlertCircle,  dot: "bg-think",  chip: "text-think bg-think-dim" },
  P2: { label: "P2", icon: Minus,        dot: "bg-idleg",   chip: "text-ink-3 bg-surface-2" },
};

const AVATAR_COLORS: Record<string, string> = {
  pm: "bg-avatar-pm", developer: "bg-accent", qa: "bg-onair",
  architect: "bg-think", designer: "bg-avatar-designer", user: "bg-avatar-user", fish: "bg-avatar-user",
};
function avatarColor(name: string) {
  return AVATAR_COLORS[name] || "bg-surface-3";
}

function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <div className={`${avatarColor(name)} rounded-full flex items-center justify-center text-[10px] text-white font-medium shrink-0`}
         style={{ width: size, height: size }} title={name}>
      {name[0]?.toUpperCase()}
    </div>
  );
}

interface ParticipantOption { id: string; name: string }

// Never infer historical task identity from a current name: it may have been reused.
// ID metadata is authoritative. An ID-shaped display name is still only a label.
export function taskParticipantSelection(task: Pick<Task, "assignee" | "assigneeMemberId" | "subscribers" | "subscriberMemberIds">) {
  const assignee = task.assigneeMemberId || "";
  const rawSubscribers = task.subscribers ?? [];
  return {
    assignee,
    subscribers: [...new Set([
      ...(task.subscriberMemberIds ?? []),
      ...rawSubscribers.filter((ref) => ref === "user"),
    ])],
    legacyAssignee: assignee ? "" : task.assignee || "",
    legacySubscribers: task.subscriberMemberIds?.length ? [] : [...new Set(rawSubscribers.filter((ref) => ref !== "user"))],
  };
}

export function taskParticipantPatch(assignee: string, subscribers: string[], assigneeDirty: boolean, subscribersDirty: boolean) {
  return {
    ...(assigneeDirty ? { assignee: assignee || null } : {}),
    ...(subscribersDirty ? { subscribers } : {}),
  };
}

function participantLabel(id: string, members: ParticipantOption[]): string {
  return members.find((member) => member.id === id)?.name ?? id;
}

export function TaskDetailPage({ roomId, taskId, onBack, onOpenMobileSidebar }: TaskDetailPageProps) {
  const { toast, confirm } = useDialog();
  const isCreate = !taskId;
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(!isCreate);
  const [roomName, setRoomName] = useState("");
  const [roomMembers, setRoomMembers] = useState<ParticipantOption[]>([]);

  // Form state — single editable mode (always-editable detail form)
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [newRef, setNewRef] = useState("");
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [priority, setPriority] = useState<TaskPriority>("P1");
  const [assignee, setAssignee] = useState<string>("");
  const [subscribers, setSubscribers] = useState<string[]>([]);
  const [assigneeDirty, setAssigneeDirty] = useState(false);
  const [subscribersDirty, setSubscribersDirty] = useState(false);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [newComment, setNewComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const profileRevision = useMemberProfileRevision();
  const historicalParticipants = useMemo(() => taskParticipantSelection(task ?? {}), [task]);
  const assigneeLabel = assignee ? participantLabel(assignee, roomMembers)
    : !assigneeDirty ? historicalParticipants.legacyAssignee : "";
  const subscriberOptions = useMemo(() => [
    { id: "user", name: "user" },
    ...roomMembers,
    ...subscribers.filter((id) => id !== "user" && !roomMembers.some((member) => member.id === id))
      .map((id) => ({ id, name: id })),
  ], [roomMembers, subscribers]);

  // Load room (for name + members) and task
  useEffect(() => {
    let active = true;
    // 0.20: member names from globalMemberIds + contacts (roomMembers removal — G3 debt ②)
    Promise.all([getRoom(roomId), getContacts()])
      .then(([r, c]) => {
        if (!active) return;
        setRoomName(r.name);
        const byId = new Map(c.contacts.map((m) => [m.memberId, m.name]));
        // Only the authoritative room IDs become selectable values. A profile
        // refresh changes labels, never the selections (including while pending).
        setRoomMembers((r.globalMemberIds ?? []).map((id) => ({ id, name: byId.get(id) ?? id })));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [roomId, profileRevision]);

  useEffect(() => {
    if (isCreate) { setLoading(false); return; }
    setLoading(true);
    getTask(roomId, taskId)
      .then((found) => {
        setTask(found);
        setTitle(found.title);
        setDescription(found.description || "");
        setReferences(found.references || []);
        setStatus(found.status);
        setPriority(found.priority);
        const participants = taskParticipantSelection(found);
        setAssignee(participants.assignee);
        setSubscribers(participants.subscribers);
        setAssigneeDirty(false);
        setSubscribersDirty(false);
        setDirty(false);
        setComments(found.comments || []);
      })
      .catch((err) => { console.error("Failed to load task", err); toast(userActionError("load this task"), "error"); })
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
          subscribers,
        });
        toast("Task created", "success");
        onBack();
      } else {
        await updateTask(roomId, taskId, {
          title: title.trim(), status, priority,
          description: description || undefined,
          references,
          ...taskParticipantPatch(assignee, subscribers, assigneeDirty, subscribersDirty),
          updatedBy: "user",
        });
        const latest = await getTask(roomId, taskId);
        setTask(latest);
        setComments(latest.comments || []);
        const participants = taskParticipantSelection(latest);
        setAssignee(participants.assignee);
        setSubscribers(participants.subscribers);
        setAssigneeDirty(false);
        setSubscribersDirty(false);
        setDirty(false);
        toast("Task saved", "success");
      }
    } catch (err) {
      console.error("Failed to save task", err);
      toast(userActionError("save this task", "Check the required fields, then try again."), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleCommentSubmit = async () => {
    const comment = newComment.trim();
    if (!comment) return;
    setCommenting(true);
    try {
      const updated = await commentTask(roomId, taskId, { author: "user", comment });
      setTask(updated);
      setComments(updated.comments || []);
      setNewComment("");
      toast("Comment added", "success");
    } catch (err) {
      console.error("Failed to add task comment", err);
      toast(userActionError("add this comment"), "error");
    } finally {
      setCommenting(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm(`Delete task "${title}"?`))) return;
    try {
      await deleteTaskApi(roomId, taskId, "user");
      onBack();
    } catch (err) {
      console.error("Failed to delete task", err);
      toast(userActionError("delete this task"), "error");
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
    return <div className="flex-1 flex items-center justify-center text-ink-3 text-sm">Loading…</div>;
  }

  const statusMeta = STATUS_META[status];
  const priorityMeta = PRIORITY_META[priority];


  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-0">
      <MobileTopBar title={isCreate ? "New task" : "Task"} onOpenSidebar={onOpenMobileSidebar || (() => {})} />

      {/* Top bar */}
      <div className="h-12 border-b border-line-soft flex items-center justify-between px-3 shrink-0 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <button onClick={onBack} title="Back" aria-label="Back"
            className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer shrink-0">
            <ArrowLeft size={16} />
          </button>
          <span className="text-xs text-ink-3 truncate">
            <span className="text-ink-4"># </span>{roomName}
            {!isCreate && task && (
              <>
                <span className="text-ink-3 mx-1.5">/</span>
                <span className="text-ink-2 font-mono">T-{task.id.slice(5, 13)}</span>
              </>
            )}
          </span>
          {/* Inline chips in header */}
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
              {assigneeLabel && (
                <span className="inline-flex items-center gap-1 px-1 py-0.5 rounded text-[10px] text-ink-2 bg-surface-2">
                  <Avatar name={assigneeLabel} size={14} />
                  {assigneeLabel}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dirty && <span className="text-[11px] text-think hidden md:inline">● unsaved</span>}
          {!isCreate && (
            <button onClick={handleDelete} title="Delete" aria-label="Delete"
              className="w-8 h-8 flex items-center justify-center rounded text-ink-4 hover:text-blocked hover:bg-surface-2 cursor-pointer">
              <Trash2 size={14} />
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !title.trim() || (!isCreate && !dirty)}
            className="px-3 py-1.5 text-xs font-medium rounded bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed transition-colors"
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
                className="w-full text-2xl md:text-3xl font-bold text-ink-1 bg-transparent focus:outline-none placeholder-ink-4 mb-2 leading-tight"
              />

              {/* Description */}
              <div className="mt-6">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-3 mb-2">Description</div>
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
                  <h3 className="text-xs font-semibold text-ink-3 uppercase tracking-wide">References</h3>
                </div>
                {references.length > 0 && (
                  <ul className="space-y-1 mb-2">
                    {references.map((ref, i) => {
                      const isUrl = /^https?:\/\//.test(ref);
                      const label = ref.split("/").pop() || ref;
                      return (
                        <li key={i} className="group flex items-center gap-2 text-sm px-2 py-1.5 rounded hover:bg-surface-2/50 transition-colors">
                          <span className="text-ink-4 text-xs">{isUrl ? "🔗" : "📄"}</span>
                          {isUrl ? (
                            <a href={ref} target="_blank" rel="noopener noreferrer" className="text-accent-ink hover:opacity-80 truncate flex-1" title={ref}>{label}</a>
                          ) : (
                            <span className="text-ink-2 truncate flex-1" title={ref}>{label}</span>
                          )}
                          <button
                            onClick={() => { setReferences(references.filter((_, j) => j !== i)); markDirty(); }}
                            className="opacity-0 group-hover:opacity-100 text-ink-4 hover:text-blocked transition-opacity text-xs"
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
                    className="flex-1 text-sm px-2 py-1.5 bg-transparent border border-line-soft rounded focus:outline-none focus:border-line-strong placeholder-ink-4 transition-colors"
                  />
                  <button type="submit" disabled={!newRef.trim()} className="text-xs px-2 py-1.5 text-accent-ink hover:opacity-80 disabled:opacity-30">
                    + Add
                  </button>
                </form>
              </div>

              {!isCreate && (
                <div className="mt-8">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-3 mb-3">Comments</div>
                  <div className="space-y-4">
                    {comments.length === 0 ? (
                      <div className="text-sm text-ink-4 italic">No comments yet.</div>
                    ) : comments.map((comment) => (
                      <div key={comment.id} className="flex gap-3">
                        <Avatar name={comment.author} size={24} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-medium text-ink-1">{comment.author}</span>
                            <span className="text-xs text-ink-4">{formatDate(comment.createdAt)}</span>
                          </div>
                          <div className="rounded-lg border border-line-soft bg-surface-1/60 px-3 py-2 text-sm">
                            <Markdown content={comment.content} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4">
                    <textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      placeholder="Add a comment…"
                      rows={3}
                      className="w-full text-sm px-3 py-2 bg-transparent border border-line-soft rounded-lg focus:outline-none focus:border-line-strong placeholder-ink-4 transition-colors resize-y"
                    />
                    <div className="mt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={handleCommentSubmit}
                        disabled={commenting || !newComment.trim()}
                        className="px-3 py-1.5 text-xs font-semibold rounded bg-accent text-accent-contrast disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {commenting ? "Adding…" : "Add comment"}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Footer hint */}
              <div className="mt-8 text-[11px] text-ink-4">
                Esc to go back · ⌘/Ctrl + Enter to save
              </div>
            </div>
          </div>

          {/* Right meta sidebar */}
          <aside className="w-full md:w-80 shrink-0 border-t md:border-t-0 md:border-l border-line-soft px-5 md:px-6 py-6 md:py-8 bg-surface-0/40">
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
                  label={assigneeLabel}
                  members={roomMembers}
                  onChange={(v) => { setAssignee(v); setAssigneeDirty(true); markDirty(); }}
                />
              </MetaRow>

              <MetaRow label="Subscribers">
                <SubscribersPicker
                  value={subscribers}
                  historicalNames={subscribersDirty ? [] : historicalParticipants.legacySubscribers}
                  members={subscriberOptions}
                  onChange={(v) => { setSubscribers(v); setSubscribersDirty(true); markDirty(); }}
                />
                {historicalParticipants.legacySubscribers.length > 0 && (
                  <p className="px-2 mt-1 text-xs text-ink-4">Changing subscribers replaces historical names with your selected members.</p>
                )}
              </MetaRow>

              {!isCreate && task && (
                <>
                  <MetaRow label="Created by">
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <Avatar name={task.createdBy} size={20} />
                      <span className="text-sm text-ink-2">{task.createdBy}</span>
                    </div>
                  </MetaRow>
                  <MetaRow label="Created">
                    <div className="text-xs text-ink-3 px-2">{formatDate(task.createdAt)}</div>
                  </MetaRow>
                  <MetaRow label="Updated">
                    <div className="text-xs text-ink-3 px-2">{formatDate(task.updatedAt)}</div>
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
      <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-3 mb-1.5 px-1">{label}</div>
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
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-surface-2 cursor-pointer text-ink-2 ${open ? "bg-surface-2" : ""}`}
      >
        <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
        <span className="flex-1 text-left">{meta.label}</span>
        <ChevronDown size={12} className="text-ink-4" />
      </button>
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-surface-1 border border-line rounded-lg shadow-lg p-1">
          {(Object.keys(options) as T[]).map((k) => {
            const o = options[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => { onChange(k); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-ink-2 hover:bg-surface-2 cursor-pointer ${current === k ? "bg-surface-2/60" : ""}`}
              >
                <span className={`w-2 h-2 rounded-full ${o.dot}`} />
                <span className="flex-1 text-left">{o.label}</span>
                {current === k && <span className="text-[10px] text-ink-4">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssigneePicker({
  value, label, members, onChange,
}: { value: string; label: string; members: ParticipantOption[]; onChange: (v: string) => void }) {
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
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-surface-2 cursor-pointer text-ink-2 ${open ? "bg-surface-2" : ""}`}
      >
        {label ? (
          <>
            <Avatar name={label} size={18} />
            <span className="flex-1 text-left">{label}</span>
          </>
        ) : (
          <>
            <div className="w-[18px] h-[18px] rounded-full border border-dashed border-line flex items-center justify-center">
              <User size={10} className="text-ink-4" />
            </div>
            <span className="flex-1 text-left text-ink-4">Unassigned</span>
          </>
        )}
        <ChevronDown size={12} className="text-ink-4" />
      </button>
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-surface-1 border border-line rounded-lg shadow-lg p-1 max-h-64 overflow-y-auto">
          <button
            type="button"
            onClick={() => { onChange(""); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-ink-3 hover:bg-surface-2 cursor-pointer ${!label ? "bg-surface-2/60" : ""}`}
          >
            <div className="w-[18px] h-[18px] rounded-full border border-dashed border-line" />
            <span className="flex-1 text-left">Unassigned</span>
          </button>
          {members.length === 0 && (
            <div className="px-2 py-2 text-xs text-ink-4 italic">No members in this room</div>
          )}
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onChange(m.id); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-ink-2 hover:bg-surface-2 cursor-pointer ${value === m.id ? "bg-surface-2/60" : ""}`}
            >
              <Avatar name={m.name} size={18} />
              <span className="flex-1 text-left">{m.name}</span>
              {value === m.id && <span className="text-[10px] text-ink-4">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SubscribersPicker({
  value, historicalNames, members, onChange,
}: { value: string[]; historicalNames: string[]; members: ParticipantOption[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = new Set(value);
  const labels = [...value.map((id) => participantLabel(id, members)), ...historicalNames];
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const toggle = (member: string) => {
    const next = selected.has(member) ? value.filter((v) => v !== member) : [...value, member];
    onChange(next);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-surface-2 cursor-pointer text-ink-2 ${open ? "bg-surface-2" : ""}`}
      >
        <span className="flex-1 text-left truncate">{labels.length > 0 ? labels.join(", ") : "No subscribers"}</span>
        <ChevronDown size={12} className="text-ink-4" />
      </button>
      {open && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-surface-1 border border-line rounded-lg shadow-lg p-1 max-h-64 overflow-y-auto">
          {members.length === 0 && <div className="px-2 py-2 text-xs text-ink-4 italic">No members in this room</div>}
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-ink-2 hover:bg-surface-2 cursor-pointer ${selected.has(m.id) ? "bg-surface-2/60" : ""}`}
            >
              <Avatar name={m.name} size={18} />
              <span className="flex-1 text-left">{m.name}</span>
              {selected.has(m.id) && <span className="text-[10px] text-ink-4">✓</span>}
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
