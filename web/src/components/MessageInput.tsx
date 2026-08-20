import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type DragEvent, type ClipboardEvent } from "react";
import { Paperclip, CornerUpLeft, X, MessageSquarePlus } from "lucide-react";
import { useDraft } from "../hooks/useDraft";
import { useUpload } from "../hooks/useUpload";
import { AttachmentUploader } from "./AttachmentUploader";

/**
 * Detect an open mention menu at the cursor. `@` keeps the long-standing
 * behavior; `!` shares the menu interaction (fish 2026-08-05) with the
 * parser's left-boundary rule — "Hello!" never pops the menu.
 */
export function detectMentionTrigger(textBeforeCursor: string): { trigger: "@" | "!"; filter: string } | null {
  const atMatch = textBeforeCursor.match(/@([\w-]*)$/);
  if (atMatch) return { trigger: "@", filter: atMatch[1].toLowerCase() };
  const bangMatch = textBeforeCursor.match(/(?:^|[^\w!])!([\w-]*)$/);
  if (bangMatch) return { trigger: "!", filter: bangMatch[1].toLowerCase() };
  return null;
}

interface MessageInputProps {
  onSend: (content: string, attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>) => void | Promise<void>;
  members: string[];
  memberHints?: Record<string, string>;
  disabled?: boolean;
  roomId?: string;
  onError?: (message: string) => void;
  /** Override the draft storage key (default `room:${roomId}`). Pass null to disable drafts. */
  draftKey?: string | null;
  /** Hide the @ mention autocomplete (e.g. DM — everything activates the member directly). */
  hideMentions?: boolean;
  /** Hide paperclip/paste/drop attachment handling (no upload route for this scope yet). */
  hideAttachments?: boolean;
  /** Upload scope override (default roomId). Pass "dm:<memberId>" for DM uploads. */
  uploadScope?: string;
  placeholder?: string;
  /** Active quote reply (topic-threads-v1 spec ①): strip above the input, cancelable. */
  quote?: { seq: number; sender: string; excerpt: string } | null;
  /** Topic-creation mode (topic-threads v2 spec ①): room composer only — toggle button left of the textarea; one-shot, the sent message opens the topic. */
  topicMode?: { active: boolean; onToggle: () => void };
  onClearQuote?: () => void;
}

