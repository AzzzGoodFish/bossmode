// Upload state management hook — pending files, progress, abort
import { useState, useRef, useCallback } from "react";
import { uploadWithProgress, UploadError, type UploadResult } from "../api/upload-client";

export type UploadStatus = "pending" | "uploading" | "done" | "error" | "cancelled";

export interface UploadItem {
  id: string;
  file: File;
  preview?: string;
  status: UploadStatus;
  progress: number;       // 0-1
  error?: string;
  result?: UploadResult;
}

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB — matches server

function isImageFile(f: File): boolean {
  return f.type.startsWith("image/");
}

export function useUpload(onError?: (msg: string) => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const abortRefs = useRef<Map<string, AbortController>>(new Map());

  const addFiles = useCallback((files: File[]) => {
    const oversized = files.filter((f) => f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      const names = oversized.map((f) => f.name).join(", ");
      const maxGB = Math.round(MAX_FILE_SIZE / 1024 / 1024 / 1024);
      onError?.(`File too large (max ${maxGB}GB): ${names}`);
      return;
    }
    setItems((prev) => [
      ...prev,
      ...files.map((file) => ({
        id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        file,
        preview: isImageFile(file) ? URL.createObjectURL(file) : undefined,
        status: "pending" as const,
        progress: 0,
      })),
    ]);
  }, [onError]);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      abortRefs.current.get(id)?.abort();
      abortRefs.current.delete(id);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems((prev) => {
      prev.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
      abortRefs.current.forEach((c) => c.abort());
      abortRefs.current.clear();
      return [];
    });
  }, []);

  /** Remove only successfully-uploaded items; keep pending / uploading / error / cancelled. */
  const clearSuccessful = useCallback(() => {
    setItems((prev) => {
      prev.filter((i) => i.status === "done")
        .forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
      return prev.filter((i) => i.status !== "done");
    });
  }, []);

  /** Cancel all in-flight uploads (uploading status). Pending/done/error untouched. */
  const cancelAll = useCallback(() => {
    abortRefs.current.forEach((c) => c.abort());
  }, []);

  /** Reset an errored / cancelled item back to pending so it can be retried via uploadAll. */
  const retryItem = useCallback((id: string) => {
    setItems((prev) => prev.map((i) =>
      i.id === id && (i.status === "error" || i.status === "cancelled")
        ? { ...i, status: "pending" as const, progress: 0, error: undefined }
        : i,
    ));
  }, []);

  /** Upload all pending items sequentially. Returns results for successful uploads. */
  const uploadAll = useCallback(async (roomId: string): Promise<UploadResult[]> => {
    const pending = items.filter((i) => i.status === "pending");
    const results: UploadResult[] = [];

    for (const item of pending) {
      const ctrl = new AbortController();
      abortRefs.current.set(item.id, ctrl);

      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "uploading" as const } : i));

      try {
        const result = await uploadWithProgress(roomId, item.file, {
          signal: ctrl.signal,
          onProgress: (loaded, total) => {
            setItems((prev) => prev.map((i) =>
              i.id === item.id ? { ...i, progress: total > 0 ? loaded / total : 0 } : i,
            ));
          },
        });
        setItems((prev) => prev.map((i) =>
          i.id === item.id ? { ...i, status: "done" as const, progress: 1, result } : i,
        ));
        results.push(result);
      } catch (err) {
        const isAbort = err instanceof UploadError && err.isAbort;
        const message = (err as Error).message || "Upload failed";
        setItems((prev) => prev.map((i) =>
          i.id === item.id ? {
            ...i,
            status: (isAbort ? "cancelled" : "error") as UploadStatus,
            error: isAbort ? undefined : message,
          } : i,
        ));
        if (!isAbort) onError?.(`Upload failed: ${message}`);
      } finally {
        abortRefs.current.delete(item.id);
      }
    }

    return results;
  }, [items, onError]);

  const hasPending = items.some((i) => i.status === "pending");
  const isUploading = items.some((i) => i.status === "uploading");

  return { items, addFiles, removeItem, retryItem, clearAll, clearSuccessful, cancelAll, uploadAll, hasPending, isUploading };
}
