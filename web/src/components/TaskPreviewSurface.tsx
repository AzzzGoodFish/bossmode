import { useEffect, useState } from "react";
import { CheckSquare, ExternalLink, Loader2, Maximize2, MessageSquare, X } from "lucide-react";
import type { Task } from "../api/client";
import { getTask } from "../api/client";
import { Markdown } from "./Markdown";
import { SurfaceShell } from "./SurfaceShell";

/**
 * Task in-place preview (GOO-115) — two tiers, structurally identical to
 * artifact preview: side panel (chat stays) ⤢ fullscreen Surface ⤡ back.
 * Read-only by design — editing lives in the Tasks board full page.
 */

const STATUS_LABEL: Record<string, string> = { todo: "TODO", "in-progress": "IN PROGRESS", review: "REVIEW", done: "DONE" };
const STATUS_CLS: Record<string, string> = {
  todo: "border-line text-ink-3",
  "in-progress": "border-accent/40 text-accent-ink bg-accent-dim",
  review: "border-think/40 text-think bg-think/10",
  done: "border-ok/40 text-ok bg-ok/10",
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; task: Task }
  | { status: "error"; error: string };

function useTaskLoad(roomId: string, taskId: string): LoadState {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    getTask(roomId, taskId)
      .then((task) => { if (!cancelled) setLoad({ status: "ready", task }); })
      .catch((err: any) => { if (!cancelled) setLoad({ status: "error", error: String(err?.message || err) }); });
    return () => { cancelled = true; };
  }, [roomId, taskId]);
  return load;
}

function TaskBody({ load, compact }: { load: LoadState; compact?: boolean }) {
  if (load.status === "loading") {
    return (
      <div className="h-full min-h-[200px] flex flex-col items-center justify-center gap-2 text-ink-4">
        <Loader2 size={compact ? 16 : 20} className="animate-spin" />
        <div className="text-xs">Loading task…</div>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="m-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 p-3 text-sm text-ink-2">
        <div className="text-blocked font-semibold text-xs mb-2">Task unavailable</div>
        <div className="font-mono text-[11px] text-ink-3 whitespace-pre-wrap break-words">{load.error}</div>
      </div>
    );
  }
  const task = load.task;
  return (
    <div className={compact ? "px-3 py-3" : "max-w-3xl mx-auto px-6 py-6"}>
      <div className="flex items-center flex-wrap gap-2 mb-4">
        <span className={`text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded border ${STATUS_CLS[task.status] || STATUS_CLS.todo}`}>{STATUS_LABEL[task.status] || task.status}</span>
        <span className="text-[10px] font-semibold px-2 py-0.5 rounded border border-line text-ink-3">{task.priority}</span>
        {task.assignee && <span className="text-[11px] text-ink-3">assignee <span className="font-mono text-ink-2">@{task.assignee}</span></span>}
        {!compact && <span className="text-[11px] text-ink-4 ml-auto">by {task.createdBy} · {new Date(task.createdAt).toLocaleString()}</span>}
      </div>

      {task.description ? (
        <div className={`${compact ? "text-[12.5px]" : "text-[14px]"} text-ink-1 leading-relaxed preview-markdown mb-5`}>
          <Markdown content={task.description} />
        </div>
      ) : (
        <p className="text-xs text-ink-4 mb-5">No description.</p>
      )}

      {task.references && task.references.length > 0 && (
        <div className="mb-5">
          <div className="text-[10px] font-semibold tracking-wide text-ink-4 mb-2">REFERENCES</div>
          <ul className="space-y-1">
            {task.references.map((ref, i) => <li key={i} className="font-mono text-[11px] text-ink-3 truncate">{ref}</li>)}
          </ul>
        </div>
      )}

      {task.comments && task.comments.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-ink-4 mb-2">
            <MessageSquare size={11} /> COMMENTS · {task.comments.length}
          </div>
          <div className="space-y-2.5">
            {task.comments.map((c, i) => (
              <div key={i} className={`rounded-lg border border-line bg-inset/50 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
                <div className="text-[11px] text-ink-4 mb-1"><span className="font-mono text-ink-3">{c.author}</span> · {new Date(c.createdAt).toLocaleString()}</div>
                <div className={`${compact ? "text-[12px]" : "text-[13px]"} text-ink-2 leading-relaxed preview-markdown`}><Markdown content={c.content} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Tier 1: side panel — chat stays visible, same slot/width as artifact preview. */
export function TaskPreviewPanel({
  roomId,
  taskId,
  onExpand,
  onOpenFull,
  onClose,
}: {
  roomId: string;
  taskId: string;
  onExpand: () => void;
  onOpenFull?: () => void;
  onClose: () => void;
}) {
  const load = useTaskLoad(roomId, taskId);
  const title = load.status === "ready" ? load.task.title : "Task";
  return (
    <div className="h-full min-h-0 flex flex-col bg-surface-1 border-l border-line" data-testid="task-preview-panel">
      <div className="shrink-0 border-b border-line-soft px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <CheckSquare size={14} className="text-accent-ink shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-ink-1 truncate" title={title}>{title}</div>
            <div className="font-mono text-[10px] text-ink-4 truncate">{load.status === "ready" && load.task.linearIssueIdentifier ? load.task.linearIssueIdentifier : taskId}</div>
          </div>
          {onOpenFull && (
            <button onClick={onOpenFull} title="Open in Tasks board" aria-label="Open in Tasks board" className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
              <ExternalLink size={13} />
            </button>
          )}
          <button onClick={onExpand} title="Expand preview" aria-label="Expand preview" className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <Maximize2 size={13} />
          </button>
          <button onClick={onClose} title="Close preview" aria-label="Close preview" className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <TaskBody load={load} compact />
      </div>
    </div>
  );
}

/** Tier 2: fullscreen Surface — same shell as artifact preview. */
export function TaskPreviewSurface({
  roomId,
  taskId,
  onOpenFull,
  onCollapse,
  onClose,
}: {
  roomId: string;
  taskId: string;
  onOpenFull?: () => void;
  /** back to the side panel tier (keeps selection) */
  onCollapse?: () => void;
  onClose: () => void;
}) {
  const load = useTaskLoad(roomId, taskId);
  const task = load.status === "ready" ? load.task : null;
  return (
    <SurfaceShell
      testid="task-preview-surface"
      icon={<CheckSquare size={15} className="text-accent-ink shrink-0" />}
      title={task ? task.title : "Task"}
      meta={task?.linearIssueIdentifier ? <span className="hidden sm:block font-mono text-[10px] text-ink-4">{task.linearIssueIdentifier}</span> : undefined}
      actions={<>
        {onOpenFull && (
          <button
            onClick={onOpenFull}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-ink-2 border border-line rounded hover:bg-surface-2 cursor-pointer shrink-0"
            title="Open in Tasks board (edit there)"
          >
            <ExternalLink size={12} /> Open in Tasks board
          </button>
        )}
        {onCollapse && (
          <button onClick={onCollapse} title="Back to side panel" aria-label="Back to side panel" className="hidden md:flex w-8 h-8 items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 14h6v6M20 10h-6V4"/></svg>
          </button>
        )}
      </>}
      onClose={onClose}
    >
      <div className="h-full overflow-y-auto">
        <TaskBody load={load} />
      </div>
    </SurfaceShell>
  );
}
