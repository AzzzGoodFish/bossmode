import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search, RotateCcw, RefreshCw, X, Send } from "lucide-react";
import { abortAgent, getAgentEventsPaginated, getRoomMembers, getMemberTokenUsage, getToken, resetAgentSession, restartMember, type ContextUsageData, type MemberInfo } from "../api/client";
import { useDialog } from "./dialogs";
import { Markdown } from "./Markdown";
import { diffStatForTool, eventSearchText, formatEventTime, isReplyEvent, isToolEvent, summarizeAgentEvent, toolDisplay, toolTarget, type AgentEvent } from "./agent-event-utils";
import { thinkLevelTextClass } from "./StationPanel";

const PAGE_SIZE = 120;
type FilterMode = "all" | "tools" | "replies";

export function WorkstationDetail({ roomId, agentName, status, contextUsage, onClose, onSteer }: {
  roomId: string;
  agentName: string;
  status?: string;
  contextUsage?: ContextUsageData;
  onClose: () => void;
  onSteer: (content: string) => void;
}) {
  const { toast, confirm } = useDialog();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [oldestIndex, setOldestIndex] = useState<number | undefined>();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [query, setQuery] = useState("");
  const [steer, setSteer] = useState("");
  const [members, setMembers] = useState<Record<string, MemberInfo>>({});
  const [tokenTotal, setTokenTotal] = useState<number | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);

  const member = members[agentName];
  const isWorking = status === "working";

  const scrollToLatest = useCallback(() => {
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: "end" }));
  }, []);

  const isNearBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

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
    getRoomMembers(roomId).then((all) => {
      const map: Record<string, MemberInfo> = {};
      for (const m of all) map[m.name] = m;
      setMembers(map);
      const current = all.find((m) => m.name === agentName);
      if (current) getMemberTokenUsage(current.id, roomId).then((v) => setTokenTotal(v.totalTokens)).catch(() => {});
    }).catch(console.error);
  }, [roomId, agentName]);

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
          shouldAutoScrollRef.current = isNearBottom();
          setEvents((prev) => [...prev, data.event as AgentEvent]);
        }
      } catch {}
    };
    return () => ws.close();
  }, [roomId, agentName, isNearBottom]);

  const loadOlder = async () => {
    if (!hasMore || oldestIndex === undefined) return;
    const result = await getAgentEventsPaginated(roomId, agentName, PAGE_SIZE, oldestIndex);
    shouldAutoScrollRef.current = false;
    setEvents((prev) => [...result.events as AgentEvent[], ...prev]);
    setHasMore(result.hasMore);
    setOldestIndex(Math.max(0, oldestIndex - result.events.length));
  };

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((event) => {
      if (filter === "tools" && !isToolEvent(event)) return false;
      if (filter === "replies" && !isReplyEvent(event)) return false;
      if (q && !eventSearchText(event).includes(q)) return false;
      return event.type !== "message_update" && event.type !== "tool_update" && event.type !== "message_start";
    });
  }, [events, filter, query]);

  const counts = useMemo(() => ({
    all: events.filter((e) => e.type !== "message_update" && e.type !== "tool_update" && e.type !== "message_start").length,
    tools: events.filter(isToolEvent).length,
    replies: events.filter(isReplyEvent).length,
  }), [events]);

  const turns = useMemo(() => groupTurns(filteredEvents), [filteredEvents]);

  useEffect(() => {
    if (loading) return;
    if (!shouldAutoScrollRef.current) return;
    scrollToLatest();
  }, [events.length, loading, scrollToLatest]);

  const sendSteer = () => {
    const text = steer.trim();
    if (!text) return;
    onSteer(text);
    shouldAutoScrollRef.current = isNearBottom();
    setEvents((prev) => [...prev, { type: "user_steer", text, ts: Date.now() }]);
    setSteer("");
  };

  const reset = async () => {
    if (!await confirm(`Reset session for @${agentName}?`)) return;
    try { const res = await resetAgentSession(roomId, agentName); toast(res.message, "success"); }
    catch (err: any) { toast(err.message, "error"); }
  };

  const restart = async () => {
    if (!member) return;
    if (!await confirm(`Restart @${agentName} in this room?`)) return;
    try { await restartMember(member.id, roomId); toast(`${agentName} restarted.`, "success"); }
    catch (err: any) { toast(err.message, "error"); }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-surface-1">
      <div className="h-12 shrink-0 border-b border-line flex items-center gap-3 px-4 bg-surface-0">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-accent-ink">WORKSTATION</span>
        <h3 className="text-sm font-semibold text-ink-1">{agentName}</h3>
        <span className="font-mono text-[10px] text-ink-4 truncate">{member?.model || "agent default"}</span>
        <span className="flex-1" />
        {isWorking && <button onClick={() => abortAgent(roomId, agentName).catch(console.error)} className="px-2.5 py-1 text-[11px] font-semibold bg-blocked text-white rounded cursor-pointer">Abort</button>}
        <button onClick={restart} className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] text-ink-2 border border-line rounded cursor-pointer hover:bg-surface-2"><RefreshCw size={12} />Restart</button>
        <button onClick={reset} className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] text-ink-2 border border-line rounded cursor-pointer hover:bg-surface-2"><RotateCcw size={12} />Reset session</button>
        <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:bg-surface-2 cursor-pointer"><X size={14} /></button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-w-0 flex flex-col">
          <div className="w-full px-4 py-3 border-b border-line-soft flex items-center gap-3 shrink-0">
            <div className="flex bg-inset border border-line-soft rounded-lg p-0.5">
              <FilterButton label="All" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
              <FilterButton label="Tools" count={counts.tools} active={filter === "tools"} onClick={() => setFilter("tools")} />
              <FilterButton label="Replies" count={counts.replies} active={filter === "replies"} onClick={() => setFilter("replies")} />
            </div>
            <div className="flex items-center gap-2 bg-inset border border-line-soft rounded-lg px-2.5 py-1.5 flex-1 max-w-md">
              <Search size={13} className="text-ink-4" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search loaded activity: command, tool, file path…" className="bg-transparent outline-none text-xs text-ink-1 placeholder:text-ink-4 flex-1" />
            </div>
          </div>
          <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 w-full">
            {hasMore && <button onClick={loadOlder} className="w-full text-xs text-accent-ink py-2 hover:opacity-80">Load earlier activity</button>}
            {loading && <div className="text-center text-sm text-ink-4 py-8">Loading workstation history…</div>}
            {!loading && turns.length === 0 && <div className="text-center text-sm text-ink-4 py-8">No matching activity.</div>}
            {turns.map((turn, idx) => <TurnBlock key={idx} index={idx + 1} events={turn.events} query={query} />)}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-line bg-surface-0 p-3 flex gap-2 shrink-0 w-full">
            <input value={steer} onChange={(e) => setSteer(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendSteer(); }} placeholder={`Private steer @${agentName}…`} className="flex-1 bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 outline-none focus:border-line-strong" />
            <button onClick={sendSteer} className="inline-flex items-center gap-1 px-3 py-2 bg-accent text-accent-contrast text-sm font-medium rounded cursor-pointer"><Send size={14} />Send</button>
          </div>
        </main>

        <aside className="hidden lg:block w-[260px] border-l border-line bg-surface-0 p-4 space-y-4 overflow-y-auto">
          <SideMetric title="CONTEXT" value={contextUsage?.supported && contextUsage.percentage !== undefined ? `${Math.round(contextUsage.percentage)}%` : "—"} detail={contextUsage?.totalTokens ? `${formatTokens(contextUsage.totalTokens)} tokens` : "unavailable"} />
          <SideMetric title="SESSION" value={member?.runtime || "pi-sdk"} detail={<span>think · <span className={`font-semibold ${thinkLevelTextClass(member?.thinkingLevel || "default")}`}>{member?.thinkingLevel || "default"}</span></span>} />
          <SideMetric title="TOKENS · TOTAL" value={tokenTotal !== null ? formatTokens(tokenTotal) : "—"} detail="cumulative member usage" />
        </aside>
      </div>
    </div>
  );
}

function FilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return <button onClick={onClick} className={`px-3 py-1 text-xs font-medium rounded-md cursor-pointer ${active ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"}`}>{label} <span className="font-mono text-[9.5px] text-ink-4">{count}</span></button>;
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
  return <section className="space-y-2"><div className="flex items-center gap-2"><span className="text-[10px] font-semibold tracking-[0.08em] text-ink-4">Turn · #{index}</span><span className="font-mono text-[10px] text-ink-4">{formatEventTime(firstTs)}</span><span className="h-px bg-line-soft flex-1" /></div>{events.map((event, i) => <EventRow key={`${event.ts || i}:${event.type}:${i}`} event={event} query={query} />)}</section>;
}

function EventRow({ event, query }: { event: AgentEvent; query: string }) {
  const summary = summarizeAgentEvent(event);
  const diff = diffStatForTool(event);
  const time = formatEventTime(typeof event.ts === "number" ? event.ts : undefined);
  if (event.type === "tool_end") return null;
  if (event.type === "agent_start" || event.type === "agent_end") return <div className="text-[11px] text-ink-4">{summary.detail} · {time}</div>;
  if (event.type === "tool_start") {
    const tool = toolDisplay(event.toolName, event.args);
    return <div className="rounded-lg border border-line-soft bg-surface-0 p-3"><div className="flex items-center gap-2"><span className="text-[10px] font-bold tracking-[0.1em] text-accent-ink">TOOL·{tool.label}</span><span className="font-mono text-[11px] text-ink-3 truncate flex-1">{highlight(tool.detail || toolTarget(event.args), query)}</span>{diff && <span className="font-mono text-[10px] text-ink-4">+{diff.added} −{diff.removed}</span>}<span className="font-mono text-[10px] text-ink-4">{time}</span></div><pre className="mt-2 bg-inset rounded p-2 text-[11px] text-ink-4 overflow-x-auto max-h-28">{JSON.stringify(event.args, null, 2)}</pre></div>;
  }
  if (event.type === "message_end" && event.thinking) return <div className="rounded-lg border border-line-soft bg-surface-0 p-3 text-xs text-ink-3"><span className="font-bold text-think tracking-[0.1em] text-[10px]">THINKING</span><div className="mt-1 whitespace-pre-wrap max-h-32 overflow-y-auto">{String(event.thinking)}</div></div>;
  if (event.type === "message_end" && event.text) return <div className="rounded-lg border border-line-soft bg-surface-0 p-3"><div className="flex items-center gap-2 mb-1"><span className="font-bold text-ink-2 tracking-[0.1em] text-[10px]">REPLY</span><span className="font-mono text-[10px] text-ink-4 ml-auto">{time}</span></div><Markdown content={String(event.text)} /></div>;
  return <div className="text-xs text-ink-3">{summary.label} {summary.detail} <span className="font-mono text-ink-4">{time}</span></div>;
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return text;
  return <>{text.slice(0, idx)}<mark className="bg-highlight text-ink-1 rounded px-0.5">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>;
}

function SideMetric({ title, value, detail }: { title: string; value: string; detail: ReactNode }) {
  return <div className="rounded-lg border border-line-soft bg-surface-1 p-3"><div className="text-[10px] font-semibold tracking-[0.08em] text-ink-4">{title}</div><div className="mt-2 text-lg font-semibold text-ink-1">{value}</div><div className="mt-1 text-[11px] text-ink-3">{detail}</div></div>;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
