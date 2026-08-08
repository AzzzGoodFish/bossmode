import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Code2, Download, FileCode, FileText, Loader2, Maximize2, X } from "lucide-react";
import type { ArtifactPreviewData, RoomMessageAttachment } from "../api/client";
import { getArtifactPreview, getArtifactRawBlob, getAttachmentPreview, getAttachmentRawBlob } from "../api/client";
import { Markdown } from "./Markdown";
import { useDialog } from "./dialogs";
import { downloadFilename, triggerBlobDownload } from "../utils/download-file";

export interface MessageArtifactPreviewState {
  kind: "message";
  messageId: string;
  title: string;
  artifacts: string[];
  selectedIndex: number;
}

export interface ChatAttachmentPreviewState {
  kind: "attachment";
  messageId: string;
  title: string;
  attachments: RoomMessageAttachment[];
  selectedIndex: number;
}

type PreviewState = MessageArtifactPreviewState | ChatAttachmentPreviewState;

interface ArtifactPreviewPanelProps {
  roomId: string;
  state: PreviewState;
  onSelect: (index: number) => void;
  onClose: () => void;
  variant: "panel" | "sheet";
  /** When provided, the expand button hands off to the near-fullscreen Preview Surface instead of the legacy lightbox. */
  onExpand?: () => void;
}

type LoadState =
  | { status: "idle" | "loading"; data?: undefined; error?: undefined }
  | { status: "ready"; data: ArtifactPreviewData; error?: undefined }
  | { status: "error"; data?: undefined; error: string };

function artifactKind(path: string): "md" | "html" | "other" {
  if (/\.md$/i.test(path)) return "md";
  if (/\.html?$/i.test(path)) return "html";
  return "other";
}

// Ext → Prism language mapping for text preview.
const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".sh": "bash", ".bash": "bash", ".json": "json",
  ".yaml": "yaml", ".yml": "yaml", ".xml": "xml", ".css": "css", ".scss": "scss",
  ".sql": "sql", ".go": "go", ".rs": "rust", ".java": "java", ".c": "c",
  ".cpp": "cpp", ".cs": "csharp", ".rb": "ruby", ".php": "php",
  ".swift": "swift", ".kt": "kotlin", ".vue": "vue", ".md": "markdown",
  ".diff": "diff", ".patch": "diff",
};

function extToLanguage(filename: string): string | undefined {
  const clean = filename.split(/[\\/]/).pop() || "";
  const idx = clean.lastIndexOf(".");
  if (idx < 0) {
    const lower = clean.toLowerCase();
    if (lower === "dockerfile" || lower === "makefile" || lower === ".gitignore") return "bash";
    return undefined;
  }
  return EXT_TO_LANG[clean.slice(idx).toLowerCase()];
}

function TextPreview({ title, content }: { title: string; content: string }) {
  const lang = extToLanguage(title);
  return (
    <pre className="rounded-lg border border-line bg-inset overflow-auto" style={{ maxHeight: "70vh" }}>
      <code className={`language-${lang || "none"} text-[11px] leading-relaxed block p-3 text-ink-2 whitespace-pre-wrap break-words`}>{content}</code>
    </pre>
  );
}

