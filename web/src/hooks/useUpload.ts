// Upload state management hook — pending files, progress, abort
import { useState, useRef, useCallback, useEffect } from "react";
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

type UploadDraftStore = {
  items: UploadItem[];
  abortRefs: Map<string, AbortController>;
  listeners: Set<() => void>;
};

const keyedStores = new Map<string, UploadDraftStore>();

function isImageFile(f: File): boolean {
  return f.type.startsWith("image/");
}

function createUploadItem(file: File): UploadItem {
  return {
    id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    file,
    preview: isImageFile(file) ? URL.createObjectURL(file) : undefined,
    status: "pending",
    progress: 0,
  };
}

function getKeyedStore(key: string): UploadDraftStore {
  let store = keyedStores.get(key);
  if (!store) {
    store = { items: [], abortRefs: new Map(), listeners: new Set() };
    keyedStores.set(key, store);
  }
  return store;
}

function notify(store: UploadDraftStore): void {
  for (const listener of store.listeners) listener();
}

function revokePreview(item: UploadItem): void {
  if (item.preview) URL.revokeObjectURL(item.preview);
}

function updateKeyedItems(key: string, updater: (prev: UploadItem[], store: UploadDraftStore) => UploadItem[]): void {
  const store = getKeyedStore(key);
  store.items = updater(store.items, store);
  notify(store);
}

export function clearAttachmentDraftForTests(key: string): void {
  const store = keyedStores.get(key);
  if (!store) return;
  store.items.forEach(revokePreview);
  store.abortRefs.forEach((c) => c.abort());
  keyedStores.delete(key);
}

export function getAttachmentDraftItemsForTests(key: string): UploadItem[] {
  return keyedStores.get(key)?.items ?? [];
}

export function addAttachmentDraftFilesForTests(key: string, files: File[]): UploadItem[] {
  updateKeyedItems(key, (prev) => [...prev, ...files.map(createUploadItem)]);
  return getAttachmentDraftItemsForTests(key);
}

export function useUpload(onError?: (msg: string) => void, draftKey?: string | null) {
  const [localItems, setLocalItems] = useState<UploadItem[]>([]);
  const localAbortRefs = useRef<Map<string, AbortController>>(new Map());
  const [keyedItems, setKeyedItems] = useState<UploadItem[]>(() => draftKey ? getKeyedStore(draftKey).items : []);

  useEffect(() => {
    if (!draftKey) return;
    const store = getKeyedStore(draftKey);
    const listener = () => setKeyedItems([...store.items]);
    store.listeners.add(listener);
    listener();
    return () => { store.listeners.delete(listener); };
  }, [draftKey]);

  const items = draftKey ? keyedItems : localItems;
  const setItems = useCallback((updater: (prev: UploadItem[], abortRefs: Map<string, AbortController>) => UploadItem[]) => {
    if (draftKey) {
      updateKeyedItems(draftKey, (prev, store) => updater(prev, store.abortRefs));
      return;
    }
    setLocalItems((prev) => updater(prev, localAbortRefs.current));
  }, [draftKey]);

  const getAbortRefs = useCallback(() => draftKey ? getKeyedStore(draftKey).abortRefs : localAbortRefs.current, [draftKey]);

  const addFiles = useCallback((files: File[]) => {
    const oversized = files.filter((f) => f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      const names = oversized.map((f) => f.name).join(", ");
      const maxGB = Math.round(MAX_FILE_SIZE / 1024 / 1024 / 1024);
      onError?.(`File too large (max ${maxGB}GB): ${names}`);
      return;
    }
    setItems((prev) => [...prev, ...files.map(createUploadItem)]);
  }, [onError, setItems]);

  const removeItem = useCallback((id: string) => {
    setItems((prev, abortRefs) => {
      const target = prev.find((i) => i.id === id);
      if (target) revokePreview(target);
      abortRefs.get(id)?.abort();
      abortRefs.delete(id);
      return prev.filter((i) => i.id !== id);
    });
  }, [setItems]);

  const clearAll = useCallback(() => {
    setItems((prev, abortRefs) => {
      prev.forEach(revokePreview);
      abortRefs.forEach((c) => c.abort());
      abortRefs.clear();
      return [];
    });
  }, [setItems]);

  /** Remove only successfully-uploaded items; keep pending / uploading / error / cancelled. */
  const clearSuccessful = useCallback(() => {
    setItems((prev) => {
      prev.filter((i) => i.status === "done").forEach(revokePreview);
      return prev.filter((i) => i.status !== "done");
    });
  }, [setItems]);

  /** Cancel all in-flight uploads (uploading status). Pending/done/error untouched. */
  const cancelAll = useCallback(() => {
    getAbortRefs().forEach((c) => c.abort());
  }, [getAbortRefs]);

  /** Reset an errored / cancelled item back to pending so it can be retried via uploadAll. */
  const retryItem = useCallback((id: string) => {
    setItems((prev) => prev.map((i) =>
      i.id === id && (i.status === "error" || i.status === "cancelled")
        ? { ...i, status: "pending" as const, progress: 0, error: undefined }
        : i,
    ));
  }, [setItems]);

  /** Upload all pending items sequentially. Returns results for successful uploads. */
  const uploadAll = useCallback(async (scope: string): Promise<UploadResult[]> => {
    const pending = items.filter((i) => i.status === "pending");
    const results: UploadResult[] = [];

    for (const item of pending) {
      const ctrl = new AbortController();
      getAbortRefs().set(item.id, ctrl);

      setItems((prev) => prev.map((i) => i.id === item.id ? { ...i, status: "uploading" as const } : i));

      try {
        const result = await uploadWithProgress(scope, item.file, {
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
        getAbortRefs().delete(item.id);
      }
    }

    return results;
  }, [items, onError, setItems, getAbortRefs]);

  const hasPending = items.some((i) => i.status === "pending");
  const isUploading = items.some((i) => i.status === "uploading");

  return { items, addFiles, removeItem, retryItem, clearAll, clearSuccessful, cancelAll, uploadAll, hasPending, isUploading };
}
