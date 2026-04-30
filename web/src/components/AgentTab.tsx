import { useState, useEffect, useRef, useCallback, type KeyboardEvent, type ClipboardEvent } from "react";
import { useDraft } from "../hooks/useDraft";
import { Paperclip, X, Loader2 } from "lucide-react";
import { getToken, getAgentEventsPaginated, abortAgent, uploadFile, resetAgentSession } from "../api/client";
import { useDialog } from "./dialogs";
import { Markdown } from "./Markdown";
import { MessageBubble } from "./MessageBubble";

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

// Committed events — finalized items in the stream
export interface CommittedEvent {
  type: "agent_start" | "agent_end" | "message" | "thinking" | "tool" | "user_steer" | "agent_reply" | "system";
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

export function isResetSessionCommand(input: string): boolean {
  return input.trim() === "/reset-session";
}

export function buildResetSessionConfirmMessage(roomId: string, agentName: string): string {
  return `Reset session for @${agentName} in room ${roomId}?\n\nThis will:\n- clear the runtime session\n- set the agent cursor to null\n- keep room messages and activity history\n\nNext activation will start fresh from recent context.`;
}

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
    case "system":
      return [{ type: "system", text: event.text as string, ts }];
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

export function getAgentHistorySyncPlan(cachedEvents?: CommittedEvent[]): {
  showCachedImmediately: boolean;
  shouldFetchHistory: boolean;
  initialLoading: boolean;
} {
  const hasCachedData = Boolean(cachedEvents && cachedEvents.length > 0);
  return {
    showCachedImmediately: hasCachedData,
    shouldFetchHistory: true,
    initialLoading: !hasCachedData,
  };
}

export function buildAgentHistoryState(events: AgentEvent[]): {
  committed: CommittedEvent[];
  isWorking: boolean;
} {
  let isWorking = false;
  for (const event of events) {
    if (event.type === "agent_start") isWorking = true;
    if (event.type === "agent_end") isWorking = false;
  }
  return {
    committed: buildFromHistory(events),
    isWorking,
  };
}

export function getAgentTabHeaderControls(view: "chat" | "activity", isWorking: boolean): {
  showActivityModeToggle: boolean;
  showInterrupt: boolean;
} {
  return {
    showActivityModeToggle: view === "activity",
    showInterrupt: isWorking,
  };
}

// ============================================================================
// AgentTab — outer shell with Chat / Activity sub-views
// ============================================================================

const EVENTS_PAGE_SIZE = 100;

export function AgentTab({ roomId, agentName, onClose, onSteer, cachedEvents, onEventsChange }: AgentTabProps) {
  const { toast } = useDialog();
  const [view, setView] = useState<"chat" | "activity">("chat");
  const [activityMode, setActivityMode] = useState<"formatted" | "raw">("formatted");
  const [rawLines, setRawLines] = useState<Array<{ type: "stdout" | "stderr"; text: string; ts: number }>>([]);
  const MAX_RAW_LINES = 2000;

  // Shared event state
  const eventsRef = useRef<CommittedEvent[]>(cachedEvents ?? []);
  const [committed, setCommitted] = useState<CommittedEvent[]>(cachedEvents ?? []);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [streamingThinking, setStreamingThinking] = useState<string | null>(null);
  const historySyncPlan = getAgentHistorySyncPlan(cachedEvents);
  const [loading, setLoading] = useState(historySyncPlan.initialLoading);
  const [isWorking, setIsWorking] = useState(false);
  // Pagination state for events history
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [loadingOlderEvents, setLoadingOlderEvents] = useState(false);
  const oldestEventIndex = useRef<number | undefined>(undefined);

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
      case "system":
        pushEvent({ type: "system", text: event.text as string, ts });
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

  // Load older events (prepend)
  const loadOlderEvents = useCallback(async () => {
    if (loadingOlderEvents || !hasMoreEvents || oldestEventIndex.current === undefined) return;
    setLoadingOlderEvents(true);
    try {
      const result = await getAgentEventsPaginated(roomId, agentName, EVENTS_PAGE_SIZE, oldestEventIndex.current);
      if (result.events.length > 0) {
        const olderCommitted = buildFromHistory(result.events as AgentEvent[]);
        eventsRef.current = [...olderCommitted, ...eventsRef.current];
        flushEvents();
        oldestEventIndex.current = Math.max(0, (oldestEventIndex.current ?? 0) - result.events.length);
      }
      setHasMoreEvents(result.hasMore);
    } catch (err) {
      console.error("Failed to load older events:", err);
    } finally {
      setLoadingOlderEvents(false);
    }
  }, [roomId, agentName, loadingOlderEvents, hasMoreEvents, flushEvents]);

  // WS + history — uses ref so WS always calls latest handler
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const pendingEvents: AgentEvent[] = [];
    let historyDone = false;
    if (historySyncPlan.showCachedImmediately) setLoading(false);
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

    if (historySyncPlan.shouldFetchHistory) {
      getAgentEventsPaginated(roomId, agentName, EVENTS_PAGE_SIZE)
        .then((result) => {
          const historyState = buildAgentHistoryState(result.events as AgentEvent[]);
          eventsRef.current = historyState.committed;
          flushEvents();
          setIsWorking(historyState.isWorking);
          setHasMoreEvents(result.hasMore);
          oldestEventIndex.current = result.hasMore ? result.total - result.events.length : 0;
        })
        .catch(console.error)
        .finally(() => {
          historyDone = true;
          setLoading(false);
          for (const ev of pendingEvents) handleStreamEventRef.current(ev);
          pendingEvents.length = 0;
        });
    }
    return () => { ws.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, agentName]);

