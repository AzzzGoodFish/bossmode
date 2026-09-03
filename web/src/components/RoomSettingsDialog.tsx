import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Crown, Loader2, Trash2, UserPlus, X } from "lucide-react";
import { Sheet } from "./Sheet";
import { StaffBadge } from "./StaffBadge";
import type { ContactEntry, MemberInfo, Principles, Room } from "../api/client";
import { getRoomMembers, getRoomPrinciples, updateRoomSettings, deleteRoom, getContacts, inviteRoomMember, removeRoomMember } from "../api/client";
import { useDialog } from "./dialogs";
import { Markdown } from "./Markdown";

interface RoomSettingsDialogProps {
  room: Room;
  open: boolean;
  onClose: () => void;
  onSaved: (room: Room) => void;
  onDeleted?: (roomId: string) => void;
}

function normalizeDocsPathInput(value: string): string {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return trimmed ? `${trimmed}/` : "";
}

type PrinciplesPreviewState =
  | { status: "loading" }
  | { status: "ready"; principles: Principles }
  | { status: "error" };

export function promptPreviewDisplayState(state: PrinciplesPreviewState): "loading" | "loaded" | "empty" | "error" {
  if (state.status !== "ready") return state.status;
  return state.principles.content.trim() ? "loaded" : "empty";
}

function PromptPreview({ state, onRetry }: { state: PrinciplesPreviewState; onRetry: () => void }) {
  const displayState = promptPreviewDisplayState(state);
  const content = state.status === "ready" ? state.principles.content.trim() : "";
  return (
    <div className="rounded-lg border border-line bg-inset p-3 min-h-36 max-h-[46vh] overflow-auto">
      {displayState === "loading" ? (
        <div className="text-xs text-ink-4 leading-relaxed">Loading shared guidance…</div>
      ) : displayState === "error" ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-xs text-blocked">
          <span>Couldn’t load shared guidance.</span>
          <button type="button" onClick={onRetry} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked/10">Retry</button>
        </div>
      ) : displayState === "loaded" ? (
        <div className="text-[13px] text-ink-1 leading-relaxed preview-markdown"><Markdown content={content} /></div>
      ) : (
        <div className="text-xs text-ink-4 leading-relaxed">No shared guidance yet.</div>
      )}
    </div>
  );
}

