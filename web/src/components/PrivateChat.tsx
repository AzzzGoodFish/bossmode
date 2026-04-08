import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import { getToken, getAgentEvents } from "../api/client";
import { Markdown } from "./Markdown";
import { MessageBubble } from "./MessageBubble";

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

// Committed events — finalized items in the stream
export interface CommittedEvent {
  type: "agent_start" | "agent_end" | "message" | "thinking" | "tool" | "user_steer";
  text?: string;
  thinking?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  usage?: unknown;
}

interface PrivateChatProps {
  roomId: string;
  agentName: string;
  onClose: () => void;
  onSteer: (content: string) => void;
  cachedEvents?: CommittedEvent[];
  onEventsChange?: (events: CommittedEvent[]) => void;
}

// Convert a raw server event to CommittedEvent(s)
function rawToCommitted(event: AgentEvent): CommittedEvent[] {
  switch (event.type) {
    case "agent_start": return [{ type: "agent_start" }];
    case "agent_end": return [{ type: "agent_end" }];
    case "message_end": {
      const result: CommittedEvent[] = [];
      if (event.thinking) {
        result.push({ type: "thinking", thinking: event.thinking as string });
      }
      if (event.text) {
        result.push({ type: "message", text: event.text as string, usage: event.usage });
      }
      return result;
    }
    case "tool_start":
      return [{ type: "tool", toolName: event.toolName as string, toolCallId: event.toolCallId as string, args: event.args }];
    case "user_steer":
      return [{ type: "user_steer", text: event.text as string }];
    default: return [];
  }
}

// Build committed list from raw history events
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

