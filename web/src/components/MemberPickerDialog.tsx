import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { RoomContact } from "../api/client";
import { getMembers } from "../api/client";
import { Sheet } from "./Sheet";
import { StaffBadge } from "./StaffBadge";
import { userActionError } from "../utils/user-error";

interface MemberPickerDialogProps {
  open: boolean;
  onClose: () => void;
  selectedMemberIds: string[];
  onPickMember: (member: RoomContact) => void;
}

export type ContactLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; contacts: RoomContact[] };

export function contactDisplayState(state: ContactLoadState): "loading" | "error" | "empty" | "items" {
  if (state.status !== "ready") return state.status;
  return state.contacts.length === 0 ? "empty" : "items";
}

/** Each opening reads current contacts rather than reusing a previous picker snapshot. */
export function MemberPickerDialog(props: MemberPickerDialogProps) {
  return props.open ? <OpenMemberPicker {...props} /> : null;
}

function OpenMemberPicker({ onClose, selectedMemberIds, onPickMember }: MemberPickerDialogProps) {
  const [state, setState] = useState<ContactLoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    getMembers().then(
      (contacts) => { if (active) setState({ status: "ready", contacts }); },
      () => { if (active) setState({ status: "error", message: userActionError("load contacts") }); },
    );
    return () => { active = false; };
  }, [attempt]);

  const displayState = contactDisplayState(state);
  const contacts = state.status === "ready" ? state.contacts : [];
  const selected = new Set(selectedMemberIds);

  return (
    <Sheet open onClose={onClose} size="lg" closeOnOverlayClick>
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink-1">Add member</h2>
          <p className="mt-0.5 text-xs text-ink-4">Choose an existing contact. Create new members from the Chats panel first.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close member picker" className="rounded-md p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1">
          <X size={18} />
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
        {displayState === "loading" ? (
          <p role="status" className="py-6 text-center text-sm text-ink-4">Loading contacts…</p>
        ) : state.status === "error" ? (
          <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
            <span>{state.message}</span>
            <button type="button" onClick={() => setAttempt((value) => value + 1)} className="rounded border border-blocked/40 px-2 py-1">Retry</button>
          </div>
        ) : displayState === "empty" ? (
          <p className="py-6 text-center text-sm text-ink-4">No contacts yet. Create a member from the Chats panel, then return here.</p>
        ) : (
          <div className="space-y-2">
            {contacts.every((member) => selected.has(member.id)) && (
              <p className="text-xs text-ink-4">Every contact is already selected.</p>
            )}
            {contacts.map((member) => (
              <button
                key={member.id}
                type="button"
                data-contact-id={member.id}
                disabled={selected.has(member.id)}
                onClick={() => {
                  if (selected.has(member.id)) return;
                  onPickMember(member);
                  onClose();
                }}
                className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-1 px-3.5 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-50"
              >
                <StaffBadge name={member.name} avatar={member.avatar} status="idle" size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate whitespace-pre text-sm font-semibold text-ink-1">{member.name}</span>
                  {member.title && <span className="mt-0.5 block truncate text-xs text-ink-4">{member.title}</span>}
                </span>
                {selected.has(member.id) && <span className="text-xs text-ink-4">Selected</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}
