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
  pending:   "border-line bg-surface-1",
  uploading: "border-accent/40 bg-accent-dim",
  done:      "border-onair/40 bg-onair-dim",
  error:     "border-blocked/40 bg-blocked-dim",
  cancelled: "border-line-soft bg-surface-0/40 opacity-60",
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
          className="absolute bottom-0 left-0 h-0.5 bg-accent transition-all duration-150"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Uploading ${item.file.name}`}
        />
      )}

      {/* Thumbnail / icon */}
      <div className="w-8 h-8 rounded shrink-0 flex items-center justify-center bg-surface-2 overflow-hidden">
        {item.preview
          ? <img src={item.preview} alt={item.file.name} className="w-full h-full object-cover" />
          : <FileText size={14} className="text-ink-3" />}
      </div>

      {/* File name + status */}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-ink-2 truncate" title={item.file.name}>{item.file.name}</div>
        <div className="text-[10px] text-ink-3 tabular-nums flex items-center gap-1.5">
          {item.status === "pending" && <span>{formatSize(item.file.size)}</span>}
          {item.status === "uploading" && <><span>{pct}%</span><span>·</span><span>{formatSize(item.file.size)}</span></>}
          {item.status === "done" && <><Check size={10} className="text-onair" /><span>{formatSize(item.file.size)}</span></>}
          {item.status === "error" && (
            <>
              <AlertCircle size={10} className="text-blocked shrink-0" />
              <span className="text-blocked truncate" title={item.error || "Failed"}>{item.error || "Failed"}</span>
            </>
          )}
          {item.status === "cancelled" && <span className="text-ink-4">Cancelled</span>}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {isUploading && (
          <button
            onClick={onRemove}
            title="Cancel upload"
            aria-label="Cancel upload"
            className="px-1.5 h-6 flex items-center gap-1 text-[10px] rounded text-ink-3 hover:text-blocked hover:bg-blocked-dim transition-colors cursor-pointer"
          >
            <X size={11} /> Cancel
          </button>
        )}

        {isError && onRetry && (
          <button
            onClick={onRetry}
            title="Retry upload"
            aria-label="Retry upload"
            className="w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-accent-ink hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <RotateCw size={12} />
          </button>
        )}

        {!isUploading && (
          <button
            onClick={onRemove}
            title="Remove"
            aria-label="Remove"
            className={`w-6 h-6 flex items-center justify-center rounded text-ink-4 hover:text-ink-1 hover:bg-surface-2 transition-all cursor-pointer ${
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
        <div className="flex items-center gap-2 text-[11px] text-ink-3 px-0.5 mb-0.5">
          <Paperclip size={11} className="shrink-0" />
          <span>{items.length} attachment{items.length === 1 ? "" : "s"}</span>
          {uploadingCount > 0 && (
            <>
              <span className="text-ink-4">·</span>
              <span className="text-accent-ink">{uploadingCount} uploading</span>
            </>
          )}
          {errorCount > 0 && (
            <>
              <span className="text-ink-4">·</span>
              <span className="text-blocked">{errorCount} failed</span>
            </>
          )}
          {canCancelAll && (
            <button
              onClick={onCancelAll}
              className="ml-auto text-ink-3 hover:text-blocked underline-offset-2 hover:underline cursor-pointer"
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
