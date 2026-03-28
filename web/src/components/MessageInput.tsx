import { useState, useRef, useEffect, type KeyboardEvent } from "react";

interface MessageInputProps {
  onSend: (content: string) => void;
  members: string[];
  disabled?: boolean;
}

export function MessageInput({ onSend, members, disabled }: MessageInputProps) {
  const [value, setValue] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Escape" && showMentions) {
      setShowMentions(false);
    }
  };

  const handleSend = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
    setShowMentions(false);
  };

  const handleChange = (text: string) => {
    setValue(text);
    const cursorPos = inputRef.current?.selectionStart || text.length;
    const textBeforeCursor = text.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setShowMentions(true);
      setMentionFilter(atMatch[1].toLowerCase());
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (name: string) => {
    const cursorPos = inputRef.current?.selectionStart || value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const textAfterCursor = value.slice(cursorPos);
    const replaced = textBeforeCursor.replace(/@\w*$/, `@${name} `);
    setValue(replaced + textAfterCursor);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const scrollH = el.scrollHeight;
    const newHeight = Math.min(Math.max(scrollH, 38), 200);
    el.style.height = newHeight + "px";
    el.style.overflowY = scrollH > 200 ? "auto" : "hidden";
  }, [value]);

  const filteredMembers = ["all", ...members].filter((m) =>
    m.toLowerCase().startsWith(mentionFilter),
  );

  return (
    <div className="relative border-t border-zinc-200 dark:border-zinc-800 p-3">
      {showMentions && filteredMembers.length > 0 && (
        <div className="absolute bottom-full left-3 right-3 mb-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg overflow-hidden">
          {filteredMembers.map((name) => (
            <button
              key={name}
              onClick={() => insertMention(name)}
              className="w-full text-left px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
            >
              @{name}
              {name === "all" && (
                <span className="text-zinc-400 dark:text-zinc-500 ml-2 text-xs">activate all agents</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder="Type a message... (@ to mention an agent)"
          rows={1}
          className="flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-900 dark:text-white
                     resize-none focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent
                     placeholder:text-zinc-400 dark:placeholder:text-zinc-600 disabled:opacity-50 max-h-[200px]"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 disabled:text-zinc-400 dark:disabled:text-zinc-500
                     text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          Send
        </button>
      </div>
    </div>
  );
}
