import { useState, useRef, useEffect, useCallback, type KeyboardEvent, type DragEvent, type ClipboardEvent } from "react";
import { Paperclip, X } from "lucide-react";
import { uploadFile } from "../api/client";

interface PendingFile {
  file: File;
  preview?: string; // data URL for image preview
}

interface MessageInputProps {
  onSend: (content: string) => void;
  members: string[];
  disabled?: boolean;
  roomId?: string;
}

/** Format a clipboard image filename: clipboard-YYYYMMDD-HHmmss.png */
function clipboardFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `clipboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

/** Check if a file is an image */
function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function MessageInput({ onSend, members, disabled, roomId }: MessageInputProps) {
  const [value, setValue] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Per-room draft caching: save/restore input when switching rooms
  const drafts = useRef<Map<string, string>>(new Map());
  const prevRoomId = useRef<string | undefined>(roomId);
  useEffect(() => {
    if (prevRoomId.current !== roomId) {
      // Save current draft for previous room
      if (prevRoomId.current) drafts.current.set(prevRoomId.current, value);
      // Restore draft for new room (or empty)
      setValue(roomId ? (drafts.current.get(roomId) ?? "") : "");
      prevRoomId.current = roomId;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  const addFiles = useCallback((files: File[]) => {
    const newPending: PendingFile[] = files.map((file) => {
      const pending: PendingFile = { file };
      if (isImageFile(file)) {
        pending.preview = URL.createObjectURL(file);
      }
      return pending;
    });
    setPendingFiles((prev) => [...prev, ...newPending]);
  }, []);

  const removeFile = useCallback((idx: number) => {
    setPendingFiles((prev) => {
      const removed = prev[idx];
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      pendingFiles.forEach((pf) => { if (pf.preview) URL.revokeObjectURL(pf.preview); });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        // Shift+Enter: browser default inserts newline — do nothing
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+Enter: manually insert newline (browser doesn't do this by default)
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
        // Bare Enter: send
        e.preventDefault();
        handleSend();
      }
    }
    if (e.key === "Escape" && showMentions) {
      setShowMentions(false);
    }
  };

  const handleSend = async () => {
    const trimmed = value.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    if (!roomId && pendingFiles.length > 0) return; // need roomId for upload

    let content = trimmed;

    // Upload pending files
    if (pendingFiles.length > 0 && roomId) {
      setUploading(true);
      try {
        const attachmentLines: string[] = [];
        for (const pf of pendingFiles) {
          const result = await uploadFile(roomId, pf.file);
          attachmentLines.push(`Attachment: [original filename: ${result.originalFilename}](${result.path})`);
        }
        const attachmentText = attachmentLines.join("\n");
        content = content ? `${content}\n${attachmentText}` : attachmentText;
      } catch (err: any) {
        console.error("Upload failed:", err);
        setUploading(false);
        return;
      }
      // Clean up previews
      pendingFiles.forEach((pf) => { if (pf.preview) URL.revokeObjectURL(pf.preview); });
      setPendingFiles([]);
      setUploading(false);
    }

    if (content) {
      onSend(content);
    }
    setValue("");
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

  // Paste handler — detect clipboard images
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          // Create a new File with a generated name (clipboard items have no name)
          const named = new File([file], clipboardFilename(), { type: file.type });
          imageFiles.push(named);
        }
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault(); // prevent pasting image as text
      addFiles(imageFiles);
    }
  }, [addFiles]);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) addFiles(files);
  }, [addFiles]);

  // File input change handler
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) addFiles(files);
    // Reset input so same file can be selected again
    e.target.value = "";
  }, [addFiles]);

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

  const hasPending = pendingFiles.length > 0;

  return (
    <div
      className={`relative border-t border-zinc-200 dark:border-zinc-800 p-3 pb-[max(12px,env(safe-area-inset-bottom))] ${dragOver ? "bg-blue-50 dark:bg-blue-900/20 border-blue-400 dark:border-blue-600" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Mention autocomplete */}
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

      {/* File preview area */}
      {hasPending && (
        <div className="flex flex-wrap gap-2 mb-2">
          {pendingFiles.map((pf, idx) => (
            <div key={idx} className="relative group">
              {pf.preview ? (
                <img
                  src={pf.preview}
                  alt={pf.file.name}
                  className="w-16 h-16 object-cover rounded border border-zinc-300 dark:border-zinc-600"
                />
              ) : (
                <div className="w-16 h-16 flex items-center justify-center rounded border border-zinc-300 dark:border-zinc-600 bg-zinc-100 dark:bg-zinc-700">
                  <span className="text-[10px] text-zinc-500 dark:text-zinc-400 text-center px-1 truncate">{pf.file.name.split(".").pop()}</span>
                </div>
              )}
              <button
                onClick={() => removeFile(idx)}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 hover:bg-red-400 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              >
                <X size={10} />
              </button>
              <div className="text-[9px] text-zinc-500 dark:text-zinc-400 truncate max-w-16 mt-0.5">{pf.file.name}</div>
            </div>
          ))}
        </div>
      )}

      {/* Drag overlay hint */}
      {dragOver && (
        <div className="absolute inset-0 flex items-center justify-center bg-blue-50/80 dark:bg-blue-900/40 rounded pointer-events-none z-10">
          <span className="text-blue-600 dark:text-blue-400 text-sm font-medium">Drop files here</span>
        </div>
      )}

      <div className="flex gap-2 items-end">
        {/* Attachment button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-50 transition-colors cursor-pointer shrink-0"
          title="Attach files"
        >
          <Paperclip size={18} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled || uploading}
          placeholder={uploading ? "Uploading..." : "Type a message... (@ to mention, Ctrl+V to paste image)"}
          rows={1}
          className="flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 text-base md:text-sm text-zinc-900 dark:text-white
                     resize-none focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent
                     placeholder:text-zinc-400 dark:placeholder:text-zinc-600 disabled:opacity-50 max-h-[200px]"
        />
        <button
          onClick={handleSend}
          disabled={disabled || uploading || (!value.trim() && !hasPending)}
          className="min-h-[44px] md:min-h-0 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 disabled:text-zinc-400 dark:disabled:text-zinc-500
                     text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          {uploading ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
