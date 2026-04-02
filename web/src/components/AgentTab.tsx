import { useState, useEffect, useRef, useCallback, type KeyboardEvent } from "react";
import { getToken, getAgentEvents, abortAgent } from "../api/client";
import { Markdown } from "./Markdown";
import { MessageBubble } from "./MessageBubble";

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

// Committed events — finalized items in the stream
export interface CommittedEvent {
  type: "agent_start" | "agent_end" | "message" | "thinking" | "tool" | "user_steer" | "agent_reply";
  text?: string;
  thinking?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  usage?: unknown;
  ts?: number; // timestamp
}

interface AgentTabProps {
  roomId: string;
  agentName: string;
  onClose: () => void;
  onSteer: (content: string) => void;
  cachedEvents?: CommittedEvent[];
  onEventsChange?: (events: CommittedEvent[]) => void;
}

function now(): number { return Date.now(); }

// Convert raw server events to CommittedEvent(s)
function rawToCommitted(event: AgentEvent): CommittedEvent[] {
  const ts = (event.ts as number) || now();
  switch (event.type) {
    case "agent_start": return [{ type: "agent_start", ts }];
    case "agent_end": return [{ type: "agent_end", ts }];
    case "message_end": {
      const result: CommittedEvent[] = [];
      if (event.thinking) result.push({ type: "thinking", thinking: event.thinking as string, ts });
      if (event.text) result.push({ type: "message", text: event.text as string, usage: event.usage, ts });
      return result;
    }
    case "tool_start":
      return [{ type: "tool", toolName: event.toolName as string, toolCallId: event.toolCallId as string, args: event.args, ts }];
    case "user_steer":
      return [{ type: "user_steer", text: event.text as string, ts }];
    case "agent_reply":
      return [{ type: "agent_reply", text: event.text as string, ts }];
    default: return [];
  }
}

function buildFromHistory(events: AgentEvent[]): CommittedEvent[] {
  const result: CommittedEvent[] = [];
  for (const raw of events) {
    if (raw.type === "tool_end") {
      const idx = result.findLastIndex((e) => e.type === "tool" && e.toolCallId === (raw.toolCallId as string));
      if (idx !== -1) {
        result[idx] = { ...result[idx], result: raw.result, isError: raw.isError as boolean };
      }
    } else {
      result.push(...rawToCommitted(raw));
    }
  }
  return result;
}

// ============================================================================
// AgentTab — outer shell with Chat / Activity sub-views
// ============================================================================

