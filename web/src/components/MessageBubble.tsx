import { useState, useEffect } from "react";
import { FileText, FileCode, Image as ImageIcon, Eye, Download, X } from "lucide-react";
import { Markdown } from "./Markdown";
import type { RoomMessageAttachment } from "../api/client";

interface MessageBubbleProps {
  sender: string;
  content: string;
  time?: string;
  fullTime?: string;
  grouped?: boolean;
  isMarkdown?: boolean;
  roomId?: string;
  messageId?: string;
  attachments?: RoomMessageAttachment[];
  onPreviewAttachment?: (messageId: string, attachments: RoomMessageAttachment[], selectedIndex: number) => void;
  activeAttachmentPreview?: { messageId: string; storedFilename: string } | null;
}

/** Regex to match attachment lines: Attachment: [original filename: xxx](path) */
const ATTACHMENT_RE = /^Attachment: \[original filename: ([^\]]+)\]\(([^)]+)\)$/;
/** Multi-line aware test — used to detect whether content contains any attachment line */
const ATTACHMENT_RE_M = /^Attachment: \[original filename: ([^\]]+)\]\(([^)]+)\)$/m;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const MARKDOWN_EXTS = new Set([".md", ".markdown"]);
const HTML_EXTS = new Set([".html", ".htm"]);

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

function inferPreviewType(path: string): RoomMessageAttachment["previewType"] {
  const ext = extOf(path);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  return "download";
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
  sender, content, time, fullTime, grouped = false, isMarkdown = false, roomId, messageId, attachments, onPreviewAttachment, activeAttachmentPreview,
}: MessageBubbleProps) {
  const isUser = sender === "user";
  const isSystem = sender === "system";

  if (isSystem) {
    return (
      <div className="text-xs text-ink-4 italic py-1 px-1 flex items-center gap-2">
        <span>{content}</span>
        {time && <span className="text-[11px] text-ink-4 tabular-nums ml-auto" title={fullTime}>{time}</span>}
      </div>
    );
  }

  const avatarBg = isUser ? "bg-accent-dim border-accent/20" : "bg-surface-3 border-line";
  const avatarText = isUser ? "text-accent-ink" : "text-ink-2";
  const nameColor = isUser ? "text-accent-ink" : "text-ink-1";
  const bubbleBg = isUser ? "bg-accent-dim border-accent/15" : "bg-surface-2/60 border-line-soft";
  const displayName = isUser ? "you" : sender;

  const hasAttachments = ATTACHMENT_RE_M.test(content) || (attachments?.length ?? 0) > 0;

  return (
    <div className={`group flex gap-3 ${grouped ? "mt-0.5" : "mt-3"} -mx-2 px-2 py-0.5 rounded hover:bg-surface-2/40 transition-colors`}>
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
            {time && <span className="text-[11px] text-ink-4 tabular-nums">{time}</span>}
          </div>
        )}

        {hasAttachments ? (
          <MessageWithAttachments
            content={content}
            isMarkdown={isMarkdown}
            bubbleBg={bubbleBg}
            roomId={roomId}
            messageId={messageId}
            attachments={attachments}
            onPreviewAttachment={onPreviewAttachment}
            activeAttachmentPreview={activeAttachmentPreview}
          />
        ) : (
          <div className={`${bubbleBg} border rounded-lg px-3 py-2 text-sm text-ink-1 break-words leading-relaxed inline-block max-w-full`}>
            {isMarkdown ? <Markdown content={content} /> : <MentionText content={content} />}
          </div>
        )}

        {grouped && (
          <span className="text-[11px] text-ink-4 tabular-nums opacity-0 group-hover:opacity-100 transition-opacity ml-2" title={fullTime}>
            {time}
          </span>
        )}
      </div>
    </div>
  );
}

type RenderAttachment = RoomMessageAttachment & { legacyPath?: string };

function legacyToAttachment(a: { originalName: string; path: string }): RenderAttachment {
  const storedFilename = a.path.split(/[\\/]/).pop() || a.path;
  return {
    id: `legacy:${storedFilename}:${a.originalName}`,
    storedFilename,
    originalFilename: a.originalName,
    previewType: inferPreviewType(storedFilename || a.originalName),
    legacyPath: a.path,
  };
}

