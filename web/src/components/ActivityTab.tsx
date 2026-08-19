import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brain, ChevronRight, MessageSquareText, Search, User } from "lucide-react";
import { getMemberActivityEvents, getMemberScopedActivityEvents, getToken } from "../api/client";
import { diffStatForTool, eventSearchText, formatCompactionPreview, formatEventTime, formatToolArgsFull, getSanitizedArgs, isCompactionEvent, isReplyEvent, isToolEvent, summarizeAgentEvent, toolDisplay, toolTarget, type AgentEvent } from "./agent-event-utils";
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
export function ActivityTab({ roomId, agentName, dmScope, activityScope }: {
  roomId: string;
  agentName: string;
  /** 0.20 flagship ②: when set, activity reads/watches the dm scope — events
   * come from the members-shaped route and the WS subscription targets the
   * synthetic dm:<memberId> room the DM instance emits on. */
  dmScope?: { scopeId: string; memberId: string };
  /** Topic page: read/watch topic:<id> events (member config stays on roomId). */
  activityScope?: { scopeId: string; memberId: string };
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

  /** All-stream visibility. Streaming deltas (message_update/tool_update) and
   * message_start markers are noise; a bare message_end from a pure tool-call
   * round (no text, no thinking) carries no information either — excluded per
   * fish 2026-08-09. message_end WITH text/thinking still renders as the
   * REPLY/THINKING cards. */
  const isAllStreamEvent = (event: AgentEvent): boolean => {
    if (event.type === "message_update" || event.type === "tool_update" || event.type === "message_start") return false;
    if (event.type === "message_end" && !event.text && !event.thinking) return false;
    return true;
  };
  // Synchronous re-entry guard — React state alone can miss a second scroll
  // event that fires before the next render (QA noted this under synthetic
  // scrollTop assignment; real wheel gestures were fine, but a ref is cheap insurance).
  const loadingOlderRef = useRef(false);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const scoped = activityScope || dmScope;
      const result = scoped
        ? await getMemberScopedActivityEvents(scoped.memberId, scoped.scopeId, PAGE_SIZE)
        : await getMemberActivityEvents(roomId, agentName, PAGE_SIZE);
      setEvents(result.events as AgentEvent[]);
      setHasMore(result.hasMore);
      setBeforeSeq(result.nextBeforeSeq ?? undefined);
    } finally {
      setLoading(false);
    }
  }, [roomId, agentName, dmScope?.scopeId, dmScope?.memberId, activityScope?.scopeId, activityScope?.memberId]);

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
    const watchRoomId = activityScope?.scopeId || (dmScope ? `dm:${dmScope.memberId}` : roomId);
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
  }, [roomId, agentName, dmScope?.scopeId, dmScope?.memberId, activityScope?.scopeId]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || beforeSeq === undefined || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    try {
      const scoped = activityScope || dmScope;
      const result = scoped
        ? await getMemberScopedActivityEvents(scoped.memberId, scoped.scopeId, PAGE_SIZE, beforeSeq)
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
  }, [hasMore, beforeSeq, roomId, agentName, dmScope?.scopeId, dmScope?.memberId, activityScope?.scopeId, activityScope?.memberId]);

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
  return <section className="space-y-[7px]"><div className="flex items-center gap-2"><span className="text-[10px] font-bold tracking-[0.08em] uppercase text-ink-4">Turn · #{index}</span><span className="font-mono text-[10px] font-normal text-ink-4">{formatEventTime(firstTs)}</span><span className="h-px bg-line-soft flex-1" /></div>{events.filter(e => e.type !== "tool_end" || !e.toolCallId || !events.some(s => s.type === "tool_start" && s.toolCallId === e.toolCallId)).map((event, i) => <EventRow key={`${event.ts || i}:${event.type}:${i}`} event={event} toolEnd={event.type === "tool_start" && event.toolCallId ? toolEndMap[event.toolCallId] : undefined} query={query} />)}</section>;
}

