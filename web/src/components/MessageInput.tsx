import { useCurrentMemberName } from "../hooks/useMemberProfileRevision";
import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type DragEvent,
  type ClipboardEvent,
} from "react";
import {
  Paperclip,
  CornerUpLeft,
  X,
  AtSign,
  ArrowUp,
  Loader2,
} from "lucide-react";
import { useDraft } from "../hooks/useDraft";
import { useUpload } from "../hooks/useUpload";
import { AttachmentUploader } from "./AttachmentUploader";

/** Detect an open @ mention menu at the cursor. */
export function detectMentionTrigger(
  textBeforeCursor: string,
): { trigger: "@"; filter: string } | null {
  const atMatch = textBeforeCursor.match(/@([\p{L}\p{N}_-]*)$/u);
  if (atMatch) return { trigger: "@", filter: atMatch[1].toLowerCase() };
  return null;
}

interface MessageInputProps {
  onSend: (
    content: string,
    attachments?: Array<{
      storedFilename: string;
      originalFilename: string;
      size?: number;
    }>,
  ) => void | Promise<void>;
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
  /** Active quote reply: strip above the input, cancelable. */
  quote?: {
    seq: number;
    sender: string;
    senderMemberId?: string;
    excerpt: string;
  } | null;
  onClearQuote?: () => void;
  scopeLabel?: string;
  mentionRequest?: { name: string; nonce: number } | null;
}

