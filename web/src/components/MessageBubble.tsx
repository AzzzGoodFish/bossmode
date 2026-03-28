import { Markdown } from "./Markdown";

interface MessageBubbleProps {
  sender: string;
  content: string;
  time?: string;
  fullTime?: string;
  grouped?: boolean;
  isMarkdown?: boolean;
}

export function MessageBubble({
  sender, content, time, fullTime, grouped = false, isMarkdown = false,
}: MessageBubbleProps) {
  const isUser = sender === "user";
  const isSystem = sender === "system";

  if (isSystem) {
    return (
      <div className="text-xs text-zinc-500 italic py-1 px-1">
        {content}
      </div>
    );
  }

  const avatarBg = isUser ? "bg-blue-100 dark:bg-blue-900/50 border-blue-200 dark:border-blue-800/50" : "bg-emerald-100 dark:bg-emerald-900/50 border-emerald-200 dark:border-emerald-800/50";
  const avatarText = isUser ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400";
  const nameColor = isUser ? "text-blue-600 dark:text-blue-400" : "text-emerald-600 dark:text-emerald-400";
  const bubbleBg = isUser ? "bg-blue-50 dark:bg-blue-600/10 border-blue-200/50 dark:border-blue-800/20" : "bg-white dark:bg-zinc-800/60 border-zinc-200/50 dark:border-zinc-700/30";
  const displayName = isUser ? "you" : sender;

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
            {time && <span className="text-xs text-zinc-400 dark:text-zinc-600">{time}</span>}
          </div>
        )}

        <div className={`${bubbleBg} border rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-300 break-words leading-relaxed inline-block max-w-full`}>
          {isMarkdown ? <Markdown content={content} /> : <MentionText content={content} />}
        </div>

        {grouped && (
          <span className="text-[10px] text-zinc-400 dark:text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity ml-2" title={fullTime}>
            {time}
          </span>
        )}
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
