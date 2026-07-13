import { useCallback, useEffect, useMemo, useState } from "react";
import { Code2, Download, ExternalLink, FileText, Loader2, Minimize2 } from "lucide-react";
import type { ArtifactPreviewData, RoomMessageAttachment } from "../api/client";
import { getArtifactPreview, getArtifactRawBlob, getAttachmentPreview, getAttachmentRawBlob } from "../api/client";
import { Markdown } from "./Markdown";
import { SurfaceShell } from "./SurfaceShell";
import { useDialog } from "./dialogs";
import { downloadFilename, triggerBlobDownload } from "../utils/download-file";

/**
 * Preview Surface — the near-fullscreen in-place preview (GOO-113).
 *
 * One shared large-space surface: artifacts today; docs / tasks / room settings
 * reuse the same container in follow-up tasks. Chat context is one Esc away —
 * this is an overlay, not a navigation.
 */

export interface PreviewSurfaceState {
  kind: "message" | "attachment";
  title: string;
  items: Array<{ path: string; label: string }>;
  selectedIndex: number;
  /** attachment previews resolve through the attachment endpoint */
  messageId?: string;
}

type LoadState =
  | { status: "idle" | "loading"; data?: undefined; error?: undefined }
  | { status: "ready"; data: ArtifactPreviewData; error?: undefined }
  | { status: "error"; data?: undefined; error: string };

export function previewSurfaceStateFrom(state: {
  kind: "message" | "attachment";
  title?: string;
  artifacts?: string[];
  attachments?: RoomMessageAttachment[];
  selectedIndex: number;
  messageId?: string;
}): PreviewSurfaceState {
  if (state.kind === "attachment") {
    return {
      kind: "attachment",
      title: state.title || "Attachments",
      items: (state.attachments || []).map((a) => ({ path: a.storedFilename, label: a.originalFilename })),
      selectedIndex: state.selectedIndex,
      messageId: state.messageId,
    };
  }
  return {
    kind: "message",
    title: state.title || "Artifacts",
    items: (state.artifacts || []).map((p) => ({ path: p, label: p })),
    selectedIndex: state.selectedIndex,
    messageId: state.messageId,
  };
}

