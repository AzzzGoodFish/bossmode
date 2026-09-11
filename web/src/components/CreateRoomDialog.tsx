import { useReducer, useRef, useState, type FormEvent } from "react";
import { Crown, Plus, Trash2, Users, X } from "lucide-react";
import type { RoomContact } from "../api/client";
import { getMembers } from "../api/client";
import { MemberPickerDialog } from "./MemberPickerDialog";
import { Sheet } from "./Sheet";

export interface RoomContactSelection {
  members: RoomContact[];
  leaderMemberId: string;
}

type SelectionAction =
  | { type: "add"; member: RoomContact }
  | { type: "remove"; memberId: string }
  | { type: "leader"; memberId: string };

export function roomContactSelection(state: RoomContactSelection, action: SelectionAction): RoomContactSelection {
  switch (action.type) {
    case "add":
      if (state.members.some((member) => member.id === action.member.id)) return state;
      return { members: [...state.members, action.member], leaderMemberId: state.leaderMemberId || action.member.id };
    case "remove": {
      const members = state.members.filter((member) => member.id !== action.memberId);
      return { members, leaderMemberId: members.some((member) => member.id === state.leaderMemberId) ? state.leaderMemberId : members[0]?.id || "" };
    }
    case "leader":
      return state.members.some((member) => member.id === action.memberId) ? { ...state, leaderMemberId: action.memberId } : state;
  }
}

interface CreateRoomDialogProps {
  onClose: () => void;
  onSubmit: (name: string, memberIds: string[], leaderMemberId: string) => Promise<void>;
}