/** Format a clipboard image filename: clipboard-YYYYMMDD-HHmmss.png */
function clipboardFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `clipboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

export function MessageInput({ onSend, members, memberHints = {}, disabled, roomId, onError, draftKey, hideMentions = false, hideAttachments = false, uploadScope, placeholder, quote, onClearQuote, topicMode }: MessageInputProps) {
  const [value, setValue, clearDraft] = useDraft(draftKey !== undefined ? draftKey : roomId ? `room:${roomId}` : null);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionIdx, setMentionIdx] = useState(0);
  // Which gesture opened the member menu — @ (queued mention, offers "all")
  // or ! (urgent interrupt, members only — `!all` is not a thing).
  const [mentionTrigger, setMentionTrigger] = useState<"@" | "!">("@");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const upload = useUpload(onError, roomId ? `room:${roomId}` : null);

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
    const scope = uploadScope ?? roomId;
    if (!scope && upload.hasPending) return;

    let content = trimmed;

    const attachments: Array<{ storedFilename: string; originalFilename: string; size?: number }> = [];

    // Upload pending files
    if (upload.hasPending && scope) {
      const results = await upload.uploadAll(scope);
      for (const r of results) {
        attachments.push({ storedFilename: r.filename, originalFilename: r.originalFilename, size: r.size });
      }
      // Only clear successful uploads — keep errored/cancelled items so user can retry.
      upload.clearSuccessful();
    }

    if (!content && attachments.length === 0) return;

    // Only clear the draft after a successful send. If auth expired / network
    // failed mid-send, keep localStorage draft so re-login restores the text.
    try {
      await onSend(content, attachments.length > 0 ? attachments : undefined);
      clearDraft();
      setShowMentions(false);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  };

  const handleChange = (text: string) => {
    setValue(text);
    if (hideMentions) return;
    const cursorPos = inputRef.current?.selectionStart || text.length;
    const hit = detectMentionTrigger(text.slice(0, cursorPos));
    if (hit) {
      setMentionTrigger(hit.trigger);
      setShowMentions(true);
      setMentionFilter(hit.filter);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (name: string) => {
    const cursorPos = inputRef.current?.selectionStart || value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    const textAfterCursor = value.slice(cursorPos);
    const replaced = mentionTrigger === "!"
      ? textBeforeCursor.replace(/![\w-]*$/, `!${name} `)
      : textBeforeCursor.replace(/@[\w-]*$/, `@${name} `);
    setValue(replaced + textAfterCursor);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (hideAttachments) return;
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
    if (hideAttachments) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) upload.addFiles(files);
  }, [upload.addFiles, hideAttachments]);

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

  const mentionChoices = mentionTrigger === "!" ? members : ["all", ...members];
  const filteredMembers = mentionChoices.filter((m) =>
    m.toLowerCase().startsWith(mentionFilter),
  );

  useEffect(() => {
    if (showMentions) setMentionIdx(0);
  }, [showMentions, mentionFilter]);

  return (
    <div
      data-tour="composer"
      className={`relative border-t p-3 pb-[max(12px,env(safe-area-inset-bottom))] transition-colors ${dragOver ? "bg-accent-dim border-accent" : topicMode?.active ? "border-accent/40" : "border-line-soft"}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Quote reply strip */}
      {quote && (
        <div className="flex items-center gap-2 mb-2 pl-2.5 pr-2 py-1.5 border-l-2 border-accent bg-accent-dim/60 rounded-r-lg">
          <CornerUpLeft size={12} className="text-accent-ink shrink-0" />
          <span className="text-xs text-ink-2 truncate">
            Reply to <span className="font-semibold text-accent-ink">{quote.sender}</span>
            <span className="font-mono text-[10px] text-ink-4 ml-1">#{quote.seq}</span>
            <span className="text-ink-3">：{quote.excerpt}</span>
          </span>
          <button type="button" onClick={onClearQuote} title="Cancel reply" aria-label="Cancel reply" className="ml-auto shrink-0 text-ink-4 hover:text-ink-1 cursor-pointer">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Topic-creation mode hint */}
      {topicMode?.active && (
        <div className="flex items-center gap-2 mb-2 pl-2.5 pr-2 py-1.5 border-l-2 border-accent bg-accent-dim/60 rounded-r-lg">
          <MessageSquarePlus size={12} className="text-accent-ink shrink-0" />
          <span className="text-xs text-ink-2 truncate">
            <span className="font-semibold text-accent-ink">New topic</span>
            <span className="text-ink-3"> — this message opens the topic as its first message; @ members join instantly. One-shot.</span>
          </span>
          <button type="button" onClick={topicMode.onToggle} title="Cancel topic mode" aria-label="Cancel topic mode" className="ml-auto shrink-0 text-ink-4 hover:text-ink-1 cursor-pointer">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Mention autocomplete */}
      {showMentions && filteredMembers.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention suggestions"
          className="absolute bottom-full left-3 right-3 mb-1 bg-surface-3 border border-line-strong rounded-lg overflow-hidden max-h-60 overflow-y-auto"
          style={{ boxShadow: "var(--shadow-pop)" }}
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
                    ? "bg-accent-dim text-accent-ink"
                    : "text-ink-2 hover:bg-surface-2"
                }`}
              >
                <span className="font-mono">{mentionTrigger}{name}</span>
                {name === "all" ? (
                  <span className={`ml-2 text-xs ${active ? "text-accent-ink/80" : "text-ink-4"}`}>activate all members</span>
                ) : memberHints[name] ? (
                  <span className={`ml-2 text-xs ${active ? "text-accent-ink/80" : "text-ink-4"}`}>{memberHints[name]}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      {/* Attachment upload area */}
      {!hideAttachments && (
        <AttachmentUploader
          items={upload.items}
          onRemove={upload.removeItem}
          onRetry={upload.retryItem}
          onCancelAll={upload.cancelAll}
          disabled={disabled}
        />
      )}

      {/* Drag overlay hint */}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-accent-dim rounded pointer-events-none z-10">
          <span className="text-accent-ink text-sm font-medium">Drop files here</span>
        </div>
      )}

      <div className="flex gap-2 items-end">
        {topicMode && (
          <button
            onClick={topicMode.onToggle}
            disabled={disabled}
            className={`w-11 h-11 md:w-9 md:h-9 flex items-center justify-center rounded-lg transition-colors cursor-pointer shrink-0 ${topicMode.active ? "text-accent-ink bg-accent-dim" : "text-ink-4 hover:text-ink-2 hover:bg-surface-2"}`}
            title={topicMode.active ? "Cancel topic mode" : "Start a topic with this message"}
            aria-label={topicMode.active ? "Cancel topic mode" : "Start a topic with this message"}
            aria-pressed={topicMode.active}
          >
            <MessageSquarePlus size={18} />
          </button>
        )}
        {!hideAttachments && (
          <>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || upload.isUploading}
              className="w-11 h-11 md:w-9 md:h-9 flex items-center justify-center rounded-lg text-ink-4 hover:text-ink-2 hover:bg-surface-2 disabled:opacity-50 transition-colors cursor-pointer shrink-0"
              title="Attach files"
              aria-label="Attach files"
            >
              <Paperclip size={18} />
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
          </>
        )}

        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled || upload.isUploading}
          placeholder={upload.isUploading ? "Uploading..." : (placeholder ?? "Type a message... (@ to mention, Ctrl+V to paste image)")}
          rows={1}
          className={`flex-1 bg-inset border rounded-lg px-3 py-2 text-base md:text-sm text-ink-1
                     resize-none focus:outline-none
                     placeholder:text-ink-4 disabled:opacity-50 max-h-[200px] transition-colors
                     ${topicMode?.active ? "border-accent ring-1 ring-accent/30 focus:border-accent" : "border-line focus:border-accent focus:ring-1 focus:ring-accent/25"}`}
        />
        <button
          onClick={handleSend}
          disabled={disabled || upload.isUploading || (!value.trim() && !upload.hasPending)}
          className="min-h-[44px] md:min-h-0 px-4 py-2 bg-accent text-accent-contrast disabled:opacity-40
                     text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
        >
          {upload.isUploading ? "..." : "Send"}
        </button>
      </div>
      {/* W1-4 (assistant-ui Composer, fish-picked 2026-08-20): persistent shortcut hint */}
      <div className="mt-1.5 pr-1 text-right text-[10px] text-ink-4 select-none">⏎ send · ⇧⏎ newline · @ mention</div>
    </div>
  );
}
