/**
 * TopicRail (topic switching v3, fish 2026-08-19 pick: direction A + collapsible):
 *
 * Topics become a first-class navigation dimension INSIDE the room — an
 * embedded left rail in the room chat area AND in every topic workspace, so
 * topic⇄topic is a one-click direct switch (no more topic1→room→topic2).
 *
 * - Toggle: the topbar "Topics" button (badge = active count); per-room open
 *   state persisted (default closed — zero footprint until asked).
 * - Closed topics auto-sink into a collapsed "Closed · n" section at the rail
 *   bottom — out of the active zone, still reachable.
 * - Vertical list; rail width draggable 170–320px, persisted.
 *
 * Data rides the merged getChats topics extension (per-topic unread from the
 * topic cursor + anyWorking live flag), polled at the Chats panel's cadence.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Hash, MessagesSquare, ChevronRight } from "lucide-react";
import { getChats, type TopicChatEntry } from "../api/client";

const RAIL_W_KEY = "bossmode_topic_rail_w";
const railOpenKey = (roomId: string) => `bossmode_topic_rail_open:${roomId}`;

/** This room's topics (active-first) + active count, refreshed on the Chats cadence. */
export function useRoomTopics(roomId: string | null) {
  const [topics, setTopics] = useState<TopicChatEntry[]>([]);
  useEffect(() => {
    if (!roomId) { setTopics([]); return; }
    let cancelled = false;
    const load = () =>
      getChats()
        .then((r) => {
          if (cancelled) return;
          const entry = r.chats.find((c) => c.kind === "room" && c.roomId === roomId);
          const list = entry?.topics ?? [];
          setTopics([...list].sort((a, b) => (a.status === b.status ? 0 : a.status === "active" ? -1 : 1)));
        })
        .catch(() => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [roomId]);
  const activeCount = topics.filter((t) => t.status === "active").length;
  return { topics, activeCount };
}

/** Per-room persisted rail open state (default closed — fish: zero footprint until asked). */
export function useTopicRailOpen(roomId: string | null): [boolean, () => void] {
  const [open, setOpen] = useState(() => (roomId ? localStorage.getItem(railOpenKey(roomId)) === "1" : false));
  useEffect(() => {
    setOpen(roomId ? localStorage.getItem(railOpenKey(roomId)) === "1" : false);
  }, [roomId]);
  const toggle = useCallback(() => {
    if (!roomId) return;
    setOpen((v) => {
      const next = !v;
      localStorage.setItem(railOpenKey(roomId), next ? "1" : "0");
      return next;
    });
  }, [roomId]);
  return [open, toggle];
}

/** Topbar toggle button shared by the room view and the topic workspace. */
export function TopicRailToggle({ open, activeCount, onToggle }: { open: boolean; activeCount: number; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={open ? "Hide topic list" : "Show topic list"}
      aria-label={open ? "Hide topic list" : "Show topic list"}
      aria-pressed={open}
      className={`h-[26px] px-1.5 flex items-center gap-1 rounded-md transition-colors cursor-pointer ${open ? "text-accent-ink bg-accent-dim" : "text-ink-3 hover:text-ink-1 hover:bg-surface-2"}`}
    >
      <MessagesSquare size={13} />
      <span className="text-[11px] hidden lg:inline">Topics</span>
      {activeCount > 0 && (
        <span className="min-w-[16px] h-4 px-1 rounded-full bg-accent text-accent-contrast text-[9.5px] font-bold flex items-center justify-center tabular-nums">
          {activeCount}
        </span>
      )}
    </button>
  );
}

export function TopicRail({
  topics,
  currentTopicId,
  onSelectRoom,
  onSelectTopic,
  onClose,
}: {
  /** From the shared useRoomTopics hook (owned by the page so the topbar badge shares one poll). */
  topics: TopicChatEntry[];
  /** null = the room stream itself is the current view. */
  currentTopicId: string | null;
  onSelectRoom: () => void;
  onSelectTopic: (topicId: string) => void;
  /** Drag-to-close (fish 2026-08-19): no min-width floor — dragging the grip all the way left closes the rail; reopen via the topbar Topics button. */
  onClose: () => void;
}) {
  const [closedOpen, setClosedOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => {
    const w = parseInt(localStorage.getItem(RAIL_W_KEY) || "220", 10);
    return Math.min(320, Math.max(170, isNaN(w) ? 220 : w));
  });
  const dragging = useRef(false);
  /** Last width during an active drag — mouseup must not rely on a React re-render having landed. */
  const dragWidth = useRef(0);

  // Drag: visual floor 60px (affordance), release below 170px → close the rail;
  // otherwise snap into 170–320 and persist. No hard min-width — fish ①.
  const onGripDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      if (!dragging.current || !railRef.current) return;
      const left = railRef.current.getBoundingClientRect().left;
      const w = Math.min(320, Math.max(60, ev.clientX - left));
      dragWidth.current = w;
      setWidth(w);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const w = dragWidth.current;
      if (w < 170) { onClose(); return; }
      const clamped = Math.min(320, Math.max(170, w));
      setWidth(clamped);
      localStorage.setItem(RAIL_W_KEY, String(Math.round(clamped)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [onClose]);

  const active = topics.filter((t) => t.status === "active");
  const closed = topics.filter((t) => t.status === "closed");

  return (
    <div ref={railRef} className="relative shrink-0 border-r border-line bg-surface-1 flex flex-col min-h-0" style={{ width }} data-testid="topic-rail">
      <div className="px-2 pt-2">
        <button
          onClick={onSelectRoom}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[12.5px] transition-colors cursor-pointer ${currentTopicId === null ? "bg-surface-2 text-ink-1 font-semibold" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2"}`}
        >
          <Hash size={12} className="text-ink-4 shrink-0" />
          <span className="truncate">Room stream</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 pt-2 pb-1 text-[9.5px] font-bold tracking-[0.08em] uppercase text-ink-4">Topics · {active.length}</div>
        {active.length === 0 && (
          <div className="px-2 py-1.5 text-[11px] text-ink-4 leading-relaxed">
            No active topics. Start one from a message's hover menu or the composer topic mode.
          </div>
        )}
        {active.map((t) => (
          <TopicRow key={t.topicId} t={t} current={currentTopicId === t.topicId} onClick={() => onSelectTopic(t.topicId)} />
        ))}
        {closed.length > 0 && (
          <>
            <button
              onClick={() => setClosedOpen((v) => !v)}
              className="w-full flex items-center gap-1 px-2 pt-2 pb-1 text-[9.5px] font-bold tracking-[0.08em] uppercase text-ink-4 hover:text-ink-2 cursor-pointer"
            >
              <ChevronRight size={10} className={`transition-transform ${closedOpen ? "rotate-90" : ""}`} />
              Closed · {closed.length}
            </button>
            {closedOpen && closed.map((t) => (
              <TopicRow key={t.topicId} t={t} current={currentTopicId === t.topicId} onClick={() => onSelectTopic(t.topicId)} />
            ))}
          </>
        )}
      </div>
      {/* width drag grip — drag all the way left to close the rail (fish ①) */}
      <div onMouseDown={onGripDown} className="absolute top-0 -right-[3px] w-[6px] h-full cursor-col-resize z-10 hover:bg-accent-dim" title="Drag to resize · drag all the way left to close" />
    </div>
  );
}

function TopicRow({ t, current, onClick }: { t: TopicChatEntry; current: boolean; onClick: () => void }) {
  const isClosed = t.status === "closed";
  return (
    <button
      onClick={onClick}
      title={isClosed ? `${t.title} (closed)` : t.title}
      className={`w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-left text-[12.5px] transition-colors cursor-pointer ${
        current ? "bg-accent-dim text-ink-1" : "hover:bg-surface-2"
      } ${isClosed ? "opacity-55" : ""}`}
    >
      <MessagesSquare size={11} className="text-ink-4 shrink-0" />
      <span className={`truncate flex-1 ${isClosed ? "line-through decoration-ink-4 text-ink-4" : current ? "font-semibold text-ink-1" : t.unreadCount > 0 ? "font-semibold text-ink-1" : "text-ink-3"}`}>
        {t.title}
      </span>
      {!isClosed && t.anyWorking && <span className="w-1.5 h-1.5 rounded-full bg-onair animate-pulse shrink-0" title="A member is working in this topic" />}
      {t.mentioned && <span className="shrink-0 w-[15px] h-[15px] rounded-full bg-blocked text-white text-[9px] font-bold flex items-center justify-center">@</span>}
      {t.unreadCount > 0 && <span className="shrink-0 w-[7px] h-[7px] rounded-full bg-accent shrink-0" title={`${t.unreadCount} unread`} />}
    </button>
  );
}