function memberInitials(name: string): string {
  const bits = name.split(/[-_.\s]+/).filter(Boolean);
  if (bits.length > 1) return `${bits[0][0] || ""}${bits[1][0] || ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function CreateRoomDialog({ onClose, onSubmit }: CreateRoomDialogProps) {
  const [name, setName] = useState("");
  const [{ members, leaderMemberId }, dispatch] = useReducer(roomContactSelection, { members: [], leaderMemberId: "" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const close = () => { if (!submitting.current) onClose(); };
  const canSubmit = Boolean(name.trim() && members.length > 0 && members.some((member) => member.id === leaderMemberId));

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setSubmitAttempted(true);
    setSubmitError(null);
    if (!canSubmit) return;
    submitting.current = true;
    setSaving(true);
    try {
      // Refresh before sending; the server also validates membership atomically.
      const currentIds = new Set((await getMembers()).map((member) => member.id));
      if (members.some((member) => !currentIds.has(member.id))) {
        throw new Error("A selected contact is no longer available. Remove unavailable contacts and choose again.");
      }
      await onSubmit(name.trim(), members.map((member) => member.id), leaderMemberId);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Couldn’t create the Room. Your selections are still here.");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <Sheet open onClose={close} size="2xl" closeOnOverlayClick={false}>
      <form onSubmit={handleSubmit}>
        <fieldset disabled={saving}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
            <div>
              <h2 className="text-lg font-semibold text-ink-1">Create Room</h2>
            </div>
            <button type="button" onClick={close} aria-label="Close Create Room" className="rounded-md p-1.5 text-ink-4 hover:bg-surface-2 hover:text-ink-1">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-6 p-6">
            <section aria-labelledby="room-details-heading">
              <div className="mb-3 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-ink-3">1</span>
                <h3 id="room-details-heading" className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Room details</h3>
              </div>
              <div className="grid gap-4 md:grid-cols-[0.8fr_1.2fr]">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-ink-3">Room name</span>
                  <input
                    autoComplete="off"
                    value={name}
                    onChange={(event) => { setName(event.target.value); setSubmitError(null); }}
                    autoFocus
                    className={`w-full rounded-lg border bg-inset px-3 py-2.5 text-sm text-ink-1 outline-none transition-colors ${submitAttempted && !name.trim() ? "border-blocked" : "border-line focus:border-line-strong"}`}
                    placeholder="e.g., Product launch"
                  />
                  {submitAttempted && !name.trim() && <p className="text-[11px] text-blocked">Enter a Room name.</p>}
                </label>
              </div>
            </section>

            <section aria-labelledby="members-heading">
              <div className="mb-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-ink-3">2</span>
                  <h3 id="members-heading" className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Members</h3>
                  {members.length > 0 && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-ink-3">{members.length}</span>}
                </div>
                {members.length > 0 && (
                  <button type="button" onClick={() => setPickerOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:border-line-strong hover:bg-surface-2">
                    <Plus size={14} /> Add member
                  </button>
                )}
              </div>

              <div className={`rounded-xl border ${submitAttempted && members.length === 0 ? "border-blocked" : "border-line"} bg-inset p-2`}>
                {members.length === 0 ? (
                  <div className="flex min-h-40 flex-col items-center justify-center px-4 py-6 text-center">
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-ink-4"><Users size={19} /></div>
                    <p className="text-sm font-medium text-ink-2">No members yet</p>
                    <p className="mt-1 text-xs text-ink-4">Choose existing contacts. Create new members from the Chats panel first.</p>
                    <button type="button" onClick={() => setPickerOpen(true)} className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-accent-contrast hover:opacity-90">
                      <Plus size={14} /> Add member
                    </button>
                  </div>
                ) : (
                  <div role="list" aria-label="Selected room members" className="space-y-1.5">
                    {members.map((member) => (
                      <div key={member.id} role="listitem" data-member-id={member.id} className="group flex min-h-14 items-center gap-3 rounded-lg border border-transparent bg-surface-1 px-3 py-2 hover:border-line-soft">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-soft bg-surface-2 font-mono text-[10px] font-semibold text-ink-3">
                          {memberInitials(member.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate whitespace-pre font-mono text-sm font-semibold text-ink-1">{member.name}</span>
                            <span className="truncate text-xs text-ink-4">{member.title}</span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-ink-4">
                            Existing contact. Settings are unchanged.
                          </div>
                        </div>
                        {leaderMemberId === member.id && (
                          <span className="hidden items-center gap-1 rounded-full bg-think/10 px-2 py-1 text-[10px] font-medium text-think sm:flex"><Crown size={10} /> Leader</span>
                        )}
                        <div className="flex shrink-0 items-center gap-1">
                          <button type="button" onClick={() => dispatch({ type: "remove", memberId: member.id })} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-4 hover:bg-blocked/10 hover:text-blocked"><Trash2 size={12} /> Remove</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {submitAttempted && members.length === 0 && <p className="mt-1.5 text-[11px] text-blocked">Add at least one member.</p>}

              {members.length > 0 && (
                <div className="mt-3 grid gap-3 rounded-lg border border-line-soft bg-surface-1 p-3 md:grid-cols-[1fr_1fr] md:items-center">
                  <label className="flex items-center justify-end gap-2 text-xs text-ink-3">
                    <span className="flex items-center gap-1.5 whitespace-nowrap"><Crown size={12} className="text-think" /> Room leader</span>
                    <select value={leaderMemberId} onChange={(event) => dispatch({ type: "leader", memberId: event.target.value })} className="min-w-0 max-w-52 flex-1 rounded-md border border-line bg-inset px-2.5 py-1.5 font-mono text-xs text-ink-1 outline-none focus:border-line-strong">
                      {members.map((member) => <option key={member.id} value={member.id} className="whitespace-pre">{member.name}</option>)}
                    </select>
                  </label>
                </div>
              )}
            </section>

            {submitError && (
              <div role="alert" className="rounded-lg border border-blocked/40 bg-blocked/10 px-3 py-2.5">
                <p className="text-sm font-medium text-blocked">Couldn’t create this Room</p>
                <p className="mt-0.5 text-xs text-ink-3">{submitError}</p>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-1 px-6 py-4">
            <div className="ml-auto flex gap-2">
              <button type="button" onClick={close} className="rounded-lg px-4 py-2 text-sm text-ink-4 hover:bg-surface-2 hover:text-ink-1">Cancel</button>
              <button
                type="submit"
                disabled={saving}
                aria-disabled={!canSubmit || saving}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${canSubmit ? "bg-accent text-accent-contrast hover:opacity-90" : "bg-surface-3 text-ink-3 hover:text-ink-2"}`}
              >
                {saving ? "Creating…" : "Create Room"}
              </button>
            </div>
          </div>
        </fieldset>
      </form>

      <MemberPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        selectedMemberIds={members.map((member) => member.id)}
        onPickMember={(member) => dispatch({ type: "add", member })}
      />
    </Sheet>
  );
}
