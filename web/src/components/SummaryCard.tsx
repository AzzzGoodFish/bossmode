import { useState, useCallback } from "react";
import type { RoomMessage, SummaryMeta } from "../api/client";
import { getMessageRange } from "../api/client";
import { Markdown } from "./Markdown";
import { MessageBubble } from "./MessageBubble";

interface SummaryCardProps {
  message: RoomMessage;
  roomId: string;
}

export function SummaryCard({ message, roomId }: SummaryCardProps) {
  const meta = message.summary_meta as SummaryMeta;
  const [expanded, setExpanded] = useState(false);
  const [originalMessages, setOriginalMessages] = useState<RoomMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  const handleToggle = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!originalMessages) {
      setLoading(true);
      try {
        const msgs = await getMessageRange(roomId, meta.covered_range.from_id, meta.covered_range.to_id);
        setOriginalMessages(msgs);
      } catch (err) {
        console.error("Failed to load original messages:", err);
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, originalMessages, roomId, meta]);

  const dateFrom = new Date(meta.time_range.from).toLocaleDateString();
  const dateTo = new Date(meta.time_range.to).toLocaleDateString();
  const dateRange = dateFrom === dateTo ? dateFrom : `${dateFrom} – ${dateTo}`;

  return (
    <div
      role="article"
      aria-expanded={expanded}
      className="my-2 rounded-lg border border-violet-200 dark:border-violet-900/50 bg-violet-50 dark:bg-violet-950/30 overflow-hidden"
    >
      {/* Accent bar + content */}
      <div className="flex">
        <div className="w-1 bg-violet-400 dark:bg-violet-600 shrink-0" />
        <div className="flex-1 min-w-0 px-3 py-2">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <span className="text-violet-600 dark:text-violet-400 text-sm">📖</span>
            <span className="text-sm font-medium text-violet-900 dark:text-violet-200 truncate">
              {meta.title}
            </span>
            <button
              onClick={handleToggle}
              className="ml-auto text-xs text-violet-500 hover:text-violet-700 dark:hover:text-violet-300 transition-colors cursor-pointer shrink-0"
              aria-label={expanded ? "Collapse original messages" : "Expand original messages"}
            >
              {expanded ? "▼ Collapse" : "▶ Expand"}
            </button>
          </div>

          {/* Summary body */}
          <div className="mt-1 text-sm text-violet-800 dark:text-violet-300">
            <Markdown content={message.content.split("\n").slice(1).join("\n").replace(/^## .+\n/, "")} />
          </div>

          {/* Meta info */}
          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-violet-500 dark:text-violet-500">
            <span>{meta.covered_range.count} messages</span>
            <span>{dateRange}</span>
            <span className="truncate">{meta.participants.join(", ")}</span>
          </div>

          {/* Expanded original messages */}
          {expanded && (
            <div className="mt-2 border-t border-violet-200 dark:border-violet-800 pt-2">
              {loading ? (
                <div className="text-xs text-violet-400 animate-pulse py-2">Loading original messages...</div>
              ) : originalMessages && originalMessages.length > 0 ? (
                <div className="max-h-96 overflow-y-auto space-y-1">
                  {originalMessages.map((msg) => (
                    <MessageBubble
                      key={msg.id}
                      sender={msg.sender}
                      content={msg.content}
                      time={new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      isMarkdown={msg.sender !== "user" && msg.sender !== "system"}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-xs text-violet-400 py-2">No messages found.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