/** Format a clipboard image filename: clipboard-YYYYMMDD-HHmmss.png */
function clipboardFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `clipboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

export function MessageInput({
  onSend,
  members,
  memberHints = {},
  disabled,
  roomId,
  onError,
  draftKey,
  hideMentions = false,
  hideAttachments = false,
  uploadScope,
  placeholder,
  quote,
  onClearQuote,
  scopeLabel,
  mentionRequest,
}: MessageInputProps) {
  const quoteName = useCurrentMemberName(
    quote?.senderMemberId,
    quote?.sender ?? "message",
  );
  const [value, setValue, clearDraft] = useDraft(
    draftKey !== undefined ? draftKey : roomId ? `room:${roomId}` : null,
  );
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [mentionIdx, setMentionIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Drop duplicate Enter/clicks while the send request is still in flight (room lag). */
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!mentionRequest || !members.includes(mentionRequest.name)) return;
    setValue(
      value +
        (value && !value.endsWith(" ") ? " " : "") +
        `@${mentionRequest.name} `,
    );
    setShowMentions(false);
    inputRef.current?.focus();
  }, [mentionRequest]);

  const upload = useUpload(onError, roomId ? `room:${roomId}` : null);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Mention menu navigation takes priority when open
    if (showMentions && filteredMembers.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % filteredMembers.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx(
          (i) => (i - 1 + filteredMembers.length) % filteredMembers.length,
        );
        return;
      }
      if (
        (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) ||
        e.key === "Tab"
      ) {
        e.preventDefault();
        insertMention(filteredMembers[mentionIdx] ?? filteredMembers[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
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
          requestAnimationFrame(() => {
            el.selectionStart = el.selectionEnd = start + 1;
          });
        }
      } else {
        e.preventDefault();
        handleSend();
      }
    }
    if (e.key === "Escape" && showMentions) setShowMentions(false);
  };

  const handleSend = async () => {
    if (sendingRef.current || disabled) return;
    const trimmed = value.trim();
    if (!trimmed && !upload.hasPending) return;
    const scope = uploadScope ?? roomId;
    if (!scope && upload.hasPending) return;

    let content = trimmed;

    const attachments: Array<{
      storedFilename: string;
      originalFilename: string;
      size?: number;
    }> = [];

    sendingRef.current = true;
    setSending(true);
    try {
      // Upload pending files
      if (upload.hasPending && scope) {
        const results = await upload.uploadAll(scope);
        for (const r of results) {
          attachments.push({
            storedFilename: r.filename,
            originalFilename: r.originalFilename,
            size: r.size,
          });
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
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const handleChange = (text: string) => {
    setValue(text);
    if (hideMentions) return;
    const cursorPos = inputRef.current?.selectionStart || text.length;
    const hit = detectMentionTrigger(text.slice(0, cursorPos));
    if (hit) {
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
    const replaced = textBeforeCursor.replace(
      /@[\p{L}\p{N}_-]*$/u,
      `@${name} `,
    );
    setValue(replaced + textAfterCursor);
    setShowMentions(false);
    inputRef.current?.focus();
  };

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (hideAttachments) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file)
            imageFiles.push(
              new File([file], clipboardFilename(), { type: file.type }),
            );
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        upload.addFiles(imageFiles);
      }
    },
    [upload.addFiles],
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);
  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);
  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (hideAttachments) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) upload.addFiles(files);
    },
    [upload.addFiles, hideAttachments],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) upload.addFiles(files);
      e.target.value = "";
    },
    [upload.addFiles],
  );

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const scrollH = el.scrollHeight;
    const newHeight = Math.min(Math.max(scrollH, 61), 160);
    el.style.height = newHeight + "px";
    el.style.overflowY = scrollH > 160 ? "auto" : "hidden";
  }, [value]);

  const mentionChoices = ["all", ...members];
  const filteredMembers = mentionChoices.filter((m) =>
    m.toLowerCase().startsWith(mentionFilter),
  );

  useEffect(() => {
    if (showMentions) setMentionIdx(0);
  }, [showMentions, mentionFilter]);

  return (
    <div
      data-tour="composer"
      className={`bm-composer-wrap ${dragOver ? "bg-accent-dim" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Quote reply strip */}
      {quote && (
        <div className="flex items-center gap-2 mb-2 pl-2.5 pr-2 py-1.5 border-l-2 border-accent bg-accent-dim/60 rounded-r-lg">
          <CornerUpLeft size={12} className="text-accent-ink shrink-0" />
          <span className="text-xs text-ink-2 truncate">
            Reply to{" "}
            <span className="font-semibold text-accent-ink">{quoteName}</span>
            <span className="font-mono text-[10px] text-ink-4 ml-1">
              #{quote.seq}
            </span>
            <span className="text-ink-3">：{quote.excerpt}</span>
          </span>
          <button
            type="button"
            onClick={onClearQuote}
            title="Cancel reply"
            aria-label="Cancel reply"
            className="ml-auto shrink-0 text-ink-4 hover:text-ink-1 cursor-pointer"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Mention autocomplete */}
      {showMentions && filteredMembers.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention suggestions"
          className="bm-mention-pop"
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
                <span className="font-mono">@{name}</span>
                {name === "all" ? (
                  <span
                    className={`ml-2 text-xs ${active ? "text-accent-ink/80" : "text-ink-4"}`}
                  >
                    activate all members
                  </span>
                ) : memberHints[name] ? (
                  <span
                    className={`ml-2 text-xs ${active ? "text-accent-ink/80" : "text-ink-4"}`}
                  >
                    {memberHints[name]}
                  </span>
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
          <span className="text-accent-ink text-sm font-medium">
            Drop files here
          </span>
        </div>
      )}

      <div className="bm-composer-box">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled || upload.isUploading || sending}
          placeholder={
            upload.isUploading
              ? "正在上传…"
              : (placeholder ?? "发消息，@ 选择成员")
          }
          aria-label="消息"
          rows={1}
          className="bm-composer-textarea"
        />
        <div className="bm-compose-bottom">
          {!hideAttachments && (
            <>
              <button
                type="button"
                className="bm-icon-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || upload.isUploading}
                title="添加附件"
                aria-label="添加附件"
              >
                <Paperclip size={17} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
            </>
          )}
          {!hideMentions && (
            <button
              type="button"
              className="bm-icon-btn"
              aria-label="提及成员"
              onClick={() => {
                const next =
                  value + (value && !value.endsWith(" ") ? " " : "") + "@";
                setValue(next);
                setMentionFilter("");
                setShowMentions(true);
                inputRef.current?.focus();
              }}
            >
              <AtSign size={17} />
            </button>
          )}
          <span className="bm-composer-tip">
            {hideMentions ? "私聊会直接叫到成员" : "@ 才会叫到成员"}
          </span>
          <button
            type="button"
            className="bm-send"
            onClick={handleSend}
            disabled={
              disabled ||
              sending ||
              upload.isUploading ||
              (!value.trim() && !upload.hasPending)
            }
            aria-label="发送消息"
            title="发送消息"
          >
            {sending || upload.isUploading ? (
              <Loader2 size={17} className="animate-spin" />
            ) : (
              <ArrowUp size={18} />
            )}
          </button>
        </div>
      </div>
      <div className="bm-composer-foot">
        <span>{scopeLabel ? `发送到 ${scopeLabel}` : ""}</span>
        <span>Enter 发送 · Shift + Enter 换行</span>
      </div>
    </div>
  );
}
