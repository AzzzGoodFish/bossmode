import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { getMemberActivityEvents, getMemberScopedActivityEvents, getToken } from "../api/client";
import { diffStatForTool, eventSearchText, formatCompactionPreview, formatEventTime, formatToolArgsPreview, isCompactionEvent, isReplyEvent, isToolEvent, summarizeAgentEvent, toolDisplay, toolTarget, type AgentEvent } from "./agent-event-utils";
import { Markdown } from "./Markdown";

const PAGE_SIZE = 120;
const LOAD_MORE_THRESHOLD_PX = 80;
type FilterMode = "all" | "tools" | "replies";

/** Member panel Activity tab: event stream with All/Tools/Replies filter + search.
 *
 * Layout (sticky sub-header / 粘性子表头):
 * - Filter bar + search sit OUTSIDE the scroll container as a fixed sub-header —
 *   always visible regardless of scroll position (fish's 0.18.8 self-test finding:
 *   when infinite scroll lands on newest/bottom, an in-stream filter was off-screen
 *   and got pushed away by load-earlier when you scrolled up to reach it).
 * - Only the event stream scrolls. Infinite scroll-up + scroll anchoring apply to
 *   that stream container alone.
 */
export function ActivityTab({ roomId, agentName, dmScope }: {
  roomId: string;
  agentName: string;
  /** 0.20 flagship ②: when set, activity reads/watches the dm scope — events
   * come from the members-shaped route and the WS subscription targets the
   * synthetic dm:<memberId> room the DM instance emits on. */
  dmScope?: { scopeId: string; memberId: string };
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [beforeSeq, setBeforeSeq] = useState<number | undefined>();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledToLatestRef = useRef(false);
  // Synchronous re-entry guard — React state alone can miss a second scroll
  // event that fires before the next render (QA noted this under synthetic
  // scrollTop assignment; real wheel gestures were fine, but a ref is cheap insurance).
  const loadingOlderRef = useRef(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const result = dmScope
        ? await getMemberScopedActivityEvents(dmScope.memberId, dmScope.scopeId, PAGE_SIZE)
        : await getMemberActivityEvents(roomId, agentName, PAGE_SIZE);
      setEvents(result.events as AgentEvent[]);
      setHasMore(result.hasMore);
      setBeforeSeq(result.nextBeforeSeq ?? undefined);
    } finally {
      setLoading(false);
    }
  }, [roomId, agentName, dmScope?.scopeId, dmScope?.memberId]);

  useEffect(() => { scrolledToLatestRef.current = false; void loadInitial(); }, [loadInitial]);

  // Land on the newest event as soon as the initial page has rendered, once per mount.
  useEffect(() => {
    if (loading || scrolledToLatestRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    scrolledToLatestRef.current = true;
  }, [loading]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}?token=${token}`);
    const watchRoomId = dmScope ? `dm:${dmScope.memberId}` : roomId;
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe:agent", roomId: watchRoomId, agent: agentName }));
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "agent:event" && data.roomId === watchRoomId && data.agent === agentName) {
          setEvents((prev) => [...prev, data.event as AgentEvent]);
        }
      } catch {}
    };
    return () => ws.close();
  }, [roomId, agentName, dmScope?.scopeId, dmScope?.memberId]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || beforeSeq === undefined || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    try {
      const result = dmScope
        ? await getMemberScopedActivityEvents(dmScope.memberId, dmScope.scopeId, PAGE_SIZE, beforeSeq)
        : await getMemberActivityEvents(roomId, agentName, PAGE_SIZE, beforeSeq);
      setEvents((prev) => [...result.events as AgentEvent[], ...prev]);
      setHasMore(result.hasMore);
      setBeforeSeq(result.nextBeforeSeq ?? undefined);
      // Prepending content shifts everything down; restore the pre-load scroll
      // position so the view doesn't jump (scroll anchoring / 滚动锚定).
      requestAnimationFrame(() => {
        if (!el) return;
        el.scrollTop = el.scrollHeight - prevScrollHeight + prevScrollTop;
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasMore, beforeSeq, roomId, agentName, dmScope?.scopeId, dmScope?.memberId]);

  // Infinite scroll: scrolling near the top of the event-stream container
  // auto-loads earlier activity (same pattern as chat apps like Slack/Telegram).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop <= LOAD_MORE_THRESHOLD_PX) void loadOlder();
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [loadOlder]);

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((event) => {
      if (filter === "tools" && !isToolEvent(event) && !isCompactionEvent(event)) return false;
      if (filter === "replies" && !isReplyEvent(event)) return false;
      if (q && !eventSearchText(event).includes(q)) return false;
      return event.type !== "message_update" && event.type !== "tool_update" && event.type !== "message_start";
    });
  }, [events, filter, query]);

  const counts = useMemo(() => ({
    all: events.filter((e) => e.type !== "message_update" && e.type !== "tool_update" && e.type !== "message_start").length,
    tools: events.filter((event) => isToolEvent(event) || isCompactionEvent(event)).length,
    replies: events.filter(isReplyEvent).length,
  }), [events]);

  const turns = useMemo(() => groupTurns(filteredEvents), [filteredEvents]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Sticky sub-header: filter + search stay pinned; never scroll with events. */}
      <div className="shrink-0 px-5 pt-4 pb-2.5 border-b border-line-soft bg-surface-1">
        <div className="flex items-center gap-2.5">
          <div className="flex bg-inset border border-line-soft rounded-lg p-0.5">
            <FilterButton label="All" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterButton label="Tools" count={counts.tools} active={filter === "tools"} onClick={() => setFilter("tools")} />
            <FilterButton label="Replies" count={counts.replies} active={filter === "replies"} onClick={() => setFilter("replies")} />
          </div>
          <div className="flex items-center gap-2 bg-inset border border-line-soft rounded-lg px-2.5 py-1.5 flex-1 min-w-0">
            <Search size={13} className="text-ink-4 shrink-0" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search activity…" className="bg-transparent outline-none text-[11.5px] text-ink-1 placeholder:text-ink-4 flex-1 min-w-0" />
          </div>
        </div>
      </div>

      {/* Event stream — sole scroll container for infinite scroll-up. */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-5 py-4">
        <div className="space-y-[14px] pb-6">
          {hasMore && <button onClick={() => void loadOlder()} disabled={loadingOlder} className="w-full text-xs text-accent-ink py-2 hover:opacity-80 cursor-pointer disabled:opacity-50 disabled:cursor-default">{loadingOlder ? "Loading…" : "Load earlier activity"}</button>}
          {loading && <div className="text-center text-sm text-ink-4 py-8">Loading activity…</div>}
          {!loading && turns.length === 0 && <div className="text-center text-sm text-ink-4 py-8">No matching activity.</div>}
          {turns.map((turn, idx) => <TurnBlock key={idx} index={idx + 1} events={turn.events} query={query} />)}
        </div>
      </div>
    </div>
  );
}

function FilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`px-3 py-1 text-[11.5px] font-semibold rounded-md cursor-pointer ${active ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}>{label} <span className="font-mono text-[9.5px] text-ink-4">{count}</span></button>;
}

