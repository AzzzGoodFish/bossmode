import { webSocketUrl } from "../utils/websocket-url";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brain, ChevronRight, MessageSquareText, Search, User } from "lucide-react";import { getMemberActivityEvents, getMemberScopedActivityEvents, getToken } from "../api/client";
import { diffStatForTool, eventSearchText, formatCompactionPreview, formatEventTime, formatToolArgsFull, getSanitizedArgs, isActivityStreamEvent, isCompactionEvent, isReplyEvent, isToolEvent, summarizeAgentEvent, toolDisplay, toolTarget, type AgentEvent } from "./agent-event-utils";
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
export function ActivityTab({ roomId, agentName, memberId, dmScope }: {
  roomId: string;
  agentName: string;
  memberId?: string;
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

  const isAllStreamEvent = isActivityStreamEvent;
  // Synchronous re-entry guard — React state alone can miss a second scroll
  // event that fires before the next render (QA noted this under synthetic
  // scrollTop assignment; real wheel gestures were fine, but a ref is cheap insurance).
  const loadingOlderRef = useRef(false);

  const scoped = dmScope;
  const historyScopeId = scoped?.scopeId;
  const historyMemberRef = scoped?.memberId || memberId || agentName;

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const result = historyScopeId
        ? await getMemberScopedActivityEvents(historyMemberRef, historyScopeId, PAGE_SIZE)
        : await getMemberActivityEvents(roomId, historyMemberRef, PAGE_SIZE);
      setEvents(result.events as AgentEvent[]);
      setHasMore(result.hasMore);
      setBeforeSeq(result.nextBeforeSeq ?? undefined);
    } finally {
      setLoading(false);
    }
  }, [roomId, historyScopeId, historyMemberRef]);

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
    const ws = new WebSocket(webSocketUrl(token));
    const watchRoomId = dmScope ? `dm:${dmScope.memberId}` : roomId;
    const watchMemberId = dmScope?.memberId || memberId;
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe:agent", roomId: watchRoomId, agent: historyMemberRef, memberId: watchMemberId }));
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "agent:event" && data.roomId === watchRoomId && (watchMemberId && data.memberId ? data.memberId === watchMemberId : data.agent === historyMemberRef)) {
          setEvents((prev) => [...prev, data.event as AgentEvent]);
        }
      } catch {}
    };
    return () => ws.close();
  }, [roomId, historyScopeId, historyMemberRef]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || beforeSeq === undefined || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    try {
      const result = historyScopeId
        ? await getMemberScopedActivityEvents(historyMemberRef, historyScopeId, PAGE_SIZE, beforeSeq)
        : await getMemberActivityEvents(roomId, historyMemberRef, PAGE_SIZE, beforeSeq);
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
  }, [hasMore, beforeSeq, roomId, historyScopeId, historyMemberRef]);

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
      return isAllStreamEvent(event);
    });
  }, [events, filter, query]);

  const counts = useMemo(() => ({
    all: events.filter(isAllStreamEvent).length,
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
          <div className="flex items-center gap-1.5 bg-inset border border-line-soft rounded-lg px-2.5 py-1.5 flex-1 min-w-0">
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
          {turns.map((turn, idx) => <TurnBlock key={idx} events={turn.events} query={query} />)}
        </div>
      </div>
    </div>
  );
}

function FilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`px-3 py-1 text-[11.5px] font-semibold rounded-md cursor-pointer ${active ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}>{label} <span className="font-mono text-[9.5px] text-ink-4">{count}</span></button>;
}

/** River-card identity mark (fish 2026-08-21 ①): plain 16px initial disc, no
 * status ring — the card carries its own state mark, the ring would lie. */
export function MemberDisc({ name }: { name: string }) {
  return (
    <span className="w-4 h-4 rounded-full bg-surface-3 border border-line flex items-center justify-center text-[8.5px] font-bold text-ink-2 shrink-0 select-none" aria-hidden>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** Optional member identity prefix for card headers (workstations river passes
 * `member`; the single-member Activity tab omits it and keeps its old face). */
function MemberHead({ member }: { member?: string }) {
  if (!member) return null;
  // Identity cluster unit (fish 2026-08-21 v3): disc+name hug at 5px so the
  // header reads as [identity] [tag] [preview] — not loose items at one gap.
  return (
    <span className="flex items-center gap-[5px] shrink-0 min-w-0">
      <MemberDisc name={member} />
      <span className="text-[11px] font-bold leading-none text-ink-1 truncate max-w-[80px] shrink-0" title={member}>{member}</span>
    </span>
  );
}

/**
 * W2-1 (beautifului Thinking, fish-picked 2026-08-20): collapsible thinking trace.
 * Collapsed = one line "Thought for N seconds" (elapsed = gap to the next event
 * ts — an honest estimate, not a model-reported duration); click to expand the
 * full text. Default collapsed so consecutive blocks stop eating the stream.
 */
export function ThinkingTrace({ text, elapsedSec, time, member }: { text: string; elapsedSec?: number; time: string; member?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-[10px] border border-line-soft bg-surface-1">
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center px-3 py-[8px] text-left cursor-pointer">
        <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform mr-[4px] ${expanded ? "rotate-90" : ""}`} />
        <MemberHead member={member} />
        <Brain size={10} className="text-think shrink-0 ml-[7px] mr-[4px]" aria-hidden />
        {/* Uniform tag typography with REPLY/TOOL·X (fish 2026-08-21: mixed
         * title sizes made the river ragged). "THINKING" is live-only
         * vocabulary — a settled trace with no honest duration says "THOUGHT". */}
        <span className="font-extrabold leading-none text-think tracking-[0.08em] uppercase text-[9.5px] whitespace-nowrap">
          {elapsedSec !== undefined && elapsedSec > 0 ? `Thought for ${elapsedSec}s` : "Thought"}
        </span>
        <span className="font-mono text-[10px] leading-none text-ink-4 ml-auto pl-[6px] shrink-0 whitespace-nowrap">{time}</span>
      </button>
      {expanded && (
        <div className="border-t border-line-soft px-3 py-2.5 text-[12.5px] text-ink-3 italic whitespace-pre-wrap max-h-32 overflow-y-auto">{text}</div>
      )}
    </div>
  );
}