  const headerControls = getAgentTabHeaderControls(view, isWorking);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Sub-view tabs */}
      <div className="flex items-center border-b border-zinc-200 dark:border-zinc-800 px-4 gap-1 shrink-0">
        <SubTab label="Chat" active={view === "chat"} onClick={() => setView("chat")} />
        <SubTab label="Activity" active={view === "activity"} onClick={() => setView("activity")} />
        {(headerControls.showActivityModeToggle || headerControls.showInterrupt) && (
          <div className="ml-auto flex items-center gap-2">
            {headerControls.showActivityModeToggle && (
              <div className="inline-flex rounded-md border border-zinc-300 dark:border-zinc-700 overflow-hidden" role="radiogroup" aria-label="Output format">
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
            {headerControls.showInterrupt && (
              <button
                onClick={() => { abortAgent(roomId, agentName).catch(console.error); }}
                className="px-2.5 py-1 text-[11px] font-medium bg-red-600 hover:bg-red-500 text-white rounded transition-colors cursor-pointer"
                title={`Interrupt ${agentName}`}
              >Interrupt</button>
            )}
          </div>
        )}
      </div>

      {view === "chat"
        ? <AgentChat
            committed={committed}
            isWorking={isWorking}
            agentName={agentName}
            roomId={roomId}
            onSteer={onSteer}
            onSend={(text) => { onSteer(text); pushEvent({ type: "user_steer", text, ts: now() }); }}
            onResetSessionSuccess={(message) => toast(message, "success")}
            onResetSessionError={(message) => toast(message, "error")}
            hasMore={hasMoreEvents}
            loadingOlder={loadingOlderEvents}
            onLoadOlder={loadOlderEvents}
          />
        : activityMode === "formatted"
          ? <AgentActivity
              committed={committed}
              streamingText={streamingText}
              streamingThinking={streamingThinking}
              agentName={agentName}
              roomId={roomId}
              loading={loading}
              hasMore={hasMoreEvents}
              loadingOlder={loadingOlderEvents}
              onLoadOlder={loadOlderEvents}
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

/** Generate clipboard image filename */
function clipboardFilenameForChat(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `clipboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

interface PendingChatFile {
  file: File;
  preview?: string;
}

function AgentChat({
  committed,
  isWorking,
  agentName,
  roomId,
  onSteer,
  onSend,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onResetSessionSuccess,
  onResetSessionError,
}: {
  committed: CommittedEvent[];
  isWorking: boolean;
  agentName: string;
  roomId: string;
  onSteer: (content: string) => void;
  onSend: (text: string) => void;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onResetSessionSuccess: (message: string) => void;
  onResetSessionError: (message: string) => void;
}) {
  const { confirm } = useDialog();
  const [input, setInput, clearInput] = useDraft(`agent:${roomId}:${agentName}`);
  const [pendingFiles, setPendingFiles] = useState<PendingChatFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandIdx, setCommandIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isNearBottom = useRef(true);
  const prevEventCount = useRef(0);
  const prevScrollHeight = useRef(0);
  const initialScrollDone = useRef(false);
  const [newPrependCount, setNewPrependCount] = useState(0);
  const prevCommittedLen = useRef(committed.length);

  const COMMANDS = [
    { name: "/compact", description: "Compress agent context" },
    { name: "/reset-session", description: "Reset runtime session and cursor" },
  ];

  const filteredCommands = COMMANDS.filter((c) => c.name.startsWith(input) || input === "/");

  // Reset highlight when menu opens or filtered list changes
  useEffect(() => {
    if (showCommandMenu) setCommandIdx(0);
  }, [showCommandMenu, input]);

  const chatEvents = committed.filter((e) => e.type === "user_steer" || e.type === "agent_reply" || e.type === "message" || e.type === "system");

  // Initial scroll to bottom (instant, no animation)
  useEffect(() => {
    if (chatEvents.length > 0 && !initialScrollDone.current) {
      bottomRef.current?.scrollIntoView();
      initialScrollDone.current = true;
      prevEventCount.current = chatEvents.length;
    }
  }, [chatEvents.length]);

  // Auto-scroll on new messages (only if near bottom)
  useEffect(() => {
    const added = chatEvents.length - prevEventCount.current;
    if (added > 0 && isNearBottom.current && initialScrollDone.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevEventCount.current = chatEvents.length;
  }, [chatEvents.length]);

  // Scroll position preservation when older events are prepended
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !loadingOlder) return;
    prevScrollHeight.current = el.scrollHeight;
  }, [loadingOlder]);

  useEffect(() => {
    if (loadingOlder === false && prevScrollHeight.current > 0) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight - prevScrollHeight.current;
        prevScrollHeight.current = 0;
      }
      // Detect prepended events for slide-in animation
      const prepended = committed.length - prevCommittedLen.current;
      if (prepended > 0) {
        setNewPrependCount(prepended);
        setTimeout(() => setNewPrependCount(0), 600);
      }
    }
    prevCommittedLen.current = committed.length;
  }, [committed.length, loadingOlder]);

  // Scroll handler — auto-load older (debounced at scrollTop=0) + track near-bottom
  const loadOlderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (el.scrollTop === 0 && hasMore && !loadingOlder) {
      if (!loadOlderTimer.current) {
        loadOlderTimer.current = setTimeout(() => {
          loadOlderTimer.current = null;
          if (containerRef.current && containerRef.current.scrollTop === 0) onLoadOlder();
        }, 300);
      }
    } else if (loadOlderTimer.current) {
      clearTimeout(loadOlderTimer.current);
      loadOlderTimer.current = null;
    }
  }, [hasMore, loadingOlder, onLoadOlder]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const stickToBottomIfNeeded = () => {
      if (isNearBottom.current) {
        container.scrollTop = container.scrollHeight;
      }
    };

    const contentRO = new ResizeObserver(stickToBottomIfNeeded);
    contentRO.observe(content);

    const containerRO = new ResizeObserver(stickToBottomIfNeeded);
    containerRO.observe(container);

    return () => {
      contentRO.disconnect();
      containerRO.disconnect();
    };
  }, []);

  const addFiles = useCallback((files: File[]) => {
    setPendingFiles((prev) => [
      ...prev,
      ...files.map((file) => ({
        file,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })),
    ]);
  }, []);

  const removeFile = useCallback((idx: number) => {
    setPendingFiles((prev) => {
      const removed = prev[idx];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed && pendingFiles.length === 0) return;

    let content = trimmed;

    if (pendingFiles.length > 0) {
      setUploading(true);
      try {
        const lines: string[] = [];
        for (const pf of pendingFiles) {
          const result = await uploadFile(roomId, pf.file);
          lines.push(`Attachment: [original filename: ${result.originalFilename}](${result.path})`);
        }
        const attachText = lines.join("\n");
        content = content ? `${content}\n${attachText}` : attachText;
      } catch (err) {
        console.error("Upload failed:", err);
        setUploading(false);
        return;
      }
      pendingFiles.forEach((pf) => { if (pf.preview) URL.revokeObjectURL(pf.preview); });
      setPendingFiles([]);
      setUploading(false);
    }

    if (isResetSessionCommand(content) && pendingFiles.length === 0) {
      const ok = await confirm(buildResetSessionConfirmMessage(roomId, agentName));
      if (!ok) return;
      try {
        const result = await resetAgentSession(roomId, agentName);
        onResetSessionSuccess(result.message);
        clearInput();
      } catch (err: any) {
        onResetSessionError(`Reset session failed: ${err.message}`);
      }
      return;
    }

    if (content) onSend(content);
    clearInput();
  };

  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const newHeight = Math.min(Math.max(el.scrollHeight, 36), 120);
    el.style.height = newHeight + "px";
    el.style.overflowY = el.scrollHeight > 120 ? "auto" : "hidden";
  }, [input]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Slash command menu navigation takes priority when open
    if (showCommandMenu && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandIdx((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIdx((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const cmd = filteredCommands[commandIdx] ?? filteredCommands[0];
        setInput(cmd.name);
        setShowCommandMenu(false);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const cmd = filteredCommands[commandIdx] ?? filteredCommands[0];
        setInput(cmd.name);
        setShowCommandMenu(false);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowCommandMenu(false);
        return;
      }
    }

    if (e.key === "Enter") {
      if (e.shiftKey) {
        // Shift+Enter: browser default inserts newline
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Enter: manually insert newline
        e.preventDefault();
        const el = inputRef.current;
        if (el) {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          const newVal = input.slice(0, start) + "\n" + input.slice(end);
          setInput(newVal);
          requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 1; });
        }
      } else {
        e.preventDefault();
        handleSend();
      }
    }
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(new File([file], clipboardFilenameForChat(), { type: file.type }));
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }, [addFiles]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 text-sm" onScroll={handleScroll}>
        <div ref={contentRef} className="space-y-2">
          {hasMore === false && chatEvents.length > 0 && (
            <div className="text-center text-xs text-zinc-400 dark:text-zinc-600 py-2">Beginning of conversation</div>
          )}
          {loadingOlder && (
            <div className="flex items-center justify-center gap-1.5 py-2">
              <Loader2 size={14} className="animate-spin text-zinc-400" />
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Loading earlier messages</span>
            </div>
          )}
          {chatEvents.length === 0 && !isWorking && (
            <div className="text-zinc-600 text-center py-8">
              Send a private instruction to {agentName}...
            </div>
          )}
          {chatEvents.map((event, i) => {
            const isNewPrepend = i < newPrependCount;
            const animDelay = isNewPrepend ? `${Math.min(i, 10) * 30}ms` : undefined;
            return (
            <div key={i} className={isNewPrepend ? "msg-enter" : undefined} style={animDelay ? { animationDelay: animDelay } : undefined}>
              <MessageBubble
                sender={event.type === "user_steer" ? "user" : event.type === "system" ? "system" : agentName}
                content={event.text || ""}
                isMarkdown={event.type !== "user_steer"}
                time={event.ts ? formatTime(event.ts) : undefined}
                fullTime={event.ts ? new Date(event.ts).toLocaleString() : undefined}
                roomId={roomId}
              />
            </div>
            );
          })}
          {isWorking && (
            <div className="text-zinc-500 text-xs flex items-center gap-2 py-1">
              <span className="animate-pulse">●</span> {agentName} is working...
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* File preview */}
      {pendingFiles.length > 0 && (
        <div className="px-3 pt-2 flex flex-wrap gap-2">
          {pendingFiles.map((pf, idx) => (
            <div key={idx} className="relative group">
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} className="w-12 h-12 object-cover rounded border border-zinc-300 dark:border-zinc-600" />
              ) : (
                <div className="w-12 h-12 flex items-center justify-center rounded border border-zinc-300 dark:border-zinc-600 bg-zinc-100 dark:bg-zinc-700">
                  <span className="text-[9px] text-zinc-500 truncate px-0.5">{pf.file.name.split(".").pop()}</span>
                </div>
              )}
              <button
                onClick={() => removeFile(idx)}
                className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X size={8} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative border-t border-zinc-200 dark:border-zinc-800 p-3 flex gap-2 items-end">
        {/* Slash command menu */}
        {showCommandMenu && filteredCommands.length > 0 && (
          <div
            role="listbox"
            aria-label="Slash commands"
            className="absolute bottom-full left-3 mb-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg overflow-hidden w-72 z-20 max-h-60 overflow-y-auto"
          >
            {filteredCommands.map((cmd, idx) => {
              const active = idx === commandIdx;
              return (
                <button
                  key={cmd.name}
                  role="option"
                  aria-selected={active}
                  className={`w-full text-left px-3 py-2 text-sm transition-colors cursor-pointer ${
                    active
                      ? "bg-blue-50 dark:bg-blue-600/20"
                      : "hover:bg-zinc-100 dark:hover:bg-zinc-700"
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setCommandIdx(idx)}
                  onClick={() => { setInput(cmd.name); setShowCommandMenu(false); }}
                >
                  <span className={`font-mono ${active ? "text-blue-700 dark:text-blue-300" : "text-zinc-900 dark:text-white"}`}>{cmd.name}</span>
                  <span className={`ml-2 text-xs ${active ? "text-blue-500/80 dark:text-blue-400/80" : "text-zinc-400 dark:text-zinc-500"}`}>{cmd.description}</span>
                </button>
              );
            })}
          </div>
        )}

        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-11 h-11 md:w-9 md:h-9 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors cursor-pointer shrink-0"
          title="Attach files"
          aria-label="Attach files"
        >
          <Paperclip size={16} />
        </button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />

        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => {
            const val = e.target.value;
            setInput(val);
            setShowCommandMenu(val === "/" || (val.startsWith("/") && val.length <= 10 && !val.includes(" ")));
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={uploading}
          rows={1}
          placeholder={uploading ? "Uploading..." : "Type / for commands, or send instruction..."}
          className="flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-sm text-zinc-900 dark:text-white
                     resize-none focus:outline-none focus:ring-2 focus:ring-blue-600 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 max-h-[120px]"
        />
        <button
          onClick={handleSend}
          disabled={uploading || (!input.trim() && pendingFiles.length === 0)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 disabled:text-zinc-400 dark:disabled:text-zinc-500
                     text-white text-sm font-medium rounded transition-colors cursor-pointer"
        >
          {uploading ? "..." : "Send"}
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
  roomId,
  loading,
  hasMore,
  loadingOlder,
  onLoadOlder,
}: {
  committed: CommittedEvent[];
  streamingText: string | null;
  streamingThinking: string | null;
  agentName: string;
  roomId?: string;
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const prevEventCount = useRef(0);
  const prevScrollHeight = useRef(0);
  const initialScrollDone = useRef(false);
  const [newPrependCount, setNewPrependCount] = useState(0);
  const prevCommittedLen = useRef(committed.length);
  const hasVisibleContent = committed.some(
    (e) => e.type === "message" || e.type === "tool" || e.type === "user_steer" || e.type === "thinking" || e.type === "agent_reply" || e.type === "system",
  );

  // Initial scroll to bottom (instant)
  useEffect(() => {
    if (committed.length > 0 && !initialScrollDone.current) {
      bottomRef.current?.scrollIntoView();
      initialScrollDone.current = true;
      prevEventCount.current = committed.length;
    }
  }, [committed.length]);

  // Auto-scroll on new events (only if near bottom)
  useEffect(() => {
    const added = committed.length - prevEventCount.current;
    if (added > 0 && isNearBottom.current && initialScrollDone.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevEventCount.current = committed.length;
  }, [committed.length]);

  // Also scroll on streaming updates if near bottom
  useEffect(() => {
    if (isNearBottom.current && (streamingText || streamingThinking)) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [streamingText, streamingThinking]);

  // Scroll position preservation when older events prepended
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !loadingOlder) return;
    prevScrollHeight.current = el.scrollHeight;
  }, [loadingOlder]);

  useEffect(() => {
    if (loadingOlder === false && prevScrollHeight.current > 0) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight - prevScrollHeight.current;
        prevScrollHeight.current = 0;
      }
      // Detect prepended events for slide-in animation
      const prepended = committed.length - prevCommittedLen.current;
      if (prepended > 0) {
        setNewPrependCount(prepended);
        setTimeout(() => setNewPrependCount(0), 600);
      }
    }
    prevCommittedLen.current = committed.length;
  }, [committed.length, loadingOlder]);

  // Scroll handler — auto-load older (debounced at scrollTop=0) + track near-bottom
  const loadOlderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (el.scrollTop === 0 && hasMore && !loadingOlder) {
      if (!loadOlderTimer.current) {
        loadOlderTimer.current = setTimeout(() => {
          loadOlderTimer.current = null;
          if (containerRef.current && containerRef.current.scrollTop === 0) onLoadOlder();
        }, 300);
      }
    } else if (loadOlderTimer.current) {
      clearTimeout(loadOlderTimer.current);
      loadOlderTimer.current = null;
    }
  }, [hasMore, loadingOlder, onLoadOlder]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const stickToBottomIfNeeded = () => {
      if (isNearBottom.current) {
        container.scrollTop = container.scrollHeight;
      }
    };

    const contentRO = new ResizeObserver(stickToBottomIfNeeded);
    contentRO.observe(content);

    const containerRO = new ResizeObserver(stickToBottomIfNeeded);
    containerRO.observe(container);

    return () => {
      contentRO.disconnect();
      containerRO.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3 text-sm" onScroll={handleScroll}>
      <div ref={contentRef} className="space-y-2">
        {hasMore === false && hasVisibleContent && (
          <div className="text-center text-xs text-zinc-400 dark:text-zinc-600 py-2">Beginning of activity</div>
        )}
        {loadingOlder && (
          <div className="flex items-center justify-center gap-1.5 py-2">
            <Loader2 size={14} className="animate-spin text-zinc-400" />
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Loading earlier events</span>
          </div>
        )}
        {!hasVisibleContent && streamingText === null && (
          <div className="text-zinc-600 text-center py-8">
            {loading ? "Loading history..." : "Waiting for agent activity..."}
          </div>
        )}
        {committed.map((event, i) => {
          const isNewPrepend = i < newPrependCount;
          const animDelay = isNewPrepend ? `${Math.min(i, 10) * 30}ms` : undefined;
          return (
            <div key={i} className={isNewPrepend ? "msg-enter" : undefined} style={animDelay ? { animationDelay: animDelay } : undefined}>
              <ActivityItem event={event} agentName={agentName} roomId={roomId} />
            </div>
          );
        })}
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
    </div>
  );
}

