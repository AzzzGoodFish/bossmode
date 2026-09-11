import { useMemberProfileRevision, useCurrentMemberName } from "../hooks/useMemberProfileRevision";
/**
 * ChatsPage — unified conversation list (0.20 landing view).
 *
 * DMs and rooms in one recency-sorted list, like a chat tool: last-message
 * preview, unread count, @-mention highlight. Server computes summaries
 * (GET /api/chats) — no N+1. Click a DM → DmPage; a room → room view.
 */
import { useEffect, useMemo, useState } from "react";
import { Hash } from "lucide-react";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { getChats, type ChatEntry } from "../api/client";

export function ChatsPage({ onOpenDm, onOpenRoom }: {
  onOpenDm: (memberId: string) => void;
  onOpenRoom: (roomId: string) => void;
}) {
  const profileRevision = useMemberProfileRevision();
  const [chats, setChats] = useState<ChatEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getChats()
        .then((res) => { if (!cancelled) { setChats(res.chats); setError(null); } })
        .catch((err) => { if (!cancelled) setError(String(err?.message || err)); });
    };
    load();
    const t = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [profileRevision]);

  const sorted = useMemo(() => {
    return [...(chats ?? [])].sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0));
  }, [chats]);

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full px-6 md:px-10 pt-7 pb-16">
        <div className="mb-5">
          <h1 className="text-[19px] font-bold tracking-tight text-ink-1">Chats</h1>
          <p className="text-[12.5px] text-ink-3 mt-1">Every conversation — DMs and rooms, most recent first.</p>
        </div>

        {error ? (
          <div role="alert" className="rounded-xl border border-blocked/30 bg-blocked-dim/25 px-4 py-3 text-xs text-blocked">
            Couldn’t load chats. {error}
          </div>
        ) : !chats ? (
          <div className="py-14 text-center text-sm text-ink-3">Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="rounded-xl border border-line bg-inset/50 py-14 text-center">
            <div className="text-sm font-medium text-ink-2 mb-1">No conversations yet</div>
            <div className="text-xs text-ink-3">Open a DM from the chat list, or create a room.</div>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-inset/50 overflow-hidden">
            {sorted.map((c, i) => (
              <ChatRow key={c.scopeId} chat={c} last={i === sorted.length - 1}
                onOpen={() => c.kind === "dm" && c.memberId ? onOpenDm(c.memberId) : c.roomId ? onOpenRoom(c.roomId) : undefined} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatRow({ chat: c, last, onOpen }: { chat: ChatEntry; last: boolean; onOpen: () => void }) {
  const working = c.status === "working";
  const sender = useCurrentMemberName(c.lastMessage?.senderMemberId, c.lastMessage?.sender ?? "");
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full flex items-center gap-3.5 px-4 py-3 text-left transition-colors cursor-pointer ${
        c.mentioned ? "bg-highlight/40 hover:bg-highlight/60" : "bg-surface-1 hover:bg-surface-2"
      } ${last ? "" : "border-b border-line-soft"}`}
    >
      {c.kind === "dm" ? (
        <StaffBadge name={c.title} status={statusFromAgent(c.status ?? "idle")} size="md" />
      ) : (
        <div className="w-8 h-8 rounded-lg bg-accent-dim text-accent-ink flex items-center justify-center shrink-0">
          <Hash size={15} />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`text-[13.5px] truncate ${c.unreadCount > 0 ? "font-bold text-ink-1" : "font-medium text-ink-1"}`}>
            {c.title}
          </span>
          {c.kind === "room" && <span className="text-[10px] text-ink-4 uppercase tracking-wide shrink-0">room</span>}
          <span className="ml-auto text-[11px] text-ink-4 shrink-0 tabular-nums">
            {c.lastMessage ? formatRelative(c.lastMessage.ts) : ""}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[12px] truncate ${c.unreadCount > 0 ? "text-ink-1 font-medium" : "text-ink-3"}`}>
            {c.lastMessage ? previewText(sender, c.lastMessage.text) : "No messages yet"}
          </span>
          {working && <span className="text-[10.5px] text-onair font-medium shrink-0">● working</span>}
          {c.mentioned && (
            <span className="shrink-0 text-[10px] font-bold text-accent-ink bg-accent-dim rounded-full px-1.5 py-px">@ you</span>
          )}
          {c.unreadCount > 0 && (
            <span className="ml-auto shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-accent-contrast text-[11px] font-bold flex items-center justify-center tabular-nums">
              {c.unreadCount > 99 ? "99+" : c.unreadCount}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function previewText(sender: string, text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > 90 ? flat.slice(0, 90) + "…" : flat;
  return sender === "user" ? `you: ${cut}` : `${sender}: ${cut}`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString([], { month: "numeric", day: "numeric" });
}