function artifactName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function ArtifactPreviewPanel({ roomId, state, onSelect, onClose, variant, onExpand }: ArtifactPreviewPanelProps) {
  const { toast } = useDialog();
  const isAttachment = state.kind === "attachment";
  const items = isAttachment ? state.attachments : state.artifacts;
  const selectedAttachment = isAttachment ? state.attachments[state.selectedIndex] || state.attachments[0] : null;
  const selectedPath = isAttachment ? (selectedAttachment?.storedFilename || "") : (state.artifacts[state.selectedIndex] || state.artifacts[0] || "");
  const selectedLabel = isAttachment ? (selectedAttachment?.originalFilename || selectedPath) : selectedPath;
  const [load, setLoad] = useState<LoadState>({ status: "idle" });
  const [htmlMode, setHtmlMode] = useState<"preview" | "source">("preview");
  const [focusOpen, setFocusOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setHtmlMode("preview");
  }, [selectedPath]);

  useEffect(() => {
    if (!selectedPath) {
      setLoad({ status: "idle" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    (isAttachment ? getAttachmentPreview(roomId, selectedPath) : getArtifactPreview(roomId, selectedPath))
      .then((data) => { if (!cancelled) setLoad({ status: "ready", data }); })
      .catch((err: any) => { if (!cancelled) setLoad({ status: "error", error: String(err?.message || err) }); });
    return () => { cancelled = true; };
  }, [roomId, selectedPath, isAttachment]);

  const title = isAttachment ? selectedLabel : (load.status === "ready" ? load.data.title : artifactName(selectedPath));
  const canSource = load.status === "ready" && load.data.type === "html";

  const handleDownload = useCallback(async () => {
    if (!selectedPath || downloading) return;
    setDownloading(true);
    try {
      const blob = isAttachment
        ? await getAttachmentRawBlob(roomId, selectedPath)
        : await getArtifactRawBlob(roomId, load.status === "ready" ? load.data.originalPath : selectedPath);
      triggerBlobDownload(blob, downloadFilename(selectedLabel || selectedPath));
    } catch (err: any) {
      toast(`Download failed: ${String(err?.message || err)}`, "error");
    } finally {
      setDownloading(false);
    }
  }, [downloading, isAttachment, load, roomId, selectedLabel, selectedPath, toast]);

  const body = useMemo(() => (
    <ArtifactPreviewBody load={load} htmlMode={htmlMode} />
  ), [load, htmlMode]);

  return (
    <div className={`h-full min-h-0 flex flex-col bg-surface-1 ${variant === "panel" ? "border-l border-line" : ""}`}>
      <div className="shrink-0 border-b border-line-soft px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-accent-ink shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-ink-1 truncate">{title}</div>
            <div className="font-mono text-[10px] text-ink-4 truncate" title={selectedLabel}>{selectedLabel}</div>
          </div>
          {canSource && (
            <div className="flex items-center gap-0.5 rounded-md border border-line bg-inset p-0.5 shrink-0">
              <button
                onClick={() => setHtmlMode("preview")}
                className={`px-2 py-1 text-[10px] rounded cursor-pointer ${htmlMode === "preview" ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}
              >
                Preview
              </button>
              <button
                onClick={() => setHtmlMode("source")}
                className={`px-2 py-1 text-[10px] rounded cursor-pointer ${htmlMode === "source" ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}
              >
                Source
              </button>
            </div>
          )}
          {selectedPath && (
            <button
              onClick={() => void handleDownload()}
              disabled={downloading}
              className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-default"
              title="Download"
              aria-label="Download"
            >
              {downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            </button>
          )}
          <button
            onClick={() => (onExpand ? onExpand() : setFocusOpen(true))}
            className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer"
            title="Expand preview"
            aria-label="Expand preview"
          >
            <Maximize2 size={13} />
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer"
            title="Close preview"
            aria-label="Close preview"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {items.length > 1 && (
        <div className="shrink-0 border-b border-line-soft px-2 py-2 flex gap-1 overflow-x-auto">
          {items.map((item, index) => {
            const path = typeof item === "string" ? item : item.storedFilename;
            const label = typeof item === "string" ? artifactName(item) : item.originalFilename;
            const kind = typeof item === "string" ? artifactKind(path) : item.previewType;
            const active = index === state.selectedIndex;
            return (
              <button
                key={`${path}:${index}`}
                onClick={() => onSelect(index)}
                className={`min-w-0 shrink-0 max-w-[220px] flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-[10px] cursor-pointer ${active ? "border-accent/40 bg-accent-dim text-ink-1" : "border-line bg-surface-0/40 text-ink-3 hover:text-ink-2 hover:border-line-strong"}`}
                title={label}
              >
                <span className="uppercase font-bold text-[8px] text-ink-4">{kind === "markdown" ? "md" : kind}</span>
                <span className="font-mono truncate">{label}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        {body}
      </div>

      {focusOpen && (
        <ArtifactPreviewLightbox
          title={title}
          path={selectedLabel}
          load={load}
          htmlMode={htmlMode}
          downloading={downloading}
          onDownload={handleDownload}
          onClose={() => setFocusOpen(false)}
        />
      )}
    </div>
  );
}

function ArtifactPreviewBody({ load, htmlMode }: { load: LoadState; htmlMode: "preview" | "source" }) {
  if (load.status === "idle" || load.status === "loading") {
    return (
      <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-2 text-ink-4">
        <Loader2 size={18} className="animate-spin" />
        <div className="text-xs">Loading preview…</div>
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <div className="m-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 p-3 text-sm text-ink-2">
        <div className="flex items-center gap-2 text-blocked font-semibold text-xs mb-2">
          <AlertTriangle size={14} />
          Preview unavailable
        </div>
        <div className="font-mono text-[11px] text-ink-3 whitespace-pre-wrap break-words">{load.error}</div>
      </div>
    );
  }

  const data = load.data!;
  if (data.type === "image") {
    return (
      <div className="h-full min-h-[420px] p-3 flex items-center justify-center bg-inset/40">
        <img src={data.content} alt={data.title} className="max-w-full max-h-full rounded-lg border border-line bg-surface-1" />
      </div>
    );
  }
  if (data.type === "md") {
    return (
      <div className="px-4 py-3 text-sm text-ink-1 leading-relaxed preview-markdown">
        <Markdown content={data.content} />
      </div>
    );
  }
  if (data.type === "text") {
    const MAX_RENDER = 200_000;
    const truncated = data.content.length > MAX_RENDER;
    const body = truncated ? data.content.slice(0, MAX_RENDER) : data.content;
    return (
      <div className="m-3">
        <TextPreview title={data.title} content={body} />
        {truncated && (
          <div className="mt-2 text-[11px] text-ink-4">
            Showing first {MAX_RENDER.toLocaleString()} chars · full content available via download.
          </div>
        )}
      </div>
    );
  }

  if (htmlMode === "source") {
    return (
      <pre className="m-3 p-3 rounded-lg border border-line bg-inset text-[11px] leading-relaxed text-ink-2 overflow-auto whitespace-pre-wrap break-words"><code>{data.content}</code></pre>
    );
  }

  return (
    <div className="h-full min-h-[420px] p-3">
      <div className="h-full min-h-[390px] rounded-lg border border-line bg-white overflow-hidden">
        <iframe
          title={data.title}
          sandbox="allow-scripts"
          srcDoc={data.content}
          className="w-full h-full min-h-[390px] border-0 bg-white"
        />
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-4">
        <FileCode size={11} />
        HTML sandbox preview · scripts allowed, same-origin blocked
      </div>
    </div>
  );
}

function ArtifactPreviewLightbox({ title, path, load, htmlMode, downloading, onDownload, onClose }: { title: string; path: string; load: LoadState; htmlMode: "preview" | "source"; downloading: boolean; onDownload: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm p-4 sm:p-7 flex items-center justify-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-6xl h-[88vh] rounded-xl border border-white/10 bg-surface-1 shadow-2xl flex flex-col min-h-0 overflow-hidden"
      >
        <div className="h-12 shrink-0 border-b border-line px-4 flex items-center gap-2">
          <Code2 size={15} className="text-accent-ink shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink-1 truncate">{title}</div>
            <div className="font-mono text-[10px] text-ink-4 truncate" title={path}>{path}</div>
          </div>
          <button
            onClick={() => onDownload()}
            disabled={downloading}
            title="Download"
            aria-label="Download"
            className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          </button>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <ArtifactPreviewBody load={load} htmlMode={htmlMode} />
        </div>
      </div>
    </div>
  );
}