function EventRow({ event, toolEnd, query }: { event: AgentEvent; toolEnd?: AgentEvent; query: string }) {
  const summary = summarizeAgentEvent(event);
  const diff = diffStatForTool(event);
  const time = formatEventTime(typeof event.ts === "number" ? event.ts : undefined);
  if (event.type === "user_prompt") return <UserPromptCard event={event} time={time} query={query} label="USER PROMPT" />;
  if (event.type === "user_steer") return <UserPromptCard event={event} time={time} query={query} label="STEER" />;
  if (event.type === "tool_end") return <ToolCard event={event} toolEnd={event} diff={diff} time={time} query={query} />;
  if (event.type === "agent_start" || event.type === "agent_end") return <div className="text-[11px] text-ink-4 px-1 py-0.5">{summary.detail} · {time}</div>;
  if (event.type === "tool_start") {
    return <ToolCard event={event} toolEnd={toolEnd} diff={diff} time={time} query={query} />;
  }
  if (event.type === "compaction_start" || event.type === "compaction_end") {
    const tone = event.type === "compaction_start" ? "text-accent-ink" : event.errorMessage ? "text-blocked" : "text-onair";
    return <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[9px]"><div className="flex items-center gap-2"><span className={`text-[9.5px] font-extrabold tracking-[0.08em] uppercase ${tone}`}>{summary.label}</span><span className="font-mono text-[11px] text-ink-3 truncate flex-1">{highlight(summary.detail, query)}</span><span className="font-mono text-[10px] text-ink-4 shrink-0">{time}</span></div>{event.type === "compaction_end" && <pre className="mt-2 bg-inset rounded-[7px] px-[9px] py-[7px] text-[10.5px] text-ink-4 max-h-[110px] overflow-y-auto whitespace-pre-wrap break-words">{formatCompactionPreview(event)}</pre>}</div>;
  }
  if (event.type === "message_end" && (event.thinking || event.text)) {
    // Both cards render when a message carries thinking and text (thinking-enabled
    // members must not have their reply silently swallowed).
    // Identity (designer activity-card-identity-v1): Brain+dim italic thinking,
    // MessageSquareText reply — restrained, no new card shells.
    return <>
      {event.thinking ? (
        <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[9px] text-xs text-ink-3">
          <div className="flex items-center gap-1.5">
            <Brain size={10} className="text-think shrink-0" aria-hidden />
            <span className="font-extrabold text-think tracking-[0.08em] uppercase text-[9.5px]">THINKING</span>
          </div>
          <div className="mt-[6px] text-[12.5px] text-ink-3 italic whitespace-pre-wrap max-h-32 overflow-y-auto">{String(event.thinking)}</div>
        </div>
      ) : null}
      {event.text ? (
        <div className="rounded-[10px] border border-line-soft bg-surface-1 px-3 py-[9px]">
          <div className="flex items-center gap-2 mb-1">
            <MessageSquareText size={10} className="text-onair shrink-0" aria-hidden />
            <span className="font-extrabold text-onair tracking-[0.08em] uppercase text-[9.5px]">REPLY</span>
            <span className="font-mono text-[10px] text-ink-4 ml-auto shrink-0">{time}</span>
          </div>
          <div className="mt-[6px] text-[12.5px] text-ink-2"><Markdown content={String(event.text)} /></div>
        </div>
      ) : null}
    </>;
  }
  return <div className="text-[11px] text-ink-4 px-1 py-0.5">{summary.label} {summary.detail} <span className="font-mono text-ink-4">{time}</span></div>;
}

const MAX_RESULT_RENDER = 50_000;
const ARGS_CLAMP_LINES = 12;
const PROMPT_CLAMP_LINES = 4;