export function RoomSettingsDialog({ room, open, onClose, onSaved, onDeleted }: RoomSettingsDialogProps) {
  const { toast, confirm } = useDialog();
  const [name, setName] = useState(room.name);
  const [leaderId, setLeaderId] = useState<string>(room.promptLeaderMemberId || "");
  const [docsPath, setDocsPath] = useState(room.docsPath || "");
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [memberBusyId, setMemberBusyId] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);
  const [principlesState, setPrinciplesState] = useState<PrinciplesPreviewState>({ status: "loading" });
  const principlesRequestRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPrinciples = useCallback(async () => {
    const request = ++principlesRequestRef.current;
    setPrinciplesState({ status: "loading" });
    try {
      const principles = await getRoomPrinciples(room.id);
      if (request === principlesRequestRef.current) setPrinciplesState({ status: "ready", principles });
    } catch (err) {
      console.error("Failed to load Room prompt", err);
      if (request === principlesRequestRef.current) setPrinciplesState({ status: "error" });
    }
  }, [room.id]);

  useEffect(() => {
    if (!open) return;
    setName(room.name);
    setLeaderId(room.promptLeaderMemberId || "");
    setDocsPath(room.docsPath || "");
    setMembers([]);
    setError(null);
    getRoomMembers(room.id).then(setMembers).catch((err) => { console.error("Failed to load Room members", err); toast("Couldn’t load Room members. Close Settings and try again.", "error"); });
    getContacts().then((r) => setContacts(r.contacts)).catch(() => {});
    void loadPrinciples();
  }, [open, room, toast, loadPrinciples]);

  const refreshMembers = useCallback(async () => {
    const fresh = await getRoomMembers(room.id);
    setMembers(fresh);
  }, [room.id]);

  const inviteCandidates = useMemo(() => {
    const inRoom = new Set(members.map((m) => m.id));
    return contacts.filter((c) => !inRoom.has(c.memberId));
  }, [contacts, members]);

  const handleInvite = async (memberId: string) => {
    setMemberBusyId(memberId); setMemberError(null);
    try {
      const updated = await inviteRoomMember(room.id, memberId);
      await refreshMembers();
      onSaved(updated);
      setInviteOpen(false);
      toast("Member added to the room", "success");
    } catch (err) {
      setMemberError(String((err as Error)?.message || err));
    } finally {
      setMemberBusyId(null);
    }
  };

  const handleRemove = async (member: MemberInfo) => {
    setMemberBusyId(member.id); setMemberError(null);
    try {
      const updated = await removeRoomMember(room.id, member.id);
      await refreshMembers();
      onSaved(updated);
      setConfirmRemoveId(null);
      toast(`${member.name} removed — their scope memory is kept`, "success");
    } catch (err) {
      setMemberError(String((err as Error)?.message || err));
    } finally {
      setMemberBusyId(null);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const hasChanges = useMemo(() => {
    if (name.trim() !== room.name) return true;
    if ((leaderId || "") !== (room.promptLeaderMemberId || "")) return true;
    return normalizeDocsPathInput(docsPath) !== (room.docsPath || "");
  }, [name, leaderId, docsPath, room]);

  const canSave = name.trim().length > 0 && hasChanges && !saving;
  const currentLeader = members.find((member) => member.id === leaderId);
  const missingLeader = room.promptLeaderMemberId && members.length > 0 && !members.some((member) => member.id === room.promptLeaderMemberId);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; promptLeaderMemberId?: string | null; docsPath?: string | null } = {};
      if (name.trim() !== room.name) patch.name = name.trim();
      if ((leaderId || "") !== (room.promptLeaderMemberId || "")) patch.promptLeaderMemberId = leaderId || null;
      const nextDocsPath = normalizeDocsPathInput(docsPath);
      if (nextDocsPath !== (room.docsPath || "")) patch.docsPath = nextDocsPath || null;

      const updated = await updateRoomSettings(room.id, patch);
      onSaved(updated);
      toast("Room settings saved", "success");
      onClose();
    } catch (err: any) {
      console.error("Failed to save Room settings", err);
      const message = "Couldn’t save Room settings. Check the fields, then try again.";
      setError(message);
      toast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm(`Delete room "${room.name}"?`))) return;
    setDeleting(true);
    try {
      await deleteRoom(room.id);
      toast("Room deleted", "success");
      onDeleted?.(room.id);
      onClose();
    } catch (err) {
      console.error("Failed to delete Room", err);
      toast("Couldn’t delete this Room. Try again.", "error");
    } finally {
      setDeleting(false);
    }
  };

  if (!open) return null;

  return (
    <Sheet open={open} onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-ink-1">Room Settings</h2>
            <p className="text-xs text-ink-4 mt-1">Room-level settings, leadership, and principles preview.</p>
          </div>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-1 text-lg transition-colors cursor-pointer" aria-label="Close">×</button>
        </div>

        <div className="space-y-4" data-testid="room-settings-grid">
            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-ink-1">General</h3>
              <div>
                <label className="block text-xs text-ink-3 mb-1.5">Room name</label>
                <input autoFocus type="text" value={name} onChange={(e) => setName(e.target.value)} className={`w-full bg-surface-2 border rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors ${name.trim().length === 0 ? "border-blocked" : "border-line"}`} />
              </div>
              <div>
                <label className="block text-xs text-ink-3 mb-1.5">Library folder</label>
                <input type="text" value={docsPath} onChange={(e) => setDocsPath(e.target.value)} placeholder="bossmode/" className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors font-mono" />
                <p className="text-xs text-ink-4 mt-1">New documents for this Room are saved in this Library folder. Leave empty to use the shared Library root.</p>
              </div>
            </section>

            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Crown size={14} className="text-think" />
                <h3 className="text-sm font-semibold text-ink-1">Room leadership</h3>
              </div>
              <select value={leaderId} onChange={(e) => setLeaderId(e.target.value)} className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors">
                <option value="">No leader</option>
                {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
              <p className="text-xs text-ink-4">The leader can edit Room Principles.</p>
              {currentLeader && <p className="text-xs text-ink-3">Current leader: <span className="font-mono text-ink-2">@{currentLeader.name}</span></p>}
              {missingLeader && <p className="text-xs text-blocked">Saved leader is no longer a current room member. Select a new leader or clear it.</p>}
            </section>

            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink-1">Members · {members.length}</h3>
                <button
                  type="button"
                  onClick={() => { setInviteOpen((v) => !v); setMemberError(null); }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-line rounded-lg text-xs font-semibold text-ink-2 hover:bg-surface-2 cursor-pointer"
                >
                  <UserPlus size={13} /> Add member
                </button>
              </div>

              {inviteOpen && (
                <div className="rounded-lg border border-line bg-surface-1 divide-y divide-line-soft max-h-44 overflow-y-auto">
                  {inviteCandidates.length === 0 ? (
                    <p className="px-3 py-3 text-xs text-ink-4">Every contact is already in this room. Hire a new member from Contacts first.</p>
                  ) : (
                    inviteCandidates.map((c) => (
                      <button
                        key={c.memberId}
                        type="button"
                        disabled={memberBusyId !== null}
                        onClick={() => void handleInvite(c.memberId)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2 cursor-pointer disabled:opacity-50"
                      >
                        <StaffBadge name={c.name} size="xs" />
                        <span className="text-[12.5px] font-medium text-ink-1 flex-1 truncate">{c.name}</span>
                        {c.title ? <span className="text-[10.5px] text-ink-4">{c.title}</span> : null}
                        {memberBusyId === c.memberId && <Loader2 size={12} className="animate-spin text-ink-4" />}
                      </button>
                    ))
                  )}
                </div>
              )}

              <div className="divide-y divide-line-soft">
                {members.map((m) => {
                  const isLeader = room.promptLeaderMemberId === m.id;
                  const confirming = confirmRemoveId === m.id;
                  return (
                    <div key={m.id} className="py-2">
                      <div className="flex items-center gap-2.5">
                        <StaffBadge name={m.name} size="xs" />
                        <span className="text-[12.5px] font-medium text-ink-1 truncate">{m.name}</span>
                        {isLeader && <Crown size={12} className="text-think shrink-0" />}
                        <span className="text-[10.5px] text-ink-4 truncate flex-1">{m.agent}</span>
                        {!confirming && (
                          <button
                            type="button"
                            title={`Remove ${m.name} from this room`}
                            onClick={() => { setConfirmRemoveId(m.id); setMemberError(null); }}
                            className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-ink-4 hover:text-blocked hover:bg-blocked/10 cursor-pointer"
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                      {confirming && (
                        <div className="mt-2 ml-8 flex items-center gap-2 rounded-lg border border-blocked/30 bg-blocked/5 px-2.5 py-2">
                          <span className="text-[11px] text-ink-2 flex-1">Remove {m.name}? Their scope memory is kept.{isLeader ? " Leadership will be cleared." : ""}</span>
                          <button
                            type="button"
                            disabled={memberBusyId === m.id}
                            onClick={() => void handleRemove(m)}
                            className="px-2 py-1 rounded-md bg-blocked text-white text-[11px] font-semibold cursor-pointer disabled:opacity-50"
                          >
                            {memberBusyId === m.id ? <Loader2 size={11} className="animate-spin" /> : "Remove"}
                          </button>
                          <button type="button" onClick={() => setConfirmRemoveId(null)} className="text-[11px] text-ink-3 hover:underline cursor-pointer">Cancel</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {memberError && <div role="alert" className="text-[11px] text-blocked">{memberError}</div>}
            </section>

            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink-1">Room principles preview</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full border border-line text-ink-4 uppercase">preview only</span>
              </div>
              <p className="text-xs text-ink-4">Room Principles are shared by all Room members. Preview only. {currentLeader ? <>Ask <span className="font-mono">@{currentLeader.name}</span> to update it in chat.</> : "Choose a Room leader, then ask them to update it in chat."}</p>
              <PromptPreview state={principlesState} onRetry={() => void loadPrinciples()} />
            </section>

            <section className="rounded-xl border border-blocked/30 bg-blocked-dim/30 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-ink-1">Danger zone</h3>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-4">Delete this room and its local messages, events, sessions, and prompt assets.</p>
                <button type="button" onClick={handleDelete} disabled={deleting} className="inline-flex items-center gap-2 px-3 py-2 border border-blocked/40 rounded-lg text-sm text-blocked hover:bg-blocked-dim/50 disabled:opacity-50 shrink-0">
                  <Trash2 size={14} /> {deleting ? "Deleting…" : "Delete room"}
                </button>
              </div>
            </section>
        </div>

        <div className="flex items-center gap-2 justify-end pt-3 border-t border-line-soft/50 mt-4">
          {canSave && <span className="text-[10px] text-think mr-auto">Unsaved changes</span>}
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer transition-colors">Cancel</button>
          <button type="button" disabled={!canSave} onClick={handleSave} className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer transition-colors">{saving ? "Saving..." : "Save settings"}</button>
        </div>
      </div>
    </Sheet>
  );
}