export function PrivateChat({
  roomId,
  agentName,
  onClose,
  onSteer,
  cachedEvents,
  onEventsChange,
}: PrivateChatProps) {
  // Single source of truth: committed events array managed via ref + state
  const eventsRef = useRef<CommittedEvent[]>(cachedEvents ?? []);
  const [committed, setCommitted] = useState<CommittedEvent[]>(cachedEvents ?? []);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [streamingThinking, setStreamingThinking] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(!cachedEvents || cachedEvents.length === 0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Sync ref → state (batched)
  const flushEvents = () => {
    setCommitted([...eventsRef.current]);
  };

  // Append event to ref + flush to state
  const pushEvent = (event: CommittedEvent) => {
    eventsRef.current = [...eventsRef.current, event];
    flushEvents();
  };

  // Notify parent for caching
  useEffect(() => {
    onEventsChange?.(committed);
  }, [committed, onEventsChange]);

  // Handle a real-time stream event
  const handleStreamEvent = (event: AgentEvent) => {
    switch (event.type) {
      case "agent_start":
        pushEvent({ type: "agent_start" });
        break;

      case "agent_end": {
        const th = streamingThinking;
        if (th) pushEvent({ type: "thinking", thinking: th });
        setStreamingThinking(null);
        const txt = streamingText;
        if (txt) pushEvent({ type: "message", text: txt });
        setStreamingText(null);
        pushEvent({ type: "agent_end" });
        break;
      }

      case "message_start":
        setStreamingText("");
        setStreamingThinking(null);
        break;

      case "message_update":
        if (event.thinking) setStreamingThinking(event.thinking as string);
        if (event.text) setStreamingText(event.text as string);
        break;

      case "message_end": {
        const th = streamingThinking;
        if (th) pushEvent({ type: "thinking", thinking: th });
        setStreamingThinking(null);
        setStreamingText(null);
        if (event.text) pushEvent({ type: "message", text: event.text as string, usage: event.usage });
        break;
      }

      case "tool_start": {
        const txt = streamingText;
        if (txt) pushEvent({ type: "message", text: txt });
        setStreamingText(null);
        pushEvent({
          type: "tool",
          toolName: event.toolName as string,
          toolCallId: event.toolCallId as string,
          args: event.args,
        });
        break;
      }

      case "tool_end": {
        const idx = eventsRef.current.findLastIndex(
          (e) => e.type === "tool" && e.toolCallId === (event.toolCallId as string),
        );
        if (idx !== -1) {
          eventsRef.current[idx] = {
            ...eventsRef.current[idx],
            result: event.result,
            isError: event.isError as boolean,
          };
          flushEvents();
        }
        break;
      }
    }
  };

  // Single effect: fetch history + subscribe WS
  useEffect(() => {
    const token = getToken();
    if (!token) return;

    // Buffer events during history load
    const pendingEvents: AgentEvent[] = [];
    let historyDone = cachedEvents && cachedEvents.length > 0;

    // WS subscription (immediate)
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}?token=${token}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe:agent", roomId, agent: agentName }));
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "agent:event" && data.agent === agentName && data.roomId === roomId) {
          if (historyDone) {
            handleStreamEvent(data.event as AgentEvent);
          } else {
            pendingEvents.push(data.event as AgentEvent);
          }
        }
      } catch {}
    };

    // History fetch (if no cache)
    if (!historyDone) {
      getAgentEvents(roomId, agentName)
        .then((events) => {
          const history = buildFromHistory(events as AgentEvent[]);
          eventsRef.current = history;
          flushEvents();
        })
        .catch(console.error)
        .finally(() => {
          historyDone = true;
          setLoading(false);
          // Replay buffered events
          for (const ev of pendingEvents) {
            handleStreamEvent(ev);
          }
          pendingEvents.length = 0;
        });
    }

    return () => { ws.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, agentName]);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [committed.length, streamingText, streamingThinking]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSteer(trimmed);
    pushEvent({ type: "user_steer", text: trimmed });
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        // Shift+Enter: default newline in textarea
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Enter: manual newline insert
        e.preventDefault();
        // PrivateChat uses <input>, can't insert newlines — just ignore
      } else {
        e.preventDefault();
        handleSend();
      }
    }
  };

  // Check if there's any visible content
  const hasVisibleContent = committed.some(
    (e) => e.type === "message" || e.type === "tool" || e.type === "user_steer" || e.type === "thinking",
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2 text-sm">
        {!hasVisibleContent && streamingText === null && (
          <div className="text-zinc-600 text-center py-8">
            {loading ? "Loading history..." : "Waiting for agent activity..."}
          </div>
        )}
        {committed.map((event, i) => (
          <CommittedItem key={i} event={event} agentName={agentName} />
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

      <div className="border-t border-zinc-800 p-3 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send private instruction (steer)..."
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white
                     focus:outline-none focus:ring-2 focus:ring-blue-600 placeholder:text-zinc-600"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500
                     text-white text-sm font-medium rounded transition-colors cursor-pointer"
        >
          Steer
        </button>
      </div>
    </div>
  );
}

function CommittedItem({ event, agentName }: { event: CommittedEvent; agentName: string }) {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
      return null;
    case "thinking":
      return <ThinkingCard thinking={event.thinking || ""} />;
    case "message":
      return <MessageBubble sender={agentName} content={event.text || ""} isMarkdown />;
    case "tool":
      return <ToolCard event={event} />;
    case "user_steer":
      return <MessageBubble sender="user" content={event.text || ""} />;
    default:
      return null;
  }
}

function ThinkingCard({ thinking, isStreaming }: { thinking: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className={isStreaming ? "animate-pulse" : ""}>💭</span>
        <span>{isStreaming ? "Thinking..." : "Thought process"}</span>
        <span className="ml-auto text-zinc-700">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-zinc-800 text-xs text-zinc-500 whitespace-pre-wrap max-h-40 overflow-y-auto">
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
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-zinc-400 font-mono">{event.toolName}</span>
        <span className="text-zinc-600 truncate max-w-48">{truncateArgs(event.args)}</span>
        <span className="ml-auto text-zinc-700">{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 text-xs">
          <div className="px-3 py-2">
            <div className="text-zinc-500 mb-1">Arguments:</div>
            <pre className="text-zinc-400 bg-zinc-900 rounded p-2 overflow-x-auto max-h-32">
              {JSON.stringify(event.args, null, 2)}
            </pre>
          </div>
          {isDone && (
            <div className="px-3 py-2 border-t border-zinc-800">
              <div className={`mb-1 ${event.isError ? "text-red-400" : "text-zinc-500"}`}>
                {event.isError ? "Error:" : "Result:"}
              </div>
              <pre className="text-zinc-400 bg-zinc-900 rounded p-2 overflow-x-auto max-h-32">
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