/** Render message body bubble + lightweight attachment cards. */
function MessageWithAttachments({
  content, isMarkdown, bubbleBg, roomId, messageId, attachments, onPreviewAttachment, activeAttachmentPreview,
}: {
  content: string;
  isMarkdown: boolean;
  bubbleBg: string;
  roomId?: string;
  messageId?: string;
  attachments?: RoomMessageAttachment[];
  onPreviewAttachment?: (messageId: string, attachments: RoomMessageAttachment[], selectedIndex: number) => void;
  activeAttachmentPreview?: { messageId: string; storedFilename: string } | null;
}) {
  const segments = parseContentSegments(content);
  const textSegments = segments.filter((s) => s.type === "text") as Array<{ type: "text"; text: string }>;
  const legacySegments = segments.filter((s) => s.type === "attachment") as Array<{ type: "attachment"; originalName: string; path: string }>;

  const bodyText = textSegments.map((s) => s.text).join("\n\n").trim();
  const hasBody = bodyText.length > 0;
  const renderAttachments: RenderAttachment[] = attachments?.length ? attachments : legacySegments.map(legacyToAttachment);
  const documentPreviewAttachments = renderAttachments.filter((a) => a.previewType === "markdown" || a.previewType === "html");

  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);

  return (
    <div className="max-w-full">
      {hasBody && (
        <div className={`${bubbleBg} border rounded-lg px-3 py-2 text-sm text-ink-1 break-words leading-relaxed inline-block max-w-full`}>
          {isMarkdown ? <Markdown content={bodyText} /> : <MentionText content={bodyText} />}
        </div>
      )}

      {renderAttachments.length > 0 && (
        <div className={`${hasBody ? "mt-1.5" : ""} flex flex-col gap-1.5 max-w-2xl`}>
          {renderAttachments.map((a, i) => (
            <AttachmentRow
              key={`${a.id}:${i}`}
              attachment={a}
              roomId={roomId}
              active={!!messageId && activeAttachmentPreview?.messageId === messageId && activeAttachmentPreview.storedFilename === a.storedFilename}
              onImagePreview={(url) => setPreview({ url, name: a.originalFilename })}
              onDocumentPreview={messageId && onPreviewAttachment ? () => {
                const selectedIndex = documentPreviewAttachments.findIndex((item) => item.storedFilename === a.storedFilename);
                onPreviewAttachment(messageId, documentPreviewAttachments, Math.max(0, selectedIndex));
              } : undefined}
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
  attachment, roomId, active, onImagePreview, onDocumentPreview,
}: {
  attachment: RenderAttachment;
  roomId?: string;
  active?: boolean;
  onImagePreview: (url: string) => void;
  onDocumentPreview?: () => void;
}) {
  const name = attachment.originalFilename;
  const url = attachmentUrl(attachment.legacyPath || attachment.storedFilename, roomId);
  const previewType = attachment.previewType || inferPreviewType(attachment.storedFilename || name);
  const isImage = previewType === "image";
  const canDocumentPreview = previewType === "markdown" || previewType === "html";
  const Icon = isImage ? ImageIcon : previewType === "html" ? FileCode : FileText;
  const iconColor = isImage || canDocumentPreview ? "text-accent-ink" : "text-ink-3";

  const handleOpen = (e: React.MouseEvent) => {
    if (!url) return;
    e.preventDefault();
    if (isImage) onImagePreview(url);
    else if (canDocumentPreview && onDocumentPreview) onDocumentPreview();
    else window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className={`group/att flex items-center gap-2 px-2.5 py-1.5 rounded-md border bg-surface-0/40 transition-colors ${active ? "border-accent/50 bg-accent-dim/40" : "border-line hover:border-line-strong"}`}>
      {isImage && url ? (
        <button type="button" onClick={() => onImagePreview(url)} className="w-9 h-9 rounded border border-line overflow-hidden bg-inset shrink-0" aria-label={`Preview ${name}`}>
          <img src={url} alt="" className="w-full h-full object-cover" />
        </button>
      ) : (
        <Icon size={15} className={`${iconColor} shrink-0`} />
      )}
      <button
        type="button"
        disabled={!url}
        onClick={handleOpen}
        className="text-xs text-ink-2 truncate flex-1 min-w-0 text-left hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-60"
        title={name}
      >
        {name}
      </button>
      <span className="text-[9px] uppercase font-bold text-ink-4 shrink-0">{previewType === "markdown" ? "md" : previewType}</span>
      <div className="flex items-center gap-0.5 opacity-100 transition-opacity shrink-0">
        {(isImage || canDocumentPreview) && url && (
          <button
            type="button"
            onClick={() => isImage ? onImagePreview(url) : onDocumentPreview?.()}
            title="Preview"
            aria-label="Preview"
            className="w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2"
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
            className="w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2"
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
          return <span key={i} className="text-accent-ink font-medium">{part}</span>;
        }
        return part;
      })}
    </span>
  );
}