export function PreviewSurface({
  roomId,
  state,
  onSelect,
  onCollapse,
  onClose,
}: {
  roomId: string;
  state: PreviewSurfaceState;
  onSelect: (index: number) => void;
  /** back to the compact side panel (keeps selection) */
  onCollapse?: () => void;
  onClose: () => void;
}) {
  const item = state.items[state.selectedIndex] || state.items[0];
  const { toast } = useDialog();
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  const [downloading, setDownloading] = useState(false);
  const [htmlMode, setHtmlMode] = useState<"preview" | "source">("preview");

  useEffect(() => { setHtmlMode("preview"); }, [item?.path]);

  useEffect(() => {
    if (!item?.path) { setLoad({ status: "idle" }); return; }
    let cancelled = false;
    setLoad({ status: "loading" });
    (state.kind === "attachment" ? getAttachmentPreview(roomId, item.path) : getArtifactPreview(roomId, item.path))
      .then((data) => { if (!cancelled) setLoad({ status: "ready", data }); })
      .catch((err: any) => { if (!cancelled) setLoad({ status: "error", error: String(err?.message || err) }); });
    return () => { cancelled = true; };
  }, [roomId, item?.path, state.kind]);

  const title = load.status === "ready" ? load.data.title : (item?.label || state.title);
  const canSource = load.status === "ready" && load.data.type === "html";
  const canOpenTab = load.status === "ready" && (load.data.type === "html" || load.data.type === "md" || load.data.type === "image");

  const openInTab = useMemo(() => () => {
    if (load.status !== "ready") return;
    if (load.data.type === "image") {
      window.open(load.data.content, "_blank", "noopener");
      return;
    }
    const isHtml = load.data.type === "html";
    const blob = new Blob([load.data.content], { type: isHtml ? "text/html" : "text/plain" });
    window.open(URL.createObjectURL(blob), "_blank", "noopener");
  }, [load]);

  const handleDownload = useCallback(async () => {
    if (!item?.path || downloading) return;
    setDownloading(true);
    try {
      const blob = state.kind === "attachment"
        ? await getAttachmentRawBlob(roomId, item.path)
        : await getArtifactRawBlob(roomId, load.status === "ready" ? load.data.originalPath : item.path);
      triggerBlobDownload(blob, downloadFilename(item.label || item.path));
    } catch (err: any) {
      toast(`Download failed: ${String(err?.message || err)}`, "error");
    } finally {
      setDownloading(false);
    }
  }, [downloading, item?.label, item?.path, load, roomId, state.kind, toast]);

  return (
    <SurfaceShell
      testid="preview-surface"
      icon={<Code2 size={15} className="text-accent-ink shrink-0" />}
      title={title}
      meta={<div className="hidden sm:block font-mono text-[10px] text-ink-4 truncate" title={item?.path}>{item?.path}</div>}
      center={state.items.length > 1 ? (
        <div className="ml-2 flex items-center gap-1 overflow-x-auto min-w-0">
          {state.items.map((it, index) => (
            <button
              key={`${it.path}:${index}`}
              onClick={() => onSelect(index)}
              className={`shrink-0 max-w-[180px] truncate px-2 py-1 rounded-md border text-[10px] cursor-pointer ${index === state.selectedIndex ? "border-accent/40 bg-accent-dim text-ink-1" : "border-line bg-surface-0/40 text-ink-3 hover:text-ink-2 hover:border-line-strong"}`}
              title={it.label}
            >
              {it.label.split(/[\\/]/).pop()}
            </button>
          ))}
        </div>
      ) : undefined}
      actions={<>
        {canSource && (
          <div className="flex items-center gap-0.5 rounded-md border border-line bg-inset p-0.5 shrink-0">
            <button onClick={() => setHtmlMode("preview")} className={`px-2 py-1 text-[10px] rounded cursor-pointer ${htmlMode === "preview" ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}>Preview</button>
            <button onClick={() => setHtmlMode("source")} className={`px-2 py-1 text-[10px] rounded cursor-pointer ${htmlMode === "source" ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}>Source</button>
          </div>
        )}
        {item?.path && (
          <button onClick={() => void handleDownload()} disabled={downloading} title="Download" aria-label="Download" className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-default">
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          </button>
        )}
        {canOpenTab && (
          <button onClick={openInTab} title="Open in browser tab" aria-label="Open in browser tab" className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <ExternalLink size={14} />
          </button>
        )}
        {onCollapse && (
          <button onClick={onCollapse} title="Back to side panel" aria-label="Back to side panel" className="hidden md:flex w-8 h-8 items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <Minimize2 size={14} />
          </button>
        )}
      </>}
      onClose={onClose}
    >
      <SurfaceBody load={load} htmlMode={htmlMode} />
    </SurfaceShell>
  );
}

function SurfaceBody({ load, htmlMode }: { load: LoadState; htmlMode: "preview" | "source" }) {
  if (load.status === "idle" || load.status === "loading") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-ink-4">
        <Loader2 size={20} className="animate-spin" />
        <div className="text-xs">Loading preview…</div>
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <div className="max-w-xl mx-auto mt-16 rounded-lg border border-blocked/30 bg-blocked-dim/30 p-4 text-sm text-ink-2">
        <div className="flex items-center gap-2 text-blocked font-semibold text-xs mb-2"><FileText size={14} />Preview unavailable</div>
        <div className="font-mono text-[11px] text-ink-3 whitespace-pre-wrap break-words">{load.error}</div>
      </div>
    );
  }
  const data = load.data!;
  if (data.type === "image") {
    return (
      <div className="h-full overflow-auto p-6 flex items-center justify-center bg-inset/40">
        <img src={data.content} alt={data.title} className="max-w-full max-h-full rounded-lg border border-line bg-surface-1" />
      </div>
    );
  }
  if (data.type === "md") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6 text-[15px] text-ink-1 leading-relaxed preview-markdown">
          <Markdown content={data.content} />
        </div>
      </div>
    );
  }
  if (htmlMode === "source") {
    return (
      <div className="h-full overflow-auto p-4">
        <pre className="p-4 rounded-lg border border-line bg-inset text-[12px] leading-relaxed text-ink-2 whitespace-pre-wrap break-words"><code>{data.content}</code></pre>
      </div>
    );
  }
  return (
    <iframe
      title={data.title}
      sandbox="allow-scripts"
      srcDoc={data.content}
      className="w-full h-full border-0 bg-white"
    />
  );
}
