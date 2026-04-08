import { useEffect, useRef, useCallback } from "react";
import type { RoomMessage } from "../api/client";
import { MessageBubble } from "./MessageBubble";
import { SummaryCard } from "./SummaryCard";

interface ChatAreaProps {
  messages: RoomMessage[];
  roomName: string;
  roomId?: string;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
}

const GROUP_INTERVAL_MS = 5 * 60 * 1000;

export function ChatArea({ messages, roomName, roomId, hasMore, loadingOlder, onLoadOlder }: ChatAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMsgCount = useRef(messages.length);
  const isNearBottom = useRef(true);

  // Auto-scroll to bottom on new messages (only if user was near bottom)
  useEffect(() => {
    const added = messages.length - prevMsgCount.current;
    if (added > 0 && added < 5 && isNearBottom.current) {
      // New message appended — scroll to bottom
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMsgCount.current = messages.length;
  }, [messages.length]);

  // Initial scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [roomName]);

  // Scroll position preservation when older messages are prepended
  const prevScrollHeight = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !loadingOlder) return;
    prevScrollHeight.current = el.scrollHeight;
  }, [loadingOlder]);

  useEffect(() => {
    if (loadingOlder === false && prevScrollHeight.current > 0) {
      const el = containerRef.current;
      if (el) {
        const newHeight = el.scrollHeight;
        el.scrollTop = newHeight - prevScrollHeight.current;
        prevScrollHeight.current = 0;
      }
    }
  }, [messages.length, loadingOlder]);

  // Scroll handler — detect near-top for loading older, track near-bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    // Track if user is near bottom
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;

    // Load older when near top
    if (el.scrollTop < 50 && hasMore && !loadingOlder && onLoadOlder) {
      onLoadOlder();
    }
  }, [hasMore, loadingOlder, onLoadOlder]);

  return (
    <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3" onScroll={handleScroll}>
      {/* Top indicator */}
      {hasMore === false && messages.length > 0 && (
        <div className="text-center text-xs text-zinc-400 dark:text-zinc-600 py-4">Beginning of conversation</div>
      )}
      {loadingOlder && (
        <div className="text-center text-xs text-zinc-400 dark:text-zinc-500 py-3 animate-pulse">Loading older messages...</div>
      )}

      {messages.length === 0 ? (
        <div className="h-full flex items-center justify-center">
          <div className="text-center">
            <p className="text-zinc-400 dark:text-zinc-500 text-lg"># {roomName}</p>
            <p className="text-zinc-400 dark:text-zinc-600 text-sm mt-1">
              Start a conversation by sending a message
            </p>
          </div>
        </div>
      ) : (
        <div>
          {messages.map((msg, i) => {
            const prev = i > 0 ? messages[i - 1] : null;
            const showDateSep = shouldShowDateSeparator(prev, msg);
            const grouped = isGroupedWithPrev(prev, msg);

            const time = new Date(msg.ts).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const fullTime = new Date(msg.ts).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });

            return (
              <div key={msg.id}>
                {showDateSep && <DateSeparator ts={msg.ts} />}
                {msg.type === "summary" ? (
                  <SummaryCard message={msg} roomId={roomId || ""} />
                ) : (
                  <MessageBubble
                    sender={msg.sender}
                    content={msg.content}
                    time={time}
                    fullTime={fullTime}
                    grouped={grouped}
                    isMarkdown={msg.sender !== "user" && msg.sender !== "system"}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function shouldShowDateSeparator(prev: RoomMessage | null, current: RoomMessage): boolean {
  if (!prev) return true;
  return new Date(prev.ts).toDateString() !== new Date(current.ts).toDateString();
}

function isGroupedWithPrev(prev: RoomMessage | null, current: RoomMessage): boolean {
  if (!prev) return false;
  if (prev.sender !== current.sender) return false;
  if (current.ts - prev.ts > GROUP_INTERVAL_MS) return false;
  if (new Date(prev.ts).toDateString() !== new Date(current.ts).toDateString()) return false;
  return true;
}

function DateSeparator({ ts }: { ts: number }) {
  const date = new Date(ts);
  const formatted = date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
      <span className="text-xs text-zinc-400 dark:text-zinc-600">{formatted}</span>
      <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
    </div>
  );
}