const TS_CLS = "text-[11px] text-zinc-400 dark:text-zinc-600 tabular-nums";

function ActivityItem({ event, agentName, roomId }: { event: CommittedEvent; agentName: string; roomId?: string }) {
  const ts = event.ts ? formatTime(event.ts) : undefined;
  const fullTs = event.ts ? new Date(event.ts).toLocaleString() : undefined;
  const inlineTs = ts ? <span className={`${TS_CLS} ml-2 hidden md:inline`} title={fullTs}>{ts}</span> : null;

  switch (event.type) {
    case "agent_start":
      return <div className="text-[11px] text-zinc-500 flex items-center gap-1">▶ Agent started {inlineTs}</div>;
    case "agent_end":
      return <div className="text-[11px] text-zinc-500 flex items-center gap-1">■ Agent finished {inlineTs}</div>;
    case "thinking":
      return <ThinkingCard thinking={event.thinking || ""} time={ts} fullTime={fullTs} />;
    case "message":
      return <MessageCard text={event.text || ""} time={ts} fullTime={fullTs} />;
    case "tool":
      return <ToolCard event={event} time={ts} fullTime={fullTs} />;
    case "user_steer":
      return <MessageBubble sender="user" content={event.text || ""} time={ts} fullTime={fullTs} roomId={roomId} />;
    case "agent_reply":
      return <MessageCard text={event.text || ""} label="DM Reply" time={ts} fullTime={fullTs} />;
    case "system":
      return <MessageBubble sender="system" content={event.text || ""} time={ts} fullTime={fullTs} roomId={roomId} />;
    default:
      return null;
  }
}