export function AgentTab({ roomId, agentName, onClose, onSteer, cachedEvents, onEventsChange }: AgentTabProps) {
  const [view, setView] = useState<"chat" | "activity">("chat");
  const [activityMode, setActivityMode] = useState<"formatted" | "raw">("formatted");
  const [rawLines, setRawLines] = useState<Array<{ type: "stdout" | "stderr"; text: string; ts: number }>>([]);
  const MAX_RAW_LINES = 2000;

  // Shared event state
  const eventsRef = useRef<CommittedEvent[]>(cachedEvents ?? []);
  const [committed, setCommitted] = useState<CommittedEvent[]>(cachedEvents ?? []);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [streamingThinking, setStreamingThinking] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cachedEvents || cachedEvents.length === 0);
  const [isWorking, setIsWorking] = useState(false);

  // Refs for streaming state — avoids stale closure in WS handler
  const streamingTextRef = useRef<string | null>(null);
  const streamingThinkingRef = useRef<string | null>(null);

  const flushEvents = useCallback(() => setCommitted([...eventsRef.current]), []);

  const pushEvent = useCallback((event: CommittedEvent) => {
    eventsRef.current = [...eventsRef.current, event];
    flushEvents();
  }, [flushEvents]);

  useEffect(() => { onEventsChange?.(committed); }, [committed, onEventsChange]);

  // Stream event handler — uses refs to avoid stale closures
  const handleStreamEventRef = useRef<(event: AgentEvent) => void>(() => {});
  handleStreamEventRef.current = (event: AgentEvent) => {
    const ts = now();
    switch (event.type) {
      case "agent_start":
        setIsWorking(true);
        pushEvent({ type: "agent_start", ts });
        break;
      case "agent_end": {
        setIsWorking(false);
        const th = streamingThinkingRef.current;
        if (th) pushEvent({ type: "thinking", thinking: th, ts });
        streamingThinkingRef.current = null;
        setStreamingThinking(null);
        const txt = streamingTextRef.current;
        if (txt) pushEvent({ type: "message", text: txt, ts });
        streamingTextRef.current = null;
        setStreamingText(null);
        pushEvent({ type: "agent_end", ts });
        break;
      }
      case "message_start":
        streamingTextRef.current = "";
        setStreamingText("");
        streamingThinkingRef.current = null;
        setStreamingThinking(null);
        break;
      case "message_update":
        if (event.thinking) {
          streamingThinkingRef.current = event.thinking as string;
          setStreamingThinking(event.thinking as string);
        }
        if (event.text) {
          streamingTextRef.current = event.text as string;
          setStreamingText(event.text as string);
        }
        break;
      case "message_end": {
        const th = streamingThinkingRef.current;
        if (th) pushEvent({ type: "thinking", thinking: th, ts });
        streamingThinkingRef.current = null;
        setStreamingThinking(null);
        streamingTextRef.current = null;
        setStreamingText(null);
        if (event.text) pushEvent({ type: "message", text: event.text as string, usage: event.usage, ts });
        break;
      }
      case "tool_start": {
        const txt = streamingTextRef.current;
        if (txt) pushEvent({ type: "message", text: txt, ts });
        streamingTextRef.current = null;
        setStreamingText(null);
        pushEvent({ type: "tool", toolName: event.toolName as string, toolCallId: event.toolCallId as string, args: event.args, ts });
        break;
      }
      case "tool_end": {
        const idx = eventsRef.current.findLastIndex(
          (e) => e.type === "tool" && e.toolCallId === (event.toolCallId as string),
        );
        if (idx !== -1) {
          eventsRef.current[idx] = { ...eventsRef.current[idx], result: event.result, isError: event.isError as boolean };
          flushEvents();
        }
        break;
      }
      case "agent_reply":
        pushEvent({ type: "agent_reply", text: event.text as string, ts });
        break;
      case "cli:stdout":
      case "cli:stderr": {
        const lineType = event.type === "cli:stdout" ? "stdout" as const : "stderr" as const;
        setRawLines((prev) => {
          const next = [...prev, { type: lineType, text: event.text as string, ts }];
          return next.length > MAX_RAW_LINES ? next.slice(-MAX_RAW_LINES) : next;
        });
        break;
      }
    }
  };

  // WS + history — uses ref so WS always calls latest handler
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const pendingEvents: AgentEvent[] = [];
    let historyDone = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}?token=${token}`);
    ws.onopen = () => { ws.send(JSON.stringify({ type: "subscribe:agent", roomId, agent: agentName })); };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "agent:event" && data.agent === agentName && data.roomId === roomId) {
          if (historyDone) handleStreamEventRef.current(data.event as AgentEvent);
          else pendingEvents.push(data.event as AgentEvent);
        }
      } catch {}
    };
    // Always fetch full history from server (cache is only for initial render)
    getAgentEvents(roomId, agentName)
      .then((events) => { eventsRef.current = buildFromHistory(events as AgentEvent[]); flushEvents(); })
      .catch(console.error)
      .finally(() => {
        historyDone = true;
        setLoading(false);
        for (const ev of pendingEvents) handleStreamEventRef.current(ev);
        pendingEvents.length = 0;
      });
    return () => { ws.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, agentName]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Sub-view tabs */}
      <div className="flex items-center border-b border-zinc-200 dark:border-zinc-800 px-4 gap-1 shrink-0">
        <SubTab label="Chat" active={view === "chat"} onClick={() => setView("chat")} />
        <SubTab label="Activity" active={view === "activity"} onClick={() => setView("activity")} />
        {isWorking && (
          <button
            onClick={() => { abortAgent(roomId, agentName).catch(console.error); }}
            className="ml-auto px-2.5 py-1 text-[11px] font-medium bg-red-600 hover:bg-red-500 text-white rounded transition-colors cursor-pointer"
            title={`Interrupt ${agentName}`}
          >Interrupt</button>
        )}
        {view === "activity" && !isWorking && (
          <div className="ml-auto inline-flex rounded-md border border-zinc-300 dark:border-zinc-700 overflow-hidden" role="radiogroup" aria-label="Output format">
            <button
              onClick={() => setActivityMode("formatted")}
              role="radio"
              aria-checked={activityMode === "formatted"}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                activityMode === "formatted"
                  ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100"
                  : "bg-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >Formatted</button>
            <button
              onClick={() => setActivityMode("raw")}
              role="radio"
              aria-checked={activityMode === "raw"}
              className={`px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                activityMode === "raw"
                  ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-100"
                  : "bg-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
              }`}
            >Raw</button>
          </div>
        )}
      </div>

      {view === "chat"
        ? <AgentChat
            committed={committed}
            isWorking={isWorking}
            agentName={agentName}
            onSteer={onSteer}
            onSend={(text) => { onSteer(text); pushEvent({ type: "user_steer", text, ts: now() }); }}
          />
        : activityMode === "formatted"
          ? <AgentActivity
              committed={committed}
              streamingText={streamingText}
              streamingThinking={streamingThinking}
              agentName={agentName}
              loading={loading}
            />
          : <RawOutput lines={rawLines} />
      }
    </div>
  );
}

function SubTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-xs font-medium transition-colors cursor-pointer ${
        active
          ? "text-blue-500 dark:text-blue-400 border-b-2 border-blue-500"
          : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
      }`}
    >
      {label}
    </button>
  );
}

