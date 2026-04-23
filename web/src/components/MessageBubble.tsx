import { FileText } from "lucide-react";
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

  // Check if content has attachments
  const hasAttachments = ATTACHMENT_RE.test(content);

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
          <div className={`${bubbleBg} border rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-300 break-words leading-relaxed inline-block max-w-full`}>
            <AttachmentContent content={content} isMarkdown={isMarkdown} />
          </div>
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

/** Render content with inline attachments */
function AttachmentContent({ content, isMarkdown }: { content: string; isMarkdown: boolean }) {
  const segments = parseContentSegments(content);

  return (
    <div className="space-y-2">
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          return (
            <div key={i}>
              {isMarkdown ? <Markdown content={seg.text} /> : <MentionText content={seg.text} />}
            </div>
          );
        }

        // Attachment segment
        const url = attachmentUrl(seg.path, content);
        const isImage = isImagePath(seg.path);

        if (isImage && url) {
          return (
            <div key={i} className="mt-1">
              <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                <img
                  src={url}
                  alt={seg.originalName}
                  className="max-w-xs max-h-48 rounded border border-zinc-300 dark:border-zinc-600 hover:border-blue-400 transition-colors"
                  loading="lazy"
                />
              </a>
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5">{seg.originalName}</div>
            </div>
          );
        }

        // Non-image file
        return (
          <div key={i} className="flex items-center gap-2 p-2 bg-zinc-50 dark:bg-zinc-800/50 rounded border border-zinc-200 dark:border-zinc-700">
            <FileText size={16} className="text-zinc-400 shrink-0" />
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:text-blue-400 truncate">
                {seg.originalName}
              </a>
            ) : (
              <span className="text-xs text-zinc-600 dark:text-zinc-400 truncate">{seg.originalName}</span>
            )}
          </div>
        );
      })}
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
