import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Crown, Trash2 } from "lucide-react";
import { Sheet } from "./Sheet";
import type { MemberInfo, PromptSupplement, Room } from "../api/client";
import { getRoomMembers, getRoomPromptSupplement, updateRoomSettings, deleteRoom } from "../api/client";
import { useDialog } from "./dialogs";

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

function PromptPreview({ supplement }: { supplement: PromptSupplement | null }) {
  const content = supplement?.content?.trim() || "";
  return (
    <div className="rounded-lg border border-line bg-inset p-3 min-h-36 max-h-64 overflow-auto">
      {content ? (
        <pre className="whitespace-pre-wrap text-xs leading-relaxed text-ink-2 font-mono">{content}</pre>
      ) : (
        <div className="text-xs text-ink-4 leading-relaxed">
          Room Supplemental Prompt is empty. The room leader can maintain concise rules, knowledge summaries, and document links through prompt supplement tools.
        </div>
      )}
    </div>
  );
}

export function RoomSettingsDialog({ room, open, onClose, onSaved, onDeleted }: RoomSettingsDialogProps) {
  const { toast, confirm } = useDialog();
  const [name, setName] = useState(room.name);
  const [cwd, setCwd] = useState(room.cwd);
  const [leaderId, setLeaderId] = useState<string>(room.promptLeaderMemberId || "");
  const [docsPath, setDocsPath] = useState(room.docsPath || "");
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [supplement, setSupplement] = useState<PromptSupplement | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(room.name);
    setCwd(room.cwd);
    setLeaderId(room.promptLeaderMemberId || "");
    setDocsPath(room.docsPath || "");
    setError(null);
    getRoomMembers(room.id).then(setMembers).catch((err: any) => toast(err.message || "Failed to load members", "error"));
    getRoomPromptSupplement(room.id).then(setSupplement).catch((err: any) => toast(err.message || "Failed to load prompt supplement", "error"));
  }, [open, room, toast]);

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
    if (cwd.trim() !== room.cwd) return true;
    if ((leaderId || "") !== (room.promptLeaderMemberId || "")) return true;
    return normalizeDocsPathInput(docsPath) !== (room.docsPath || "");
  }, [name, cwd, leaderId, docsPath, room]);

  const cwdChanged = cwd.trim() !== room.cwd;
  const canSave = name.trim().length > 0 && hasChanges && !saving;
  const currentLeader = members.find((member) => member.id === leaderId);
  const missingLeader = room.promptLeaderMemberId && members.length > 0 && !members.some((member) => member.id === room.promptLeaderMemberId);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; cwd?: string; promptLeaderMemberId?: string | null; docsPath?: string | null } = {};
      if (name.trim() !== room.name) patch.name = name.trim();
      if (cwd.trim() !== room.cwd) patch.cwd = cwd.trim();
      if ((leaderId || "") !== (room.promptLeaderMemberId || "")) patch.promptLeaderMemberId = leaderId || null;
      const nextDocsPath = normalizeDocsPathInput(docsPath);
      if (nextDocsPath !== (room.docsPath || "")) patch.docsPath = nextDocsPath || null;

      const updated = await updateRoomSettings(room.id, patch);
      onSaved(updated);
      toast("Room settings saved", "success");
      if (patch.cwd) toast("Running agents need restart to use new directory", "info");
      onClose();
    } catch (err: any) {
      const msg = err.message || "Failed to save room settings";
      setError(msg);
      toast(msg, "error");
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
    } catch (err: any) {
      toast(err.message || "Failed to delete room", "error");
    } finally {
      setDeleting(false);
    }
  };

  if (!open) return null;

  return (
    <Sheet open={open} onClose={onClose} size="lg" closeOnOverlayClick={false}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-ink-1">Room Settings</h2>
            <p className="text-xs text-ink-4 mt-1">Room-level settings, leadership, and prompt supplement preview.</p>
          </div>
          <button onClick={onClose} className="text-ink-4 hover:text-ink-1 text-lg transition-colors cursor-pointer" aria-label="Close">×</button>
        </div>

        <div className="space-y-4">
          <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-ink-1">General</h3>
            <div>
              <label className="block text-xs text-ink-3 mb-1.5">Room name</label>
              <input autoFocus type="text" value={name} onChange={(e) => setName(e.target.value)} className={`w-full bg-surface-2 border rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors ${name.trim().length === 0 ? "border-blocked" : "border-line"}`} />
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1.5">Working directory</label>
              <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors font-mono" />
              {cwdChanged && <p className="text-xs text-think mt-1 flex items-center gap-1"><AlertCircle size={12} />Running agents need restart to use new directory</p>}
              {error === "Directory does not exist" && <p className="text-xs text-blocked mt-1">Directory does not exist</p>}
            </div>
            <div>
              <label className="block text-xs text-ink-3 mb-1.5">Default docs space</label>
              <input type="text" value={docsPath} onChange={(e) => setDocsPath(e.target.value)} placeholder="bossmode/" className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors font-mono" />
              <p className="text-xs text-ink-4 mt-1">New room-specific docs should be written under this folder in the knowledge docs tree. Leave empty for legacy/global behavior.</p>
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
            <p className="text-xs text-ink-4">Leader can maintain the room-level prompt supplement through tools. User can always change or clear the leader.</p>
            {currentLeader && <p className="text-xs text-ink-3">Current leader: <span className="font-mono text-ink-2">@{currentLeader.name}</span></p>}
            {missingLeader && <p className="text-xs text-blocked">Saved leader is no longer a current room member. Select a new leader or clear it.</p>}
          </section>

          <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-ink-1">Prompt supplement preview</h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-line text-ink-4 uppercase">preview only</span>
            </div>
            <p className="text-xs text-ink-4">Room Supplemental Prompt is shared by all room members. Editing happens through leader/member tools, not this UI.</p>
            <PromptPreview supplement={supplement} />
          </section>

          <section className="rounded-xl border border-blocked/30 bg-blocked-dim/30 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-ink-1">Danger zone</h3>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-ink-4">Delete this room and its local messages, events, sessions, and supplements.</p>
              <button type="button" onClick={handleDelete} disabled={deleting} className="inline-flex items-center gap-2 px-3 py-2 border border-blocked/40 rounded-lg text-sm text-blocked hover:bg-blocked-dim/50 disabled:opacity-50">
                <Trash2 size={14} /> {deleting ? "Deleting…" : "Delete room"}
              </button>
            </div>
          </section>
        </div>

        <div className="flex gap-2 justify-end pt-3 border-t border-line-soft/50 mt-4">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer transition-colors">Cancel</button>
          <button type="button" disabled={!canSave} onClick={handleSave} className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer transition-colors">{saving ? "Saving..." : "Save settings"}</button>
        </div>
      </div>
    </Sheet>
  );
}
