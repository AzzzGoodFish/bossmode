import { useState, useEffect } from "react";
import { FileText, Image as ImageIcon, Eye, Download, X } from "lucide-react";
import { Markdown } from "./Markdown";

interface MessageBubbleProps {
  sender: string;
  content: string;
  time?: string;
  fullTime?: string;
  grouped?: boolean;
  isMarkdown?: boolean;
  roomId?: string;
}

/** Regex to match attachment lines: Attachment: [original filename: xxx](path) */
const ATTACHMENT_RE = /^Attachment: \[original filename: ([^\]]+)\]\(([^)]+)\)$/;
/** Multi-line aware test — used to detect whether content contains any attachment line */
const ATTACHMENT_RE_M = /^Attachment: \[original filename: ([^\]]+)\]\(([^)]+)\)$/m;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

/** Build API URL for an attachment given roomId. Falls back to legacy roomId-from-path. */
function attachmentUrl(path: string, roomId?: string): string {
  const filename = path.split("/").pop() || "";
  if (roomId) return `/api/rooms/${roomId}/attachments/${filename}`;
  const roomMatch = path.match(/\/rooms\/([^/]+)\//);
  if (roomMatch) return `/api/rooms/${roomMatch[1]}/attachments/${filename}`;
  return "";
}

/** Parse content into text segments and attachment segments */
function parseContentSegments(content: string): Array<{ type: "text"; text: string } | { type: "attachment"; originalName: string; path: string }> {
  const lines = content.split("\n");
  const segments: Array<{ type: "text"; text: string } | { type: "attachment"; originalName: string; path: string }> = [];
  let textBuffer: string[] = [];

  for (const line of lines) {
    const match = line.match(ATTACHMENT_RE);
    if (match) {
      if (textBuffer.length > 0) {
        segments.push({ type: "text", text: textBuffer.join("\n") });
        textBuffer = [];
      }
      segments.push({ type: "attachment", originalName: match[1], path: match[2] });
    } else {
      textBuffer.push(line);
    }
  }

  if (textBuffer.length > 0) {
    const text = textBuffer.join("\n");
    if (text.trim()) segments.push({ type: "text", text });
  }

  return segments;
}

export function MessageBubble({
  sender, content, time, fullTime, grouped = false, isMarkdown = false, roomId,
}: MessageBubbleProps) {
  const isUser = sender === "user";
  const isSystem = sender === "system";

  if (isSystem) {
    return (
      <div className="text-xs text-zinc-500 italic py-1 px-1 flex items-center gap-2">
        <span>{content}</span>
        {time && <span className="text-[11px] text-zinc-400 dark:text-zinc-600 tabular-nums ml-auto" title={fullTime}>{time}</span>}
      </div>
    );
  }

  const avatarBg = isUser ? "bg-blue-100 dark:bg-blue-900/50 border-blue-200 dark:border-blue-800/50" : "bg-emerald-100 dark:bg-emerald-900/50 border-emerald-200 dark:border-emerald-800/50";
  const avatarText = isUser ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400";
  const nameColor = isUser ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400";
  const bubbleBg = isUser ? "bg-blue-50 dark:bg-blue-600/10 border-blue-200/50 dark:border-blue-800/20" : "bg-white dark:bg-zinc-800/60 border-zinc-200/50 dark:border-zinc-700/30";
  const displayName = isUser ? "you" : sender;

  const hasAttachments = ATTACHMENT_RE_M.test(content);

  return (
    <div className={`group flex gap-3 ${grouped ? "mt-0.5" : "mt-3"} -mx-2 px-2 py-0.5 rounded hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 transition-colors`}>
      {grouped
        ? <div className="w-8 shrink-0" />
        : <div className={`w-8 h-8 rounded-full ${avatarBg} border flex items-center justify-center text-xs ${avatarText} font-semibold shrink-0 mt-0.5`}>
            {displayName.charAt(0).toUpperCase()}
          </div>
      }

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2 mb-1">
            <span className={`text-sm font-semibold ${nameColor}`}>{displayName}</span>
            {time && <span className="text-[11px] text-zinc-400 dark:text-zinc-600 tabular-nums">{time}</span>}
          </div>
        )}

        {hasAttachments ? (
          <MessageWithAttachments
            content={content}
            isMarkdown={isMarkdown}
            bubbleBg={bubbleBg}
            roomId={roomId}
          />
        ) : (
          <div className={`${bubbleBg} border rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-300 break-words leading-relaxed inline-block max-w-full`}>
            {isMarkdown ? <Markdown content={content} /> : <MentionText content={content} />}
          </div>
        )}

        {grouped && (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-600 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity ml-2" title={fullTime}>
            {time}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Render message body bubble + lightweight attachment indicators.
 * Each attachment is a compact row (icon + filename + Preview/Download).
 * Click filename or Preview opens lightbox (image) or new tab (file).
 */
function MessageWithAttachments({
  content, isMarkdown, bubbleBg, roomId,
}: { content: string; isMarkdown: boolean; bubbleBg: string; roomId?: string }) {
  const segments = parseContentSegments(content);
  const textSegments = segments.filter((s) => s.type === "text") as Array<{ type: "text"; text: string }>;
  const attachmentSegments = segments.filter((s) => s.type === "attachment") as Array<{ type: "attachment"; originalName: string; path: string }>;

  const bodyText = textSegments.map((s) => s.text).join("\n\n").trim();
  const hasBody = bodyText.length > 0;

  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);

  return (
    <div className="max-w-full">
      {hasBody && (
        <div className={`${bubbleBg} border rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-300 break-words leading-relaxed inline-block max-w-full`}>
          {isMarkdown ? <Markdown content={bodyText} /> : <MentionText content={bodyText} />}
        </div>
      )}

      {attachmentSegments.length > 0 && (
        <div className={`${hasBody ? "mt-1.5" : ""} flex flex-col gap-1 max-w-md`}>
          {attachmentSegments.map((a, i) => (
            <AttachmentRow
              key={i}
              name={a.originalName}
              path={a.path}
              roomId={roomId}
              onPreview={(url) => setPreview({ url, name: a.originalName })}
            />
          ))}
        </div>
      )}

      {preview && (
        <ImageLightbox url={preview.url} name={preview.name} onClose={() => setPreview(null)} />
      )}
    </div>
  );
}

function AttachmentRow({
  name, path, roomId, onPreview,
}: { name: string; path: string; roomId?: string; onPreview: (url: string) => void }) {
  const url = attachmentUrl(path, roomId);
  const isImage = isImagePath(path);
  const Icon = isImage ? ImageIcon : FileText;
  const iconColor = isImage ? "text-blue-500" : "text-zinc-500";

  const handleNameClick = (e: React.MouseEvent) => {
    if (!url) return;
    e.preventDefault();
    if (isImage) onPreview(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="group/att flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
      <Icon size={14} className={`${iconColor} shrink-0`} />
      <button
        type="button"
        disabled={!url}
        onClick={handleNameClick}
        className="text-xs text-zinc-700 dark:text-zinc-300 truncate flex-1 min-w-0 text-left hover:text-zinc-900 dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        title={name}
      >
        {name}
      </button>
      <div className="flex items-center gap-0.5 opacity-0 group-hover/att:opacity-100 transition-opacity shrink-0">
        {isImage && url && (
          <button
            type="button"
            onClick={() => onPreview(url)}
            title="Preview"
            aria-label="Preview"
            className="w-6 h-6 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          >
            <Eye size={12} />
          </button>
        )}
        {url && (
          <a
            href={url}
            download={name}
            title="Download"
            aria-label="Download"
            onClick={(e) => e.stopPropagation()}
            className="w-6 h-6 flex items-center justify-center rounded text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          >
            <Download size={12} />
          </a>
        )}
      </div>
    </div>
  );
}

/** Image lightbox overlay — Esc / click outside to close */
function ImageLightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
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
    <div onClick={onClose}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/85 p-6">
      <div className="absolute top-3 right-3 flex items-center gap-1">
        <a
          href={url}
          download={name}
          onClick={(e) => e.stopPropagation()}
          title="Download"
          aria-label="Download"
          className="w-9 h-9 flex items-center justify-center rounded text-white/80 hover:text-white hover:bg-white/10"
        >
          <Download size={18} />
        </a>
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close"
          className="w-9 h-9 flex items-center justify-center rounded text-white/80 hover:text-white hover:bg-white/10"
        >
          <X size={18} />
        </button>
      </div>
      <img
        src={url}
        alt={name}
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-[85vh] object-contain rounded shadow-2xl"
      />
      <div onClick={(e) => e.stopPropagation()}
        className="mt-3 text-xs text-white/70 font-mono truncate max-w-full">
        {name}
      </div>
    </div>
  );
}

function MentionText({ content }: { content: string }) {
  const parts = content.split(/(@\w+)/g);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) => {
        if (part.startsWith("@")) {
          return <span key={i} className="text-blue-500 dark:text-blue-400 font-medium">{part}</span>;
        }
        return part;
      })}
    </span>
  );
}
