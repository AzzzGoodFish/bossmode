import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Shield } from "lucide-react";
import { Sheet } from "./Sheet";
import type { Room, KnowledgeTreeNode } from "../api/client";
import { getKnowledgeTree, updateRoomSettings } from "../api/client";
import { useDialog } from "./dialogs";
import { RulesTree } from "./RulesTree";

interface RoomSettingsDialogProps {
  room: Room;
  open: boolean;
  onClose: () => void;
  onSaved: (room: Room) => void;
}

export function RoomSettingsDialog({ room, open, onClose, onSaved }: RoomSettingsDialogProps) {
  const { toast } = useDialog();
  const [name, setName] = useState(room.name);
  const [cwd, setCwd] = useState(room.cwd);
  const [selectedRuleDocs, setSelectedRuleDocs] = useState<Set<string>>(new Set(room.ruleDocs || []));
  const [tree, setTree] = useState<KnowledgeTreeNode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(room.name);
    setCwd(room.cwd);
    setSelectedRuleDocs(new Set(room.ruleDocs || []));
    setError(null);
    getKnowledgeTree().then((loadedTree) => {
      setTree(loadedTree);

      const validPaths = new Set<string>();
      const collectPaths = (node: KnowledgeTreeNode) => {
        if (node.kind === "file") validPaths.add(node.path);
        node.children?.forEach(collectPaths);
      };
      loadedTree.children?.forEach(collectPaths);

      const filtered = (room.ruleDocs || []).filter((p) => validPaths.has(p));
      setSelectedRuleDocs(new Set(filtered));
    }).catch((err: any) => {
      toast(err.message || "Failed to load knowledge tree", "error");
    });
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
    const current = room.ruleDocs || [];
    const next = Array.from(selectedRuleDocs);
    if (current.length !== next.length) return true;
    return current.some((v, i) => v !== next[i]);
  }, [name, cwd, selectedRuleDocs, room]);

  const cwdChanged = cwd.trim() !== room.cwd;
  const canSave = name.trim().length > 0 && hasChanges && !saving;

  const toggleRuleDoc = (docPath: string) => {
    setSelectedRuleDocs((prev) => {
      const next = new Set(prev);
      next.has(docPath) ? next.delete(docPath) : next.add(docPath);
      return next;
    });
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; cwd?: string; ruleDocs?: string[] } = {};
      if (name.trim() !== room.name) patch.name = name.trim();
      if (cwd.trim() !== room.cwd) patch.cwd = cwd.trim();
      const nextRuleDocs = Array.from(selectedRuleDocs);
      const currentRuleDocs = room.ruleDocs || [];
      if (nextRuleDocs.length !== currentRuleDocs.length || currentRuleDocs.some((v, i) => v !== nextRuleDocs[i])) {
        patch.ruleDocs = nextRuleDocs;
      }

      const updated = await updateRoomSettings(room.id, patch);
      onSaved(updated);
      toast("Room settings saved", "success");
      if (patch.cwd) {
        toast("Running agents need restart to use new directory", "info");
      }
      onClose();
    } catch (err: any) {
      const msg = err.message || "Failed to save room settings";
      setError(msg);
      toast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <Sheet open={open} onClose={onClose} size="lg" closeOnOverlayClick={false}>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-ink-1">Room Settings</h2>
          <button
            onClick={onClose}
            className="text-ink-4 hover:text-ink-1 text-lg transition-colors cursor-pointer"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm text-ink-2 mb-1">Room Name</label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`w-full bg-surface-2 border rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors ${
                name.trim().length === 0
                  ? "border-blocked"
                  : "border-line"
              }`}
            />
          </div>

          <div>
            <label className="block text-sm text-ink-2 mb-1">Working Directory</label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors font-mono"
            />
            {cwdChanged && (
              <p className="text-xs text-think mt-1 flex items-center gap-1">
                <AlertCircle size={12} />
                Running agents need restart to use new directory
              </p>
            )}
            {error === "Directory does not exist" && (
              <p className="text-xs text-blocked mt-1">Directory does not exist</p>
            )}
          </div>

          <div>
            <label className="text-sm text-ink-2 mb-1 flex items-center gap-1.5">
              <Shield size={13} className="text-think" />
              Rule Documents ({selectedRuleDocs.size} selected)
            </label>
            <p className="text-xs text-ink-3 mb-2">
              Selected docs are injected into every agent's system prompt.
            </p>
            <div className="border border-line-soft rounded p-2 max-h-56 overflow-y-auto">
              {tree?.children && tree.children.length > 0 ? (
                <RulesTree nodes={tree.children} selected={selectedRuleDocs} onToggle={toggleRuleDoc} />
              ) : (
                <p className="text-xs text-ink-3 py-4 text-center">No knowledge documents found</p>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-3 border-t border-line-soft/50 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={handleSave}
            className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
