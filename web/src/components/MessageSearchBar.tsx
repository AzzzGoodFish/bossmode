import { useEffect, useRef, useState, useCallback } from "react";
import { Search, X } from "lucide-react";
import type { MessageSearchResult, RoomMessage } from "../api/client";
import { searchMessages } from "../api/client";

interface MessageSearchBarProps {
  roomId: string;
  members: string[];
  onJumpToMessage: (messageId: string) => void;
  onClose: () => void;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const re = new RegExp(`(${escapeRegex(query)})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        re.test(p) ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-700/60 rounded-sm">{p}</mark>
        ) : p
      )}
    </>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function MessageSearchBar({ roomId, members, onJumpToMessage, onClose }: MessageSearchBarProps) {
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [dateRange, setDateRange] = useState<"all" | "today" | "7d" | "30d">("all");
  const [result, setResult] = useState<MessageSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(() => {
    const q = queryRef.current.trim();
    if (!q && !from && dateRange === "all") {
      setResult(null);
      return;
    }
    setLoading(true);
    const now = Date.now();
    const afterMs =
      dateRange === "today" ? new Date().setHours(0, 0, 0, 0) :
      dateRange === "7d" ? now - 7 * 86400_000 :
      dateRange === "30d" ? now - 30 * 86400_000 :
      undefined;
    searchMessages(roomId, {
      query: q || undefined,
      from: from || undefined,
      after: typeof afterMs === "number" ? afterMs : undefined,
      limit: 50,
    })
      .then(setResult)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [roomId, from, dateRange]);

  // Debounce query input
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doSearch, 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, doSearch]);

  // Immediate search on filter change
  useEffect(() => { doSearch(); }, [from, dateRange, doSearch]);

  // Focus on open + Escape handler
  useEffect(() => {
    inputRef.current?.focus();
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col shrink-0">
      {/* Search controls */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Search size={14} className="text-zinc-400 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages..."
          className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none"
        />
        {/* Sender filter */}
        <select
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 text-zinc-700 dark:text-zinc-300 cursor-pointer focus:outline-none"
        >
          <option value="">All senders</option>
          {members.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {/* Date range filter */}
        <select
          value={dateRange}
          onChange={(e) => setDateRange(e.target.value as typeof dateRange)}
          className="text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 text-zinc-700 dark:text-zinc-300 cursor-pointer focus:outline-none"
        >
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer p-0.5">
          <X size={14} />
        </button>
      </div>

      {/* Results */}
      {(result || loading) && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 max-h-72 overflow-y-auto">
          {loading && (
            <div className="text-center py-4 text-xs text-zinc-400">Searching…</div>
          )}
          {!loading && result && result.total === 0 && (
            <div className="text-center py-4 text-xs text-zinc-400">No results</div>
          )}
          {!loading && result && result.total > 0 && (
            <>
              <div className="px-3 py-1.5 text-[10px] text-zinc-500 border-b border-zinc-100 dark:border-zinc-800">
                {result.total} result{result.total === 1 ? "" : "s"}
                {result.total > 50 ? " (showing 50)" : ""}
              </div>
              {result.messages.map((msg) => (
                <MessageResult
                  key={msg.id}
                  msg={msg}
                  query={query.trim()}
                  onJump={() => onJumpToMessage(msg.id)}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MessageResult({ msg, query, onJump }: { msg: RoomMessage; query: string; onJump: () => void }) {
  const preview = msg.content.slice(0, 120) + (msg.content.length > 120 ? "…" : "");
  return (
    <button
      onClick={onJump}
      className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 border-b border-zinc-100 dark:border-zinc-900 cursor-pointer"
    >
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{msg.sender}</span>
        <span className="text-[10px] text-zinc-400 tabular-nums">{formatTs(msg.ts)}</span>
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed truncate">
        {highlight(preview, query)}
      </div>
    </button>
  );
}