export function groupTurns(events: AgentEvent[]): Array<{ events: AgentEvent[] }> {
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

/** fish 2026-09-03: no turn chrome — cards flow continuously, a wider gap
 * still marks where one turn hands off to the next. */
function TurnBlock({ events, query }: { events: AgentEvent[]; query: string }) {
  return (
    <section className="space-y-[7px]">
      <TurnEventList events={events} query={query} />
    </section>
  );
}

/** One turn's event body — thinking traces, tool groups/cards, reply/prompt
 * cards. Shared by the member Activity tab (Turn · #N header) and the room
 * workstations feed (member header), so both render the identical card language. */
export function TurnEventList({ events, query }: { events: AgentEvent[]; query: string }) {
  // Build a toolCallId → tool_end map so tool_start rows can show their result.
  const toolEndMap = useMemo(() => {
    const m: Record<string, AgentEvent> = {};
    for (const e of events) {
      if (e.type === "tool_end" && e.toolCallId) m[e.toolCallId] = e;
    }
    return m;
  }, [events]);
  // Orphan tool_end events (no matching tool_start) pass through the filter
  // and render as standalone cards via EventRow.
  const visible = events.filter(e => e.type !== "tool_end" || !e.toolCallId || !events.some(s => s.type === "tool_start" && s.toolCallId === e.toolCallId));

  // W2-1 (beautifului Thinking): thinking duration = gap to the next event ts (estimate, honest).
  const thinkingElapsed = new Map<AgentEvent, number>();
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    if (e.type === "message_end" && e.thinking && typeof e.ts === "number") {
      const next = visible.slice(i + 1).find((n) => typeof n.ts === "number");
      if (next) thinkingElapsed.set(e, Math.max(0, Math.round(((next.ts as number) - e.ts) / 1000)));
    }
  }

  // W2-2 (beautifului Tool Chips): consecutive tool_start rows form a collapsible group.
  type RenderItem = { kind: "row"; event: AgentEvent } | { kind: "group"; events: AgentEvent[] };
  const items: RenderItem[] = [];
  let toolRun: AgentEvent[] = [];
  const flushTools = () => {
    if (toolRun.length >= 2) items.push({ kind: "group", events: toolRun });
    else toolRun.forEach((e) => items.push({ kind: "row", event: e }));
    toolRun = [];
  };
  for (const e of visible) {
    if (e.type === "tool_start") { toolRun.push(e); continue; }
    flushTools();
    items.push({ kind: "row", event: e });
  }
  flushTools();

  return (
    <>
      {items.map((item, i) =>
        item.kind === "group" ? (
          <ToolGroupBlock key={`g${i}`} events={item.events} toolEndMap={toolEndMap} query={query} />
        ) : (
          <EventRow key={`${item.event.ts || i}:${item.event.type}:${i}`} event={item.event} toolEnd={item.event.type === "tool_start" && item.event.toolCallId ? toolEndMap[item.event.toolCallId] : undefined} elapsedSec={thinkingElapsed.get(item.event)} query={query} />
        ),
      )}
    </>
  );
}