function UserPromptCard({
  event,
  time,
  query,
  label = "USER PROMPT",
}: {
  event: AgentEvent;
  time: string;
  query: string;
  /** USER PROMPT (turn start) or STEER (mid-turn inject) — same teal family card. */
  label?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = String(event.text || "");
  const lines = text.split("\n");
  const clamped = lines.length > PROMPT_CLAMP_LINES && !expanded;
  const body = clamped ? lines.slice(0, PROMPT_CLAMP_LINES).join("\n") : text;
  const from = typeof (event as { from?: unknown }).from === "string"
    ? String((event as { from?: string }).from).trim()
    : "";
  return (
    <div className="rounded-[10px] border border-accent/30 bg-accent-dim/20 px-3 py-[9px]">
      <div className="flex items-center gap-2 mb-1">
        <User size={10} className="text-accent-ink shrink-0" aria-hidden />
        <span className="font-extrabold text-accent-ink tracking-[0.08em] uppercase text-[9.5px]">{label}</span>
        {from ? <span className="text-[10px] text-ink-4">· {from}</span> : null}
        <span className="font-mono text-[10px] text-ink-4 ml-auto shrink-0">{time}</span>
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
      <div className="flex items-center gap-2 mb-1">
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
  const mdTools = ["read", "read_memory", "read_file", "query_room_messages", "get_task", "list_tasks"];
  if (mdTools.includes(toolName)) return true;
  // Heuristic: starts with markdown-ish content.
  return /^(#|\*\*|\d+\.|- |```|\|)/m.test(text.slice(0, 200));
}

function ToolCard({ event, toolEnd, diff, time, query }: { event: AgentEvent; toolEnd?: AgentEvent; diff: ReturnType<typeof diffStatForTool>; time: string; query: string }) {
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

  const statusIcon = isError ? "✗" : isRunning ? "●" : toolEnd ? "✓" : "";
  const statusColor = isError ? "text-blocked" : isRunning ? "text-think animate-pulse" : "text-onair";
  const cardBorder = isError ? "border-blocked/30" : "border-line-soft";

  return (
    <div className={`rounded-[10px] border ${cardBorder} bg-surface-1 px-3 py-[9px]`}>
      <button onClick={() => toolEnd && setExpanded(v => !v)} className={`w-full text-left ${toolEnd ? "cursor-pointer" : "cursor-default"}`}>
        <div className="flex items-center gap-2">
          {toolEnd && <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />}
          <span className="text-[9.5px] font-extrabold tracking-[0.08em] uppercase text-ink-3">TOOL·{tool.label}</span>
          <span className="font-mono text-[11px] text-ink-3 truncate flex-1">{highlight(tool.detail || toolTarget(event.args), query)}</span>
          {diff && <span className="font-mono text-[10px] text-ink-4 shrink-0">+{diff.added} −{diff.removed}</span>}
          {statusIcon && <span className={`text-[10px] font-bold shrink-0 ${statusColor}`} title={isError ? "error" : isRunning ? "running" : "done"}>{statusIcon} {toolEnd && !isError && `${(resultSize / 1024).toFixed(1)}k`}{isError && `${(resultSize / 1024).toFixed(1)}k`}</span>}
          <span className="font-mono text-[10px] text-ink-4 shrink-0">{time}</span>
        </div>
        {/* Collapsed: whole card face toggles — header row + one-line summary both live inside the button (fish: 点击区域太小). args/result stay in the expanded body. */}
        {!expanded && summaryText && <div className={`mt-1.5 text-[11px] leading-snug truncate ${isError ? "text-blocked" : "text-ink-3"}`}>↳ {summaryText}{resultSize > 120 ? "…" : ""}</div>}
      </button>
      {/* Expanded: unified dropdown area — inset container + surface wells (Session & tools card language) */}
      {expanded && (
        <div className="mt-2 rounded-[7px] border border-line-soft bg-inset/50 p-2.5 space-y-2">
          {event.args !== undefined && <ArgsPanel args={event.args} />}
          {resultText && (
            <div className={`${isError ? "rounded-[7px] border border-blocked/30 bg-blocked-dim/30 p-1.5" : ""}`}>
              <div className="flex items-center gap-2 mb-1">
                <div className="text-[9px] font-bold uppercase tracking-wider text-ink-4">{isError ? "Error" : "Result"}</div>
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
