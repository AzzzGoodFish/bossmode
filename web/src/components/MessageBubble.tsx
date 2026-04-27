import { FileText, Paperclip, Image as ImageIcon } from "lucide-react";
import { Markdown } from "./Markdown";

interface MessageBubbleProps {
  sender: string;
  content: string;
  time?: string;
  fullTime?: string;
  grouped?: boolean;
  isMarkdown?: boolean;
}

/** Regex to match attachment lines: Attachment: [original filename: xxx](path) */
const ATTACHMENT_RE = /^Attachment: \[original filename: ([^\]]+)\]\(([^)]+)\)$/;
/** Multi-line aware test — used to detect whether content contains any attachment line */
const ATTACHMENT_RE_M = /^Attachment: \[original filename: ([^\]]+)\]\(([^)]+)\)$/m;

/** Image extensions for inline preview */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

/** Convert absolute server path to API URL for serving */
function attachmentUrl(path: string, content: string): string {
  // Extract roomId from the attachment URL pattern in the message or from path
  // Path format: /home/.../.bossmode-attachments/hash.ext or room cwd based
  // We use the API URL pattern: /api/rooms/:id/attachments/:filename
  // But we don't have roomId here, so we use a relative path trick:
  // Look for the API URL in the original content if available
  const filename = path.split("/").pop() || "";
  // Try to find the room context from path — look for rooms/<id> in bossmode dir
  // Simpler approach: serve from window.location with a special route
  // Actually, the backend serves GET /api/rooms/:id/attachments/:filename
  // We need the roomId. Let's extract from path if it contains .bossmode/rooms/<id>/
  const roomMatch = path.match(/\/rooms\/([^/]+)\//);
  if (roomMatch) {
    return `/api/rooms/${roomMatch[1]}/attachments/${filename}`;
  }
  // Fallback: can't determine room, just show filename
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
  sender, content, time, fullTime, grouped = false, isMarkdown = false,
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

  // Check if content has attachments (any line matches; multi-line aware)
  const hasAttachments = ATTACHMENT_RE_M.test(content);

  return (
    <div className={`group flex gap-3 ${grouped ? "mt-0.5" : "mt-3"} -mx-2 px-2 py-0.5 rounded hover:bg-zinc-100/50 dark:hover:bg-zinc-900/20`}>
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

/** Render message with body bubble + visually distinct attachment region below */
function MessageWithAttachments({
  content, isMarkdown, bubbleBg,
}: { content: string; isMarkdown: boolean; bubbleBg: string }) {
  const segments = parseContentSegments(content);
  const textSegments = segments.filter((s) => s.type === "text") as Array<{ type: "text"; text: string }>;
  const attachmentSegments = segments.filter((s) => s.type === "attachment") as Array<{ type: "attachment"; originalName: string; path: string }>;

  // Combine all text segments into one body (handles "text \n attachment \n text" gracefully)
  const bodyText = textSegments.map((s) => s.text).join("\n\n").trim();
  const hasBody = bodyText.length > 0;

  return (
    <div className="max-w-full">
      {hasBody && (
        <div className={`${bubbleBg} border rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-300 break-words leading-relaxed inline-block max-w-full`}>
          {isMarkdown ? <Markdown content={bodyText} /> : <MentionText content={bodyText} />}
        </div>
      )}

      {attachmentSegments.length > 0 && (
        <div className={`${hasBody ? "mt-1.5" : ""} flex flex-col gap-1.5`}>
          {/* Header: "N attachments" hint, only when more than one or when no body text */}
          {(attachmentSegments.length > 1 || !hasBody) && (
            <div className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400 px-0.5">
              <Paperclip size={11} className="shrink-0" />
              <span>{attachmentSegments.length} attachment{attachmentSegments.length === 1 ? "" : "s"}</span>
            </div>
          )}

          {/* Attachment cards — image grid + non-image stack */}
          <AttachmentGroup attachments={attachmentSegments} content={content} />
        </div>
      )}
    </div>
  );
}

function AttachmentGroup({
  attachments, content,
}: {
  attachments: Array<{ type: "attachment"; originalName: string; path: string }>;
  content: string;
}) {
  const images = attachments.filter((a) => isImagePath(a.path));
  const files = attachments.filter((a) => !isImagePath(a.path));

  return (
    <div className="flex flex-col gap-1.5">
      {images.length > 0 && (
        <div
          className={`grid gap-1.5 ${
            images.length === 1 ? "grid-cols-1" :
            images.length === 2 ? "grid-cols-2" :
            "grid-cols-2 sm:grid-cols-3"
          } max-w-md`}
        >
          {images.map((a, i) => {
            const url = attachmentUrl(a.path, content);
            return (
              <a
                key={i}
                href={url || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="group/att relative block overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors"
                title={a.originalName}
              >
                {url ? (
                  <img
                    src={url}
                    alt={a.originalName}
                    className={`w-full ${images.length === 1 ? "max-h-56" : "h-28"} object-cover`}
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-28 flex items-center justify-center text-zinc-400">
                    <ImageIcon size={20} />
                  </div>
                )}
                <div className="absolute bottom-0 inset-x-0 px-1.5 py-0.5 text-[10px] text-white bg-gradient-to-t from-black/70 to-transparent truncate opacity-0 group-hover/att:opacity-100 transition-opacity">
                  {a.originalName}
                </div>
              </a>
            );
          })}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex flex-col gap-1 max-w-md">
          {files.map((a, i) => {
            const url = attachmentUrl(a.path, content);
            return (
              <a
                key={i}
                href={url || undefined}
                target={url ? "_blank" : undefined}
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 hover:border-zinc-400 dark:hover:border-zinc-600 transition-colors"
                title={a.originalName}
              >
                <FileText size={14} className="text-zinc-500 shrink-0" />
                <span className="text-xs text-zinc-700 dark:text-zinc-300 truncate flex-1">{a.originalName}</span>
              </a>
            );
          })}
        </div>
      )}
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
