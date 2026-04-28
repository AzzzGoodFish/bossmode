// Attachment upload UI — pending list with progress bars, cancel, error states
import { X, FileText, Check, AlertCircle, RotateCw } from "lucide-react";
import type { UploadItem } from "../hooks/useUpload";

interface AttachmentUploaderProps {
  items: UploadItem[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const stateClasses: Record<string, string> = {
  pending: "border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900",
  uploading: "border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-900/10",
  done: "border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-900/10",
  error: "border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10",
  cancelled: "border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/20 opacity-50",
};

function UploadRow({ item, onRemove }: { item: UploadItem; onRemove: () => void }) {
  const pct = Math.round(item.progress * 100);
  return (
    <div className={`relative group/row flex items-center gap-2 px-2.5 py-1.5 rounded-md border transition-colors overflow-hidden ${stateClasses[item.status] || stateClasses.pending}`}>
      {/* Progress bar — bottom line */}
      {item.status === "uploading" && (
        <div
          className="absolute bottom-0 left-0 h-0.5 bg-blue-500 transition-all duration-150"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
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
          {item.status === "error" && <><AlertCircle size={10} className="text-red-500" /><span className="text-red-500 truncate">{item.error || "Failed"}</span></>}
          {item.status === "cancelled" && <span className="text-zinc-400">Cancelled</span>}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {item.status === "uploading" && (
          <button onClick={onRemove} className="text-[10px] text-zinc-400 hover:text-red-500 transition-colors" title="Cancel upload">
            <X size={14} />
          </button>
        )}
        {(item.status === "pending" || item.status === "done" || item.status === "cancelled") && (
          <button onClick={onRemove} className="opacity-0 group-hover/row:opacity-100 text-zinc-400 hover:text-red-500 transition-opacity" title="Remove">
            <X size={14} />
          </button>
        )}
        {item.status === "error" && (
          <button onClick={onRemove} className="text-zinc-400 hover:text-red-500 transition-colors" title="Remove">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AttachmentUploader({ items, onRemove, disabled }: AttachmentUploaderProps) {
  if (items.length === 0) return null;

  const uploading = items.filter((i) => i.status === "uploading").length;

  return (
    <div className="flex flex-col gap-1 mb-2">
      {items.length > 1 && (
        <div className="text-[10px] text-zinc-400 px-1">
          Attachments ({items.length}){uploading > 0 && ` · ${uploading} uploading`}
        </div>
      )}
      {items.map((item) => (
        <UploadRow key={item.id} item={item} onRemove={() => onRemove(item.id)} />
      ))}
    </div>
  );
}