/**
 * W2-2: one turn's consecutive tool calls collapse into a single group row
 * ("N tool calls · M edits · status"). Body keeps the existing full ToolCards
 * untouched; a file-level diff-chip summary aggregates edit/write stats.
 * Default: collapsed when every call finished, expanded while any is running.
 */
export function ToolGroupBlock({ events, toolEndMap, query, member, compact }: { events: AgentEvent[]; toolEndMap: Record<string, AgentEvent>; query: string; member?: string; compact?: boolean }) {
  const ends = events.map((e) => (e.toolCallId ? toolEndMap[e.toolCallId] : undefined));
  const running = ends.filter((e) => !e).length;
  const failed = ends.filter((e) => e?.isError).length;
  const [expanded, setExpanded] = useState(running > 0);
  useEffect(() => { if (running > 0) setExpanded(true); }, [running > 0]);

  const edits = events.filter((e) => {
    const n = String(e.toolName || "").toLowerCase();
    return n.includes("edit") || n.includes("write");
  }).length;
  // Aggregate diff stats per target file (chips: path +added −removed).
  const fileDiffs = new Map<string, { added: number; removed: number }>();
  for (const e of events) {
    const d = diffStatForTool(e);
    if (!d) continue;
    const target = toolTarget(e.args) || "file";
    const cur = fileDiffs.get(target) ?? { added: 0, removed: 0 };
    cur.added += d.added;
    cur.removed += d.removed;
    fileDiffs.set(target, cur);
  }
  const time = formatEventTime(typeof events[events.length - 1]?.ts === "number" ? events[events.length - 1].ts : undefined);
  const status = running > 0 ? <span className="text-think whitespace-nowrap flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-think animate-pulse" />{running} running</span> : failed > 0 ? <span className="text-blocked whitespace-nowrap">✗ {failed} failed</span> : <span className="text-onair whitespace-nowrap">✓ all done</span>;

  return (
    <div className="rounded-[10px] border border-line-soft bg-surface-1">
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center px-3 py-[8px] text-left cursor-pointer">
        <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform mr-[4px] ${expanded ? "rotate-90" : ""}`} />
        <MemberHead member={member} />
        <span className="text-[12px] font-semibold leading-none text-ink-2 truncate min-w-0 ml-[7px]">{events.length} tool calls{edits > 0 ? ` · ${edits} edit${edits > 1 ? "s" : ""}` : ""}</span>
        <span className="ml-auto flex items-center gap-[6px] text-[10px] font-bold shrink-0 whitespace-nowrap">{status}</span>
        <span className="font-mono text-[10px] leading-none text-ink-4 ml-[6px] shrink-0 whitespace-nowrap">{time}</span>
      </button>
      {expanded && (
        <div className="border-t border-line-soft px-2.5 py-2 space-y-[6px]">
          {fileDiffs.size > 0 && (
            <div className="flex flex-wrap gap-1.5 px-1 pb-0.5">
              {[...fileDiffs.entries()].map(([file, d]) => (
                <span key={file} className="font-mono text-[10px] bg-surface-2 border border-line-soft rounded-md px-1.5 py-0.5 text-ink-3">
                  {file.split("/").pop()} <span className="text-onair">+{d.added}</span> <span className="text-blocked">−{d.removed}</span>
                </span>
              ))}
            </div>
          )}
          {events.map((e, i) => (
            <ToolCard key={`${e.ts || i}:${i}`} event={e} toolEnd={e.toolCallId ? toolEndMap[e.toolCallId] : undefined} diff={diffStatForTool(e)} time={formatEventTime(typeof e.ts === "number" ? e.ts : undefined)} query={query} compact={compact} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ event, toolEnd, elapsedSec, query }: { event: AgentEvent; toolEnd?: AgentEvent; elapsedSec?: number; query: string }) {
  const summary = summarizeAgentEvent(event);
  const diff = diffStatForTool(event);
  const time = formatEventTime(typeof event.ts === "number" ? event.ts : undefined);
  if (event.type === "user_prompt") return <UserPromptCard event={event} time={time} query={query} label="USER PROMPT" />;
  if (event.type === "user_steer") return <UserPromptCard event={event} time={time} query={query} label="STEER" />;
  if (event.type === "tool_end") return <ToolCard event={event} toolEnd={event} diff={diff} time={time} query={query} />;
  if (event.type === "agent_start" || event.type === "agent_end") return null; // fish 2026-09-03: turn chrome rows removed
  if (event.type === "tool_start") {
    return <ToolCard event={event} toolEnd={toolEnd} diff={diff} time={time} query={query} />;
  }
  if (event.type === "compaction_start" || event.type === "compaction_end") {
    return <CompactionCard event={event} time={time} query={query} />;
  }
  if (event.type === "message_end" && (event.thinking || event.text)) {
    // Both cards render when a message carries thinking and text (thinking-enabled
    // members must not have their reply silently swallowed).
    // W2-1 (beautifului Thinking): thinking collapses into a one-line trace
    // ("Thought for N seconds"), expanded on demand — consecutive blocks no
    // longer eat the stream. Identity per activity-card-identity-v1 kept.
    return <>
      {event.thinking ? <ThinkingTrace text={String(event.thinking)} elapsedSec={elapsedSec} time={time} /> : null}
      {event.text ? <ReplyCard text={String(event.text)} time={time} query={query} /> : null}
    </>;
  }
  return <div className="text-[11px] text-ink-4 px-1 py-0.5">{summary.label} {summary.detail} <span className="font-mono text-ink-4">{time}</span></div>;
}

/** REPLY card — extracted from EventRow so the workstations river renders the
 * identical card language with a member tag (fish 2026-08-21 ①). `clamp` caps
 * long replies at ~4 lines with a Show-more toggle (river passes it). */
/** REPLY card. Tab face (default): header + markdown body. River face
 * (`clamp`, fish 2026-08-21 ③): uniform one-line anatomy — header carries a
 * truncated plain-text preview; face click expands the full markdown. */
export function ReplyCard({ text, time, query = "", member, clamp }: { text: string; time: string; query?: string; member?: string; clamp?: boolean }) {
  // Uniform chevron slot + uniform collapsed height (fish 2026-08-21 v3 ④):
  // EVERY river card starts collapsed at 34px — a short reply's full text
  // already fits the one-line preview, so opening buys nothing by default.
  const [open, setOpen] = useState(false);
  const preview = text.replace(/\s+/g, " ").trim();
  return (
    <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[8px]">
      <button type="button" onClick={() => clamp && setOpen((v) => !v)} className={`block w-full text-left ${clamp ? "cursor-pointer" : "cursor-default"}`}>
        <div className="flex items-center">
          {clamp && <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform mr-[4px] ${open ? "rotate-90" : ""}`} />}
          <MemberHead member={member} />
          <MessageSquareText size={10} className="text-onair shrink-0 ml-[7px] mr-[4px]" aria-hidden />
          <span className="font-extrabold leading-none text-onair tracking-[0.08em] uppercase text-[9.5px] shrink-0 mr-[7px]">REPLY</span>
          {clamp && !open && <span className="text-[11.5px] leading-none text-ink-3 truncate flex-1 min-w-0">{preview}</span>}
          <span className="font-mono text-[10px] leading-none text-ink-4 ml-auto pl-[6px] shrink-0 whitespace-nowrap">{time}</span>
        </div>
      </button>
      {(!clamp || open) && <div className="mt-[6px] text-[12.5px] text-ink-2"><Markdown content={text} /></div>}
    </div>
  );
}

