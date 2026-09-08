import { useMemberProfileRevision } from "../hooks/useMemberProfileRevision";
import { useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import type { ContactEntry } from "../api/client";
import { getContacts } from "../api/client";
import { Sheet } from "./Sheet";
import { StaffBadge } from "./StaffBadge";
import { userActionError } from "../utils/user-error";

interface AddMemberDialogProps {
  /** Member ids already in the room (excluded from the list). */
  currentMemberIds: string[];
  /** Invite an existing global member by id (0.20 — room invite, not hire). */
  onAdd: (memberId: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Invite-to-room picker (0.20): rooms are composed from global members —
 * you invite an existing contact. To bring someone new, hire them in
 * Contacts first (New member), then invite here.
 */
export function AddMemberDialog({ currentMemberIds, onAdd, onClose }: AddMemberDialogProps) {
  const profileRevision = useMemberProfileRevision();
  const [contacts, setContacts] = useState<ContactEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    getContacts()
      .then((r) => setContacts(r.contacts))
      .catch((err) => {
        console.error("Failed to load contacts", err);
        setLoadError(userActionError("load contacts"));
      });
  }, [profileRevision]);

  const candidates = useMemo(() => {
    const inRoom = new Set(currentMemberIds);
    return (contacts ?? []).filter((c) => !inRoom.has(c.memberId));
  }, [contacts, currentMemberIds]);

  const invite = async (memberId: string) => {
    setBusyId(memberId);
    setActionError(null);
    try {
      await onAdd(memberId);
      onClose();
    } catch (err) {
      setActionError(String((err as Error)?.message || err));
      setBusyId(null);
    }
  };

  return (
    <Sheet open onClose={onClose} size="lg" closeOnOverlayClick>
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink-1">Add member</h2>
          <p className="mt-0.5 text-xs text-ink-4">New here? Hire members from Contacts first.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1">
          <X size={18} />
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
        {(loadError || actionError) && (
          <div role="alert" className="mb-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
            {loadError || actionError}
          </div>
        )}

        {!contacts ? (
          <p className="py-6 text-center text-sm text-ink-4">Loading contacts…</p>
        ) : candidates.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-4">Every contact is already in this room.</p>
        ) : (
          <div className="space-y-2">
            {candidates.map((c) => (
              <button
                key={c.memberId}
                type="button"
                disabled={busyId !== null}
                onClick={() => void invite(c.memberId)}
                className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-1 px-3.5 py-3 text-left hover:border-line-strong hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50"
              >
                <StaffBadge name={c.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-ink-1">{c.name}</span>
                  {c.title ? <span className="mt-0.5 block truncate text-xs text-ink-4">{c.title}</span> : null}
                </span>
                {busyId === c.memberId && <Loader2 size={14} className="animate-spin text-ink-4 shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
