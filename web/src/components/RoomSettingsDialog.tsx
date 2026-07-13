import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Crown, Trash2 } from "lucide-react";
import { Sheet } from "./Sheet";
import type { MemberInfo, PromptSupplement, Room } from "../api/client";
import { getRoomMembers, getRoomPromptSupplement, updateRoomSettings, deleteRoom } from "../api/client";
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

type SupplementPreviewState =
  | { status: "loading" }
  | { status: "ready"; supplement: PromptSupplement }
  | { status: "error" };

export function promptPreviewDisplayState(state: SupplementPreviewState): "loading" | "loaded" | "empty" | "error" {
  if (state.status !== "ready") return state.status;
  return state.supplement.content.trim() ? "loaded" : "empty";
}

function PromptPreview({ state, onRetry }: { state: SupplementPreviewState; onRetry: () => void }) {
  const displayState = promptPreviewDisplayState(state);
  const content = state.status === "ready" ? state.supplement.content.trim() : "";
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
  const [cwd, setCwd] = useState(room.cwd);
  const [leaderId, setLeaderId] = useState<string>(room.promptLeaderMemberId || "");
  const [docsPath, setDocsPath] = useState(room.docsPath || "");
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [supplementState, setSupplementState] = useState<SupplementPreviewState>({ status: "loading" });
  const supplementRequestRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSupplement = useCallback(async () => {
    const request = ++supplementRequestRef.current;
    setSupplementState({ status: "loading" });
    try {
      const supplement = await getRoomPromptSupplement(room.id);
      if (request === supplementRequestRef.current) setSupplementState({ status: "ready", supplement });
    } catch (err) {
      console.error("Failed to load Room prompt", err);
      if (request === supplementRequestRef.current) setSupplementState({ status: "error" });
    }
  }, [room.id]);

  useEffect(() => {
    if (!open) return;
    setName(room.name);
    setCwd(room.cwd);
    setLeaderId(room.promptLeaderMemberId || "");
    setDocsPath(room.docsPath || "");
    setMembers([]);
    setError(null);
    getRoomMembers(room.id).then(setMembers).catch((err) => { console.error("Failed to load Room members", err); toast("Couldn’t load Room members. Close Settings and try again.", "error"); });
    void loadSupplement();
  }, [open, room, toast, loadSupplement]);

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
      console.error("Failed to save Room settings", err);
      const directoryMissing = typeof err?.message === "string" && err.message.includes("Directory does not exist");
      const message = directoryMissing ? "Directory does not exist" : "Couldn’t save Room settings. Check the fields, then try again.";
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
            <p className="text-xs text-ink-4 mt-1">Room-level settings, leadership, and prompt supplement preview.</p>
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
                <label className="block text-xs text-ink-3 mb-1.5">Working directory</label>
                <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors font-mono" />
                {cwdChanged && <p className="text-xs text-think mt-1 flex items-center gap-1"><AlertCircle size={12} />Running agents need restart to use new directory</p>}
                {error === "Directory does not exist" && <p className="text-xs text-blocked mt-1">Directory does not exist</p>}
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
              <p className="text-xs text-ink-4">The Room leader can update the Room Supplemental Prompt. You can change or clear the leader at any time.</p>
              {currentLeader && <p className="text-xs text-ink-3">Current leader: <span className="font-mono text-ink-2">@{currentLeader.name}</span></p>}
              {missingLeader && <p className="text-xs text-blocked">Saved leader is no longer a current room member. Select a new leader or clear it.</p>}
            </section>

            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-ink-1">Prompt supplement preview</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full border border-line text-ink-4 uppercase">preview only</span>
              </div>
              <p className="text-xs text-ink-4">Room Supplemental Prompt is shared by all Room members. Preview only. {currentLeader ? <>Ask <span className="font-mono">@{currentLeader.name}</span> to update it in chat.</> : "Choose a Room leader, then ask them to update it in chat."}</p>
              <PromptPreview state={supplementState} onRetry={() => void loadSupplement()} />
            </section>

            <section className="rounded-xl border border-blocked/30 bg-blocked-dim/30 p-4 space-y-3">
              <h3 className="text-sm font-semibold text-ink-1">Danger zone</h3>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-ink-4">Delete this room and its local messages, events, sessions, and supplements.</p>
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