/** Compaction card — extracted from EventRow for river reuse (member tag). */
export function CompactionCard({ event, time, query = "", member }: { event: AgentEvent; time: string; query?: string; member?: string }) {
  const summary = summarizeAgentEvent(event);
  const [open, setOpen] = useState(false);
  const tone = event.type === "compaction_start" ? "text-accent-ink" : event.errorMessage ? "text-blocked" : "text-onair";
  return (
    <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[8px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="block w-full text-left cursor-pointer">
        <div className="flex items-center">
          <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform mr-[4px] ${open ? "rotate-90" : ""}`} />
          <MemberHead member={member} />
          <span className={`text-[9.5px] font-extrabold leading-none tracking-[0.08em] uppercase whitespace-nowrap ml-[7px] mr-[7px] ${tone}`}>{summary.label}</span>
          <span className="font-mono text-[11px] leading-none text-ink-3 truncate flex-1 min-w-0 mr-[6px]">{highlight(summary.detail, query)}</span>
          <span className="font-mono text-[10px] leading-none text-ink-4 shrink-0 whitespace-nowrap">{time}</span>
        </div>
      </button>
      {open && <pre className="mt-2 bg-inset rounded-[7px] px-[9px] py-[7px] text-[10.5px] text-ink-4 max-h-[110px] overflow-y-auto whitespace-pre-wrap break-words">{formatCompactionPreview(event)}</pre>}
    </div>
  );
}

const MAX_RESULT_RENDER = 50_000;
const ARGS_CLAMP_LINES = 12;
const PROMPT_CLAMP_LINES = 4;

export function UserPromptCard({
  event,
  time,
  query,
  label = "USER PROMPT",
  member,
  compact,
}: {
  event: AgentEvent;
  time: string;
  query: string;
  /** USER PROMPT (turn start) or STEER (mid-turn inject) — same teal family card. */
  label?: string;
  member?: string;
  /** River face (fish 2026-08-21 ③): one-line anatomy — header carries a
   * truncated plain-text preview; face click expands the full prompt. */
  compact?: boolean;
}) {
  const text = String(event.text || "");
  // Uniform collapsed height (fish v3 ④): every river card starts collapsed —
  // a short prompt's full text already fits the one-line preview.
  const [expanded, setExpanded] = useState(false);
  const lines = text.split("\n");
  const clamped = lines.length > PROMPT_CLAMP_LINES && !expanded;
  const body = clamped ? lines.slice(0, PROMPT_CLAMP_LINES).join("\n") : text;
  const preview = text.replace(/\s+/g, " ").trim();
  const from = typeof (event as { from?: unknown }).from === "string"
    ? String((event as { from?: string }).from).trim()
    : "";
  if (compact) {
    return (
      <div className="rounded-[10px] border border-accent/30 bg-accent-dim/20 px-3 py-[8px]">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="block w-full text-left cursor-pointer">
          <div className="flex items-center">
            <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform mr-[4px] ${expanded ? "rotate-90" : ""}`} />
            <MemberHead member={member} />
            <User size={10} className="text-accent-ink shrink-0 ml-[7px] mr-[4px]" aria-hidden />
            <span className="font-extrabold leading-none text-accent-ink tracking-[0.08em] uppercase text-[9.5px] shrink-0">{label}</span>
            {from ? <span className="text-[10px] leading-none text-ink-4 shrink-0 ml-[4px]">· {from}</span> : null}
            {/* The 7px tag→preview gap rides the preview (fish 2026-08-21: the
             * tag's own margin only existed on the usually-absent "from" span,
             * so plain prompts rendered STEER[text] glued together). */}
            {!expanded && <span className="text-[11.5px] leading-none text-ink-2 truncate flex-1 min-w-0 ml-[7px]">{preview}</span>}
            <span className="font-mono text-[10px] leading-none text-ink-4 ml-auto pl-[6px] shrink-0 whitespace-nowrap">{time}</span>
          </div>
        </button>
        {expanded && <div className="mt-[6px] text-[12.5px] text-ink-2 whitespace-pre-wrap break-words">{highlight(text, query)}</div>}
      </div>
    );
  }
  return (
    <div className="rounded-[10px] border border-accent/30 bg-accent-dim/20 px-3 py-[9px]">
      <div className="flex items-center mb-1">
        <MemberHead member={member} />
        <User size={10} className="text-accent-ink shrink-0 ml-[7px] mr-[4px]" aria-hidden />
        <span className="font-extrabold leading-none text-accent-ink tracking-[0.08em] uppercase text-[9.5px]">{label}</span>
        {from ? <span className="text-[10px] leading-none text-ink-4 ml-[4px]">· {from}</span> : null}
        <span className="font-mono text-[10px] leading-none text-ink-4 ml-auto pl-[6px] shrink-0">{time}</span>
      </div>
      <div className="text-[12.5px] text-ink-2 whitespace-pre-wrap break-words">{highlight(body, query)}</div>
      {lines.length > PROMPT_CLAMP_LINES && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-[11px] font-semibold text-accent-ink hover:underline cursor-pointer"
        >
          {expanded ? "Show less ↑" : `Show more (${lines.length} lines) ↓`}
        </button>
      )}
    </div>
  );
}