// ============================================================================
// Shared UI components
// ============================================================================

function MessageCard({ text, label, time, fullTime }: { text: string; label?: string; time?: string; fullTime?: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 md:py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className="text-blue-400">💬</span>
        {label && <span className="text-blue-500 font-medium shrink-0">{label}</span>}
        <span className="text-zinc-400 truncate max-w-[160px] md:max-w-md">{preview}</span>
        {time && <span className={`${TS_CLS} ml-auto shrink-0 hidden md:inline`} title={fullTime}>{time}</span>}
        <span className={`${time ? "ml-2" : "ml-auto"} text-zinc-700`}>{expanded ? "▼" : "▶"}</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-zinc-800 text-sm text-zinc-300">
          <Markdown content={text} />
        </div>
      )}
    </div>
  );
}

function ThinkingCard({ thinking, isStreaming, time, fullTime }: { thinking: string; isStreaming?: boolean; time?: string; fullTime?: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 md:py-1.5 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className={isStreaming ? "animate-pulse" : ""}>💭</span>
        <span>{isStreaming ? "Thinking..." : "Thought process"}</span>
        {time && <span className={`${TS_CLS} ml-auto shrink-0 hidden md:inline`} title={fullTime}>{time}</span>}
        <span className={`${time ? "ml-2" : "ml-auto"} text-zinc-700`}>{expanded ? "▼" : "▶"}</span>
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

function ToolCard({ event, time, fullTime }: { event: CommittedEvent; time?: string; fullTime?: string }) {
  const [expanded, setExpanded] = useState(false);
  const isDone = event.result !== undefined;
  const statusColor = !isDone ? "text-amber-500" : event.isError ? "text-red-400" : "text-emerald-400";
  const statusIcon = !isDone ? "⏳" : event.isError ? "✗" : "✓";
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2.5 md:py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer"
      >
        <span className={statusColor}>{statusIcon}</span>
        <span className="text-zinc-400 font-mono">{event.toolName}</span>
        <span className="text-zinc-600 truncate max-w-[80px] md:max-w-48">{truncateArgs(event.args)}</span>
        {time && <span className={`${TS_CLS} ml-auto shrink-0 hidden md:inline`} title={fullTime}>{time}</span>}
        <span className={`${time ? "ml-2" : "ml-auto"} text-zinc-700`}>{expanded ? "▼" : "▶"}</span>
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