// ============================================================================
// Timestamp formatting
// ============================================================================

function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ============================================================================
// AgentChat — private conversation: user_steer + agent_reply + message
// ============================================================================

function AgentChat({
  committed,
  isWorking,
  agentName,
  onSteer,
  onSend,
}: {
  committed: CommittedEvent[];
  isWorking: boolean;
  agentName: string;
  onSteer: (content: string) => void;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const chatEvents = committed.filter((e) => e.type === "user_steer" || e.type === "agent_reply" || e.type === "message");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatEvents.length, isWorking]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm">
        {chatEvents.length === 0 && !isWorking && (
          <div className="text-zinc-600 text-center py-8">
            Send a private instruction to {agentName}...
          </div>
        )}
        {chatEvents.map((event, i) => (
          <div key={i}>
            <MessageBubble
              sender={event.type === "user_steer" ? "user" : agentName}
              content={event.text || ""}
              isMarkdown={event.type !== "user_steer"}
            />
            {event.ts && <div className="text-[10px] text-zinc-700 mt-0.5 px-1">{formatTime(event.ts)}</div>}
          </div>
        ))}
        {isWorking && (
          <div className="text-zinc-500 text-xs flex items-center gap-2 py-1">
            <span className="animate-pulse">●</span> {agentName} is working...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-zinc-200 dark:border-zinc-800 p-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send private instruction..."
          className="flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-sm text-zinc-900 dark:text-white
                     focus:outline-none focus:ring-2 focus:ring-blue-600 placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 disabled:text-zinc-400 dark:disabled:text-zinc-500
                     text-white text-sm font-medium rounded transition-colors cursor-pointer"
        >
          Send
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// AgentActivity — read-only view of all events with timestamps
// ============================================================================

function AgentActivity({
  committed,
  streamingText,
  streamingThinking,
  agentName,
  loading,
}: {
  committed: CommittedEvent[];
  streamingText: string | null;
  streamingThinking: string | null;
  agentName: string;
  loading: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasVisibleContent = committed.some(
    (e) => e.type === "message" || e.type === "tool" || e.type === "user_steer" || e.type === "thinking" || e.type === "agent_reply",
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [committed.length, streamingText, streamingThinking]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm">
      {!hasVisibleContent && streamingText === null && (
        <div className="text-zinc-600 text-center py-8">
          {loading ? "Loading history..." : "Waiting for agent activity..."}
        </div>
      )}
      {committed.map((event, i) => (
        <ActivityItem key={i} event={event} agentName={agentName} />
      ))}
      {streamingThinking !== null && streamingThinking.length > 0 && (
        <ThinkingCard thinking={streamingThinking} isStreaming />
      )}
      {streamingText !== null && streamingText.length > 0 && (
        <div className="text-zinc-300 whitespace-pre-wrap">
          {streamingText}
          <span className="text-zinc-600 animate-pulse">▊</span>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function ActivityItem({ event, agentName }: { event: CommittedEvent; agentName: string }) {
  const time = event.ts ? <span className="text-[10px] text-zinc-700 ml-2">{formatTime(event.ts)}</span> : null;

  switch (event.type) {
    case "agent_start":
      return <div className="text-[10px] text-zinc-600 flex items-center gap-1">▶ Agent started {time}</div>;
    case "agent_end":
      return <div className="text-[10px] text-zinc-600 flex items-center gap-1">■ Agent finished {time}</div>;
    case "thinking":
      return <div><ThinkingCard thinking={event.thinking || ""} />{time}</div>;
    case "message":
      return <div><MessageCard text={event.text || ""} />{time}</div>;
    case "tool":
      return <div><ToolCard event={event} />{time}</div>;
    case "user_steer":
      return <div><MessageBubble sender="user" content={event.text || ""} />{time}</div>;
    case "agent_reply":
      return <div><MessageCard text={event.text || ""} label="DM Reply" />{time}</div>;
    default:
      return null;
  }
}

// ============================================================================
// Shared UI components
// ============================================================================

function MessageCard({ text, label }: { text: string; label?: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className="text-blue-400">💬</span>
        {label && <span className="text-blue-500 font-medium shrink-0">{label}</span>}
        <span className="text-zinc-400 truncate max-w-md">{preview}</span>
        <span className="ml-auto text-zinc-700">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-zinc-800 text-sm text-zinc-300">
          <Markdown content={text} />
        </div>
      )}
    </div>
  );
}

function ThinkingCard({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className={isStreaming ? "animate-pulse" : ""}>💭</span>
        <span>{isStreaming ? "Thinking..." : "Thought process"}</span>
        <span className="ml-auto text-zinc-700">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {thinking}
          {isStreaming && <span className="animate-pulse">▊</span>}
        </div>
      )}
    </div>
  );
}

function ToolCard({ event }: { event: CommittedEvent }) {
  const [expanded, setExpanded] = useState(false);
  const isDone = event.result !== undefined;
  const statusColor = !isDone ? "text-amber-500" : event.isError ? "text-red-400" : "text-emerald-400";
  const statusIcon = !isDone ? "⏳" : event.isError ? "✗" : "✓";
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-zinc-400 font-mono">{event.toolName}</span>
        <span className="text-zinc-600 truncate max-w-48">{truncateArgs(event.args)}</span>
        <span className="ml-auto text-zinc-700">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 text-xs">
          <div className="px-3 py-2">
            <div className="text-zinc-500 mb-1">Arguments:</div>
            <pre className="text-zinc-400 bg-zinc-50 dark:bg-zinc-900 rounded p-2 overflow-x-auto max-h-32">
              {JSON.stringify(event.args, null, 2)}
            </pre>
          </div>
          {isDone && (
            <div className="px-3 py-2 border-t border-zinc-800">
              <div className={`mb-1 ${event.isError ? "text-red-400" : "text-zinc-500"}`}>
                {event.isError ? "Error:" : "Result:"}
              </div>
              <pre className="text-zinc-400 bg-zinc-50 dark:bg-zinc-900 rounded p-2 overflow-x-auto max-h-32">
                {typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function truncateArgs(args: unknown): string {
  const str = JSON.stringify(args);
  return str.length > 60 ? str.slice(0, 60) + "..." : str;
}

// ============================================================================
// RawOutput — terminal-style CLI stdout/stderr viewer
// ============================================================================

function RawOutput({ lines }: { lines: Array<{ type: "stdout" | "stderr"; text: string; ts: number }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);

  // Auto-scroll: track whether user has scrolled up
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    isAutoScroll.current = atBottom;
  }, []);

  // Scroll to bottom when new lines arrive (if auto-scroll enabled)
  useEffect(() => {
    if (isAutoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length]);

  if (lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-950">
        <span className="text-zinc-600 italic text-sm">Waiting for output...</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto bg-zinc-950 px-4 py-2 font-mono text-[13px] leading-[1.6]"
      role="log"
      aria-live="polite"
    >
      {lines.map((line, i) => (
        <div key={i} className="py-[1px] whitespace-pre-wrap break-all">
          {line.type === "stderr" ? (
            <><span className="text-red-500 font-semibold">[stderr] </span><span className="text-red-400">{line.text}</span></>
          ) : (
            <span className="text-zinc-300">{line.text}</span>
          )}
        </div>
      ))}
      <span className="text-zinc-500 animate-pulse">▊</span>
    </div>
  );
}