function countLines(text: string): number {
  return text ? text.split("\n").length : 0;
}

function ArgsPanel({ args }: { args: unknown }) {
  const [view, setView] = useState<"structured" | "json">("structured");
  const [showAll, setShowAll] = useState(false);
  const sanitized = getSanitizedArgs(args);
  const jsonText = formatToolArgsFull(args);
  const truncated = jsonText.length > MAX_RESULT_RENDER;
  const displayJson = truncated ? jsonText.slice(0, MAX_RESULT_RENDER) : jsonText;
  const lineCount = countLines(jsonText);
  const charLabel = jsonText.length >= 1000 ? `${(jsonText.length / 1000).toFixed(1)}k chars` : `${jsonText.length} chars`;

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <div className="text-[9px] font-bold uppercase tracking-wider text-ink-4">
          Arguments{lineCount > 1 ? <span className="font-mono font-normal normal-case tracking-normal text-ink-4"> · {lineCount} lines · {charLabel}</span> : null}
        </div>
        <div className="flex gap-0.5 rounded-md border border-line-soft bg-surface-1 p-0.5 ml-auto">
          <button type="button" onClick={() => setView("structured")} className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${view === "structured" ? "bg-surface-3 text-ink-1" : "text-ink-4"}`}>Structured</button>
          <button type="button" onClick={() => setView("json")} className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${view === "json" ? "bg-surface-3 text-ink-1" : "text-ink-4"}`}>JSON</button>
        </div>
      </div>
      <div className="relative rounded-[7px] border border-line-soft bg-surface-1 overflow-hidden" style={{ borderLeft: "2px solid var(--accent, #2fb8aa)" }}>
        {view === "json" ? (
          <pre className={`px-[9px] py-[7px] text-[10.5px] text-ink-2 whitespace-pre-wrap break-words overflow-y-auto ${showAll ? "max-h-[320px]" : "max-h-[${ARGS_CLAMP_LINES * 1.4}em]"}`} style={showAll ? { maxHeight: 320 } : { maxHeight: ARGS_CLAMP_LINES * 16 }}>{displayJson}</pre>
        ) : (
          <div className="px-[9px] py-[7px] overflow-y-auto" style={showAll ? { maxHeight: 320 } : { maxHeight: ARGS_CLAMP_LINES * 16 }}>
            <StructuredArgs value={sanitized} depth={0} />
          </div>
        )}
        {!showAll && lineCount > ARGS_CLAMP_LINES && (
          <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-surface-1 to-transparent pointer-events-none" />
        )}
      </div>
      {lineCount > ARGS_CLAMP_LINES && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 text-[11px] font-semibold text-accent-ink hover:underline cursor-pointer">
          {showAll ? "Collapse ↑" : `Show all ${lineCount} lines ↓`}
        </button>
      )}
      {truncated && view === "json" && <div className="mt-1 text-[10px] text-ink-4">Showing first {(MAX_RESULT_RENDER / 1000).toFixed(0)}k chars · full content in event log.</div>}
    </div>
  );
}

