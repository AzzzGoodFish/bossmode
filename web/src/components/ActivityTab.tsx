import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Search, Send } from "lucide-react";
import { getAgentEventsPaginated, getToken } from "../api/client";
import { diffStatForTool, eventSearchText, formatCompactionPreview, formatEventTime, formatToolArgsPreview, isCompactionEvent, isReplyEvent, isToolEvent, summarizeAgentEvent, toolDisplay, toolTarget, type AgentEvent } from "./agent-event-utils";
import { Markdown } from "./Markdown";

const PAGE_SIZE = 120;
type FilterMode = "all" | "tools" | "replies";

/** Member panel Activity tab: the event stream (tool calls, thinking, replies,
 * compaction) for one member, with filter/search and turn grouping. Renders as
 * normal in-flow content — the panel's own tab body provides the scroll
 * container (same as the Overview/Prompt assets/Session tabs), so this has no
 * height constraints or scrollers of its own. */
export function ActivityTab({ roomId, agentName, onSteer }: {
  roomId: string;
  agentName: string;
  onSteer?: (agentName: string, content: string) => void;
}) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [oldestIndex, setOldestIndex] = useState<number | undefined>();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [query, setQuery] = useState("");
  const [steer, setSteer] = useState("");

  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAgentEventsPaginated(roomId, agentName, PAGE_SIZE);
      setEvents(result.events as AgentEvent[]);
      setHasMore(result.hasMore);
      setOldestIndex(result.hasMore ? result.total - result.events.length : 0);
    } finally {
      setLoading(false);
    }
  }, [roomId, agentName]);

  useEffect(() => { void loadInitial(); }, [loadInitial]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}?token=${token}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe:agent", roomId, agent: agentName }));
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "agent:event" && data.roomId === roomId && data.agent === agentName) {
          setEvents((prev) => [...prev, data.event as AgentEvent]);
        }
      } catch {}
    };
    return () => ws.close();
  }, [roomId, agentName]);

  const loadOlder = async () => {
    if (!hasMore || oldestIndex === undefined) return;
    const result = await getAgentEventsPaginated(roomId, agentName, PAGE_SIZE, oldestIndex);
    setEvents((prev) => [...result.events as AgentEvent[], ...prev]);
    setHasMore(result.hasMore);
    setOldestIndex(Math.max(0, oldestIndex - result.events.length));
  };

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

  const sendSteer = () => {
    const text = steer.trim();
    if (!text || !onSteer) return;
    onSteer(agentName, text);
    setEvents((prev) => [...prev, { type: "user_steer", text, ts: Date.now() }]);
    setSteer("");
  };

  return (
    <div className="space-y-4 pb-6">
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
      <div className="space-y-[14px]">
        {hasMore && <button onClick={loadOlder} className="w-full text-xs text-accent-ink py-2 hover:opacity-80 cursor-pointer">Load earlier activity</button>}
        {loading && <div className="text-center text-sm text-ink-4 py-8">Loading activity…</div>}
        {!loading && turns.length === 0 && <div className="text-center text-sm text-ink-4 py-8">No matching activity.</div>}
        {turns.map((turn, idx) => <TurnBlock key={idx} index={idx + 1} events={turn.events} query={query} />)}
      </div>
      {onSteer && (
        <div className="sticky bottom-0 -mx-5 px-5 pt-3 pb-1 border-t border-line-soft bg-surface-1 flex gap-2">
          <input value={steer} onChange={(e) => setSteer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendSteer(); }} placeholder={`Steer @${agentName}…`} className="flex-1 bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 outline-none focus:border-line-strong" />
          <button onClick={sendSteer} className="inline-flex items-center gap-1 px-3 py-2 bg-accent text-accent-contrast text-sm font-medium rounded cursor-pointer shrink-0"><Send size={14} />Send</button>
        </div>
      )}
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
