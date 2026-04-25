import { useState, useEffect, useCallback } from "react";

const PREFIX = "bossmode.draft.";

/**
 * Persistent draft hook backed by localStorage.
 * The draft is keyed by `key` (e.g. "room:<roomId>" or "agent:<roomId>:<agentName>").
 * A null key keeps the draft in transient state only (no persistence).
 *
 * Returns [value, setValue, clearDraft].
 * Call clearDraft() after a successful send to remove the persisted draft.
 */
export function useDraft(key: string | null): [string, (v: string) => void, () => void] {
  const storageKey = key ? PREFIX + key : null;

  const [value, setValue] = useState<string>(() =>
    storageKey ? (localStorage.getItem(storageKey) ?? "") : "",
  );

  // Reload from localStorage when key changes (e.g. switch room or agent)
  useEffect(() => {
    setValue(storageKey ? (localStorage.getItem(storageKey) ?? "") : "");
  }, [storageKey]);

  const setAndPersist = useCallback((v: string) => {
    setValue(v);
    if (!storageKey) return;
    if (v) {
      localStorage.setItem(storageKey, v);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  const clear = useCallback(() => setAndPersist(""), [setAndPersist]);

  return [value, setAndPersist, clear];
}