function groupTurns(events: AgentEvent[]): Array<{ events: AgentEvent[] }> {
  const turns: Array<{ events: AgentEvent[] }> = [];
  let current: AgentEvent[] = [];
  for (const event of events) {
    if (event.type === "agent_start" && current.length > 0) {
      turns.push({ events: current });
      current = [];
    }
    current.push(event);
    if (event.type === "agent_end") {
      turns.push({ events: current });
      current = [];
    }
  }
  if (current.length > 0) turns.push({ events: current });
  return turns;
}

function TurnBlock({ index, events, query }: { index: number; events: AgentEvent[]; query: string }) {
  const firstTs = events.find((e) => typeof e.ts === "number")?.ts;
  return <section className="space-y-[7px]"><div className="flex items-center gap-2"><span className="text-[10px] font-bold tracking-[0.08em] uppercase text-ink-4">Turn · #{index}</span><span className="font-mono text-[10px] font-normal text-ink-4">{formatEventTime(firstTs)}</span><span className="h-px bg-line-soft flex-1" /></div>{events.map((event, i) => <EventRow key={`${event.ts || i}:${event.type}:${i}`} event={event} query={query} />)}</section>;
}

function EventRow({ event, query }: { event: AgentEvent; query: string }) {
  const summary = summarizeAgentEvent(event);
  const diff = diffStatForTool(event);
  const time = formatEventTime(typeof event.ts === "number" ? event.ts : undefined);
  if (event.type === "tool_end") return null;
  if (event.type === "agent_start" || event.type === "agent_end") return <div className="text-[11px] text-ink-4 px-1 py-0.5">{summary.detail} · {time}</div>;
  if (event.type === "tool_start") {
    const tool = toolDisplay(event.toolName, event.args);
    return <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[9px]"><div className="flex items-center gap-2"><span className="text-[9.5px] font-extrabold tracking-[0.08em] uppercase text-accent-ink">TOOL·{tool.label}</span><span className="font-mono text-[11px] text-ink-3 truncate flex-1">{highlight(tool.detail || toolTarget(event.args), query)}</span>{diff && <span className="font-mono text-[10px] text-ink-4 shrink-0">+{diff.added} −{diff.removed}</span>}<span className="font-mono text-[10px] text-ink-4 shrink-0">{time}</span></div><pre className="mt-2 bg-inset rounded-[7px] px-[9px] py-[7px] text-[10.5px] text-ink-4 max-h-[110px] overflow-y-auto whitespace-pre-wrap break-words">{formatToolArgsPreview(event.args)}</pre></div>;
  }
  if (event.type === "compaction_start" || event.type === "compaction_end") {
    const tone = event.type === "compaction_start" ? "text-accent-ink" : event.errorMessage ? "text-blocked" : "text-onair";
    return <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[9px]"><div className="flex items-center gap-2"><span className={`text-[9.5px] font-extrabold tracking-[0.08em] uppercase ${tone}`}>{summary.label}</span><span className="font-mono text-[11px] text-ink-3 truncate flex-1">{highlight(summary.detail, query)}</span><span className="font-mono text-[10px] text-ink-4 shrink-0">{time}</span></div>{event.type === "compaction_end" && <pre className="mt-2 bg-inset rounded-[7px] px-[9px] py-[7px] text-[10.5px] text-ink-4 max-h-[110px] overflow-y-auto whitespace-pre-wrap break-words">{formatCompactionPreview(event)}</pre>}</div>;
  }
  if (event.type === "message_end" && (event.thinking || event.text)) {
    // Both cards render when a message carries thinking and text (thinking-enabled
    // members must not have their reply silently swallowed).
    return <>
      {event.thinking ? <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[9px] text-xs text-ink-3"><span className="font-extrabold text-think tracking-[0.08em] uppercase text-[9.5px]">THINKING</span><div className="mt-[6px] text-[12.5px] text-ink-2 whitespace-pre-wrap max-h-32 overflow-y-auto">{String(event.thinking)}</div></div> : null}
      {event.text ? <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[9px]"><div className="flex items-center gap-2 mb-1"><span className="font-extrabold text-onair tracking-[0.08em] uppercase text-[9.5px]">REPLY</span><span className="font-mono text-[10px] text-ink-4 ml-auto shrink-0">{time}</span></div><div className="mt-[6px] text-[12.5px] text-ink-2"><Markdown content={String(event.text)} /></div></div> : null}
    </>;
  }
  return <div className="text-[11px] text-ink-4 px-1 py-0.5">{summary.label} {summary.detail} <span className="font-mono text-ink-4">{time}</span></div>;
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return <>{text.slice(0, idx)}<mark className="bg-highlight text-ink-1 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>;
}
