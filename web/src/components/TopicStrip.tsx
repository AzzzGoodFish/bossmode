/**
 * TopicStrip (topic-threads v3, fish 2026-08-19): the room's topic list lives
 * at the TOP of the room chat area — a horizontally scrollable chip row right
 * under the room header (same zone as search), replacing the v2 sidebar
 * sub-list. Click a chip to enter the topic workspace.
 *
 * Data rides the merged getChats topics extension (per-topic unread from the
 * topic cursor + anyWorking live flag), polled at the Chats panel's cadence.
 */
import { useEffect, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { getChats, type TopicChatEntry } from "../api/client";

export function TopicStrip({ roomId, onOpenTopic }: { roomId: string; onOpenTopic: (topicId: string) => void }) {
  const [topics, setTopics] = useState<TopicChatEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getChats()
        .then((r) => {
          if (cancelled) return;
          const entry = r.chats.find((c) => c.kind === "room" && c.roomId === roomId);
          setTopics(entry?.topics ?? []);
        })
        .catch(() => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [roomId]);

  if (topics.length === 0) return null;

  const sorted = [...topics].sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1));

  return (
    <div className="shrink-0 border-b border-line-soft bg-surface-1 px-3 py-1.5" data-testid="topic-strip">
      <div className="flex items-center gap-1.5 overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
        <MessagesSquare size={12} className="text-ink-4 shrink-0" />
        {sorted.map((t) => (
          <button
            key={t.topicId}
            onClick={() => onOpenTopic(t.topicId)}
            title={t.status === "closed" ? `${t.title} (closed)` : t.title}
            className={`flex items-center gap-1.5 shrink-0 max-w-[220px] rounded-full border px-2.5 py-1 text-[11.5px] transition-colors cursor-pointer ${
              t.status === "closed"
                ? "border-line-soft text-ink-4 opacity-60 hover:opacity-90"
                : "border-line text-ink-2 hover:border-line-strong hover:text-ink-1 bg-surface-1"
            }`}
          >
            <span className={`truncate ${t.status === "closed" ? "line-through decoration-ink-4" : t.unreadCount > 0 ? "font-semibold" : ""}`}>{t.title}</span>
            {t.status === "active" && t.anyWorking && <span className="w-1.5 h-1.5 rounded-full bg-onair animate-pulse shrink-0" title="A member is working in this topic" />}
            {t.mentioned && <span className="shrink-0 w-[14px] h-[14px] rounded-full bg-blocked text-white text-[9px] font-bold flex items-center justify-center">@</span>}
            {t.unreadCount > 0 && <span className="shrink-0 w-[6px] h-[6px] rounded-full bg-accent" title={`${t.unreadCount} unread`} />}
          </button>
        ))}
      </div>
    </div>
  );
}
