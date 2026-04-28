import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type DragEvent, type ClipboardEvent } from "react";
import { Paperclip } from "lucide-react";
import { useDraft } from "../hooks/useDraft";
import { useUpload } from "../hooks/useUpload";
import { AttachmentUploader } from "./AttachmentUploader";

interface MessageInputProps {
  onSend: (content: string) => void;
  members: string[];
  disabled?: boolean;
  roomId?: string;
  onError?: (message: string) => void;
}

/** Format a clipboard image filename: clipboard-YYYYMMDD-HHmmss.png */
function clipboardFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `clipboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

export function MessageInput({ onSend, members, disabled, roomId, onError }: MessageInputProps) {
  const [value, setValue, clearDraft] = useDraft(roomId ? `room:${roomId}` : null);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionIdx, setMentionIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useUpload(onError);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention menu navigation takes priority when open
    if (showMentions && filteredMembers.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((i) => (i + 1) % filteredMembers.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((i) => (i - 1 + filteredMembers.length) % filteredMembers.length); return; }
      if ((e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        e.preventDefault();
        insertMention(filteredMembers[mentionIdx] ?? filteredMembers[0]);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setShowMentions(false); return; }
    }

    if (e.key === "Enter") {
      if (e.shiftKey) {
        // Shift+Enter: newline (browser default)
      } else if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const el = inputRef.current;
        if (el) {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          const newVal = value.slice(0, start) + "\n" + value.slice(end);
          setValue(newVal);
          requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 1; });
        }
      } else {
        e.preventDefault();
        handleSend();
      }
    }
    if (e.key === "Escape" && showMentions) setShowMentions(false);
  };

  const handleSend = async () => {
    const trimmed = value.trim();
    if (!trimmed && !upload.hasPending) return;
    if (!roomId && upload.hasPending) return;

    let content = trimmed;

    // Upload pending files
    if (upload.hasPending && roomId) {
      const results = await upload.uploadAll(roomId);
      if (results.length > 0) {
        const lines = results.map((r) =>
          `Attachment: [original filename: ${r.originalFilename}](${r.path})`,
        );
        content = content ? `${content}\n${lines.join("\n")}` : lines.join("\n");
      }
      upload.clearAll();
    }

    if (content) onSend(content);
    clearDraft();
    setShowMentions(false);
  };

  const handleChange = (text: string) => {
    setValue(text);
    const cursorPos = inputRef.current?.selectionStart || text.length;
    const textBeforeCursor = text.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@([\w-]*)$/);
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
    const replaced = textBeforeCursor.replace(/@[\w-]*$/, `@${name} `);
    setValue(replaced + textAfterCursor);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(new File([file], clipboardFilename(), { type: file.type }));
      }
    }
    if (imageFiles.length > 0) { e.preventDefault(); upload.addFiles(imageFiles); }
  }, [upload.addFiles]);

  const handleDragOver = useCallback((e: DragEvent) => { e.preventDefault(); setDragOver(true); }, []);
  const handleDragLeave = useCallback((e: DragEvent) => { e.preventDefault(); setDragOver(false); }, []);
  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) upload.addFiles(files);
  }, [upload.addFiles]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) upload.addFiles(files);
    e.target.value = "";
  }, [upload.addFiles]);

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

  useEffect(() => {
    if (showMentions) setMentionIdx(0);
  }, [showMentions, mentionFilter]);

  return (
    <div
      className={`relative border-t border-zinc-200 dark:border-zinc-800 p-3 pb-[max(12px,env(safe-area-inset-bottom))] ${dragOver ? "bg-blue-50 dark:bg-blue-900/20 border-blue-400 dark:border-blue-600" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Mention autocomplete */}
      {showMentions && filteredMembers.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention suggestions"
          className="absolute bottom-full left-3 right-3 mb-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg overflow-hidden max-h-60 overflow-y-auto"
        >
          {filteredMembers.map((name, idx) => {
            const active = idx === mentionIdx;
            return (
              <button
                key={name}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setMentionIdx(idx)}
                onClick={() => insertMention(name)}
                className={`w-full text-left px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                  active
                    ? "bg-blue-50 dark:bg-blue-600/20 text-blue-700 dark:text-blue-300"
                    : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
                }`}
              >
                @{name}
                {name === "all" && (
                  <span className={`ml-2 text-xs ${active ? "text-blue-500/80 dark:text-blue-400/80" : "text-zinc-400 dark:text-zinc-500"}`}>activate all agents</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Attachment upload area */}
      <AttachmentUploader items={upload.items} onRemove={upload.removeItem} disabled={disabled} />

      {/* Drag overlay hint */}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-50/80 dark:bg-blue-900/40 rounded pointer-events-none z-10">
          <span className="text-blue-600 dark:text-blue-400 text-sm font-medium">Drop files here</span>
        </div>
      )}

      <div className="flex gap-2 items-end">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || upload.isUploading}
          className="w-11 h-11 md:w-9 md:h-9 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 transition-colors cursor-pointer shrink-0"
          title="Attach files"
          aria-label="Attach files"
        >
          <Paperclip size={18} />
        </button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled || upload.isUploading}
          placeholder={upload.isUploading ? "Uploading..." : "Type a message... (@ to mention, Ctrl+V to paste image)"}
          rows={1}
          className="flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-base md:text-sm text-zinc-900 dark:text-white
                     resize-none focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent
                     placeholder:text-zinc-400 dark:placeholder:text-zinc-600 disabled:opacity-50 max-h-[200px]"
        />
        <button
          onClick={handleSend}
          disabled={disabled || upload.isUploading || (!value.trim() && !upload.hasPending)}
          className="min-h-[44px] md:min-h-0 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 disabled:text-zinc-400 dark:disabled:text-zinc-500
                     text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          {upload.isUploading ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
