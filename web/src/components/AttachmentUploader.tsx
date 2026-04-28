// Attachment upload UI — pending list with progress bars, cancel, retry, error states
import { X, FileText, Check, AlertCircle, RotateCw, Paperclip } from "lucide-react";
import type { UploadItem } from "../hooks/useUpload";

interface AttachmentUploaderProps {
  items: UploadItem[];
  onRemove: (id: string) => void;
  onRetry?: (id: string) => void;
  onCancelAll?: () => void;
  disabled?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const stateClasses: Record<string, string> = {
  pending:   "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900",
  uploading: "border-blue-300/60 dark:border-blue-700/40 bg-blue-50/60 dark:bg-blue-900/20",
  done:      "border-emerald-300/60 dark:border-emerald-700/40 bg-emerald-50/60 dark:bg-emerald-900/15",
  error:     "border-red-300/60 dark:border-red-700/40 bg-red-50/60 dark:bg-red-900/15",
  cancelled: "border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/20 opacity-60",
};

function UploadRow({
  item, onRemove, onRetry,
}: {
  item: UploadItem;
  onRemove: () => void;
  onRetry?: () => void;
}) {
  const pct = Math.round(item.progress * 100);
  const isUploading = item.status === "uploading";
  const isError = item.status === "error";

  return (
    <div className={`relative group/row flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-colors overflow-hidden ${stateClasses[item.status] || stateClasses.pending}`}>
      {/* Progress bar — bottom line */}
      {isUploading && (
        <div
          className="absolute bottom-0 left-0 h-0.5 bg-blue-500 transition-all duration-150"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Uploading ${item.file.name}`}
        />
      )}

      {/* Thumbnail / icon */}
      <div className="w-8 h-8 rounded shrink-0 flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
        {item.preview
          ? <img src={item.preview} alt={item.file.name} className="w-full h-full object-cover" />
          : <FileText size={14} className="text-zinc-500" />}
      </div>

      {/* File name + status */}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-zinc-700 dark:text-zinc-300 truncate" title={item.file.name}>{item.file.name}</div>
        <div className="text-[10px] text-zinc-500 dark:text-zinc-400 tabular-nums flex items-center gap-1.5">
          {item.status === "pending" && <span>{formatSize(item.file.size)}</span>}
          {item.status === "uploading" && <><span>{pct}%</span><span>·</span><span>{formatSize(item.file.size)}</span></>}
          {item.status === "done" && <><Check size={10} className="text-emerald-500" /><span>{formatSize(item.file.size)}</span></>}
          {item.status === "error" && (
            <>
              <AlertCircle size={10} className="text-red-500 shrink-0" />
              <span className="text-red-500 truncate" title={item.error || "Failed"}>{item.error || "Failed"}</span>
            </>
          )}
          {item.status === "cancelled" && <span className="text-zinc-400">Cancelled</span>}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {isUploading && (
          <button
            onClick={onRemove}
            title="Cancel upload"
            aria-label="Cancel upload"
            className="px-1.5 h-6 flex items-center gap-1 text-[10px] rounded text-zinc-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors cursor-pointer"
          >
            <X size={11} /> Cancel
          </button>
        )}

        {isError && onRetry && (
          <button
            onClick={onRetry}
            title="Retry upload"
            aria-label="Retry upload"
            className="w-6 h-6 flex items-center justify-center rounded text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <RotateCw size={12} />
          </button>
        )}

        {!isUploading && (
          <button
            onClick={onRemove}
            title="Remove"
            aria-label="Remove"
            className={`w-6 h-6 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-all cursor-pointer ${
              item.status === "pending" || item.status === "done" || item.status === "cancelled"
                ? "opacity-0 group-hover/row:opacity-100"
                : ""
            }`}
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AttachmentUploader({ items, onRemove, onRetry, onCancelAll }: AttachmentUploaderProps) {
  if (items.length === 0) return null;

  const uploadingCount = items.filter((i) => i.status === "uploading").length;
  const errorCount = items.filter((i) => i.status === "error").length;
  const showHeader = items.length > 1;
  const canCancelAll = uploadingCount > 1 && !!onCancelAll;

  return (
    <div className="flex flex-col gap-1 mb-2 max-w-full">
      {showHeader && (
        <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400 px-0.5 mb-0.5">
          <Paperclip size={11} className="shrink-0" />
          <span>{items.length} attachment{items.length === 1 ? "" : "s"}</span>
          {uploadingCount > 0 && (
            <>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="text-blue-600 dark:text-blue-400">{uploadingCount} uploading</span>
            </>
          )}
          {errorCount > 0 && (
            <>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="text-red-500 dark:text-red-400">{errorCount} failed</span>
            </>
          )}
          {canCancelAll && (
            <button
              onClick={onCancelAll}
              className="ml-auto text-zinc-500 hover:text-red-500 underline-offset-2 hover:underline cursor-pointer"
            >
              Cancel all
            </button>
          )}
        </div>
      )}
      {items.map((item) => (
        <UploadRow
          key={item.id}
          item={item}
          onRemove={() => onRemove(item.id)}
          onRetry={onRetry ? () => onRetry(item.id) : undefined}
        />
      ))}
    </div>
  );
}