function StructuredArgs({ value, depth }: { value: unknown; depth: number }) {
  if (value == null) return <span className="text-ink-4 italic text-[11px]">null</span>;
  if (typeof value === "boolean") return <span className="text-[11px] font-mono" style={{ color: "#a78bfa" }}>{String(value)}</span>;
  if (typeof value === "number") return <span className="text-[11px] font-mono text-think">{value}</span>;
  if (typeof value === "string") {
    const lines = value.split("\n");
    if (lines.length <= 1 && value.length < 80) {
      return <span className="text-[11px] text-onair font-mono break-all">"{value}"</span>;
    }
    return (
      <pre className="mt-0.5 text-[11px] text-ink-2 whitespace-pre-wrap break-words bg-inset/60 rounded px-2 py-1.5 border border-line-soft/60">{value}</pre>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-4 text-[11px]">[]</span>;
    return (
      <div className="space-y-1" style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
        {value.map((item, i) => (
          <div key={i} className="flex gap-1.5 items-start">
            <span className="text-[10px] font-mono text-ink-4 shrink-0 pt-0.5">[{i}]</span>
            <div className="min-w-0 flex-1"><StructuredArgs value={item} depth={depth + 1} /></div>
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-ink-4 text-[11px]">{"{}"}</span>;
    return (
      <div className="space-y-1" style={{ paddingLeft: depth > 0 ? 12 : 0 }}>
        {entries.map(([key, item]) => {
          const isScalar = item == null || typeof item === "string" || typeof item === "number" || typeof item === "boolean";
          const shortScalar = isScalar && (item == null || typeof item !== "string" || (item.length < 80 && !item.includes("\n")));
          return (
            <div key={key} className={shortScalar ? "flex gap-2 items-baseline" : ""}>
              <span className="text-[11px] font-mono text-accent-ink shrink-0">{key}</span>
              {shortScalar ? (
                <>
                  <span className="text-ink-4 text-[10px]">:</span>
                  <StructuredArgs value={item} depth={depth + 1} />
                </>
              ) : (
                <div className="mt-0.5"><StructuredArgs value={item} depth={depth + 1} /></div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return <span className="text-[11px] text-ink-2">{String(value)}</span>;
}

function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    // Tool results are { content: [{ type: "text", text }] } or plain objects.
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const texts = (r.content as Array<Record<string, unknown>>).map((c) => String(c.text || "")).filter(Boolean);
      if (texts.length) return texts.join("\n");
    }
    if (r.message && typeof r.message === "string") return r.message;
    if (r.error && typeof r.error === "string") return r.error;
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

function isMarkdownResult(toolName: string | undefined, text: string): boolean {
  if (!toolName) return false;
  const mdTools = ["read", "read_memory", "read_file", "query_room_messages"];
  if (mdTools.includes(toolName)) return true;
  // Heuristic: starts with markdown-ish content.
  return /^(#|\*\*|\d+\.|- |```|\|)/m.test(text.slice(0, 200));
}

export function ToolCard({ event, toolEnd, diff, time, query, member, compact }: { event: AgentEvent; toolEnd?: AgentEvent; diff: ReturnType<typeof diffStatForTool>; time: string; query: string; member?: string; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<"raw" | "preview">("raw");
  const tool = toolDisplay(event.toolName, event.args);
  const isError = toolEnd?.isError;
  const isRunning = !toolEnd && event.type === "tool_start";

  const resultText = toolEnd ? resultToText(toolEnd.result) : "";
  const resultSize = resultText.length;
  const truncated = resultSize > MAX_RESULT_RENDER;
  const displayText = truncated ? resultText.slice(0, MAX_RESULT_RENDER) : resultText;
  const canPreview = !isError && isMarkdownResult(event.toolName, resultText);
  const summaryText = resultText.slice(0, 120).replace(/\n/g, " ").trim();

  // Failed cards carry their state on the card face alone (fish 2026-08-26:
  // remove the Failed chip + ✗ mark — the red left edge already says it).
  const cardBorder = isError ? "border-blocked/40 border-l-2 border-l-blocked" : isRunning ? "border-think/40" : "border-line-soft";
  // Live dot is a real CSS circle (fish: ● glyph rides the baseline and reads
  // off-center against the small caps tags).
  const statusMark = isRunning
    ? <span className="w-1.5 h-1.5 rounded-full bg-think animate-pulse shrink-0" title="running" />
    : isError
      ? null
      : toolEnd
        ? <span className="text-onair text-[10px] font-bold leading-none shrink-0" title="done">✓</span>
        : null;

  return (
    <div className={`rounded-[10px] border ${cardBorder} bg-surface-1 px-3 py-[8px]`}>
      {/* Expandable in every state (fish 2026-08-21: a running tool must show
       * its args — don't gate inspection on completion). Running cards show
       * args + a live "running" placeholder in the result area. */}
      <button onClick={() => setExpanded(v => !v)} className="block w-full text-left cursor-pointer">
        <div className="flex items-center">
          <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform mr-[4px] ${expanded ? "rotate-90" : ""}`} />
          <MemberHead member={member} />
          {/* fish 2026-09-04: no hard width cap on the tool tag — it sizes to
           * the row's actually available space (a 96px cap truncated long
           * names while the detail span sat empty). */}
          <span className="text-[9.5px] font-extrabold leading-none tracking-[0.08em] uppercase text-ink-3 truncate min-w-0 shrink ml-[7px] mr-[7px]">TOOL·{tool.label}</span>
          <span className="font-mono text-[11px] leading-none text-ink-3 truncate flex-1 min-w-0 mr-[6px]">{highlight(tool.detail || toolTarget(event.args), query)}</span>
          {/* diff chips ride the tab face only — the compact river header has no budget for them */}
          {!compact && diff && <span className="font-mono text-[10px] leading-none text-ink-4 shrink-0 whitespace-nowrap mr-[6px]">+{diff.added} −{diff.removed}</span>}
          {statusMark}
          <span className="font-mono text-[10px] leading-none text-ink-4 shrink-0 whitespace-nowrap">{time}</span>
        </div>
        {/* Collapsed: whole card face toggles. The one-line result preview stays
         * in the member Activity tab; the river passes compact for a uniform
         * one-line anatomy (fish 2026-08-21 ③). */}
        {!expanded && !compact && summaryText && <div className={`mt-1.5 text-[11px] leading-snug truncate ${isError ? "text-blocked" : "text-ink-3"}`}>↳ {summaryText}{resultSize > 120 ? "…" : ""}</div>}
      </button>
      {/* Expanded: unified dropdown area — inset container + surface wells (Session & tools card language) */}
      {expanded && (
        <div className="mt-2 rounded-[7px] border border-line-soft bg-inset/50 p-2.5 space-y-2">
          {event.args !== undefined && <ArgsPanel args={event.args} />}
          {isRunning && (
            <div className="flex items-center gap-1.5 rounded-[7px] border border-line-soft bg-surface-1 px-[9px] py-[7px]">
              <span className="text-think animate-pulse text-[10px] font-bold">●</span>
              <span className="text-[11px] text-ink-3">Running — the result appears here when the call finishes.</span>
            </div>
          )}
          {resultText && (
            <div className={`${isError ? "rounded-[7px] border border-blocked/30 bg-blocked-dim/30 p-1.5" : ""}`}>
              <div className="flex items-center gap-1.5 mb-1">
                <div className="text-[9px] font-bold uppercase tracking-wider text-ink-4">{isError ? "Error" : "Result"}{resultSize > 0 ? ` · ${(resultSize / 1024).toFixed(1)}k` : ""}</div>
                {canPreview && <div className="flex gap-0.5 rounded-md border border-line-soft bg-surface-1 p-0.5 ml-auto"><button onClick={(e) => { e.stopPropagation(); setMode("raw"); }} className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${mode === "raw" ? "bg-surface-3 text-ink-1" : "text-ink-4"}`}>Raw</button><button onClick={(e) => { e.stopPropagation(); setMode("preview"); }} className={`rounded px-1.5 py-0.5 text-[9.5px] font-semibold ${mode === "preview" ? "bg-surface-3 text-ink-1" : "text-ink-4"}`}>Preview</button></div>}
              </div>
              {mode === "preview" && canPreview
                ? <div className="text-[12px] text-ink-2 max-h-[320px] overflow-y-auto bg-surface-1 border border-line-soft rounded-[7px] px-[9px] py-[7px]"><Markdown content={displayText} /></div>
                : <pre className={`rounded-[7px] px-[9px] py-[7px] text-[10.5px] ${isError ? "text-blocked" : "text-ink-2 bg-surface-1 border border-line-soft"} max-h-[320px] overflow-y-auto whitespace-pre-wrap break-words`}>{displayText}</pre>
              }
              {truncated && <div className="mt-1 text-[10px] text-ink-4">Showing first {(MAX_RESULT_RENDER / 1000).toFixed(0)}k chars · full content in event log.</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return <>{text.slice(0, idx)}<mark className="bg-highlight text-ink-1 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>;
}
