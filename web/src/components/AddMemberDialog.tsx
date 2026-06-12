import { useState, useEffect } from "react";
import type { MemberInfo } from "../api/client";
import { Sheet } from "./Sheet";
import { getMembers } from "../api/client";

interface AddMemberDialogProps {
  currentMembers: string[];
  onAdd: (memberName: string) => Promise<void>;
  onClose: () => void;
}

export function AddMemberDialog({ currentMembers, onAdd, onClose }: AddMemberDialogProps) {
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => { getMembers().then(setMembers).catch(console.error); }, []);

  const available = members.filter(
    (m) => !currentMembers.includes(m.name) && m.name.toLowerCase().includes(search.toLowerCase()),
  );

  const handleAdd = async (name: string) => {
    setAdding(name);
    try { await onAdd(name); } finally { setAdding(null); }
  };

  return (
    <Sheet open onClose={onClose} size="sm" closeOnOverlayClick={false}>
      <div className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink-1">Add Member</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-1 text-lg transition-colors cursor-pointer">×</button>
        </div>

        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search members..."
          className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 mb-3
                     focus:outline-none focus:border-line-strong transition-colors placeholder:text-ink-4"
          autoFocus
        />

        <div className="space-y-1 max-h-56 overflow-y-auto">
          {available.length === 0 ? (
            <div className="text-center py-6 text-xs text-ink-3">
              {members.length === 0 ? "No members configured" : "No matching members"}
            </div>
          ) : (
            available.map((m) => (
              <div key={m.id} className="flex items-center justify-between px-3 py-2 rounded hover:bg-surface-2 transition-colors">
                <div className="min-w-0">
                  <div className="text-sm text-ink-2">{m.name}</div>
                  <div className="text-xs text-ink-3 truncate">{m.agent} · {m.model || "agent default"}</div>
                </div>
                <button onClick={() => handleAdd(m.name)} disabled={adding === m.name}
                  className="text-xs text-accent-ink hover:opacity-80 disabled:text-ink-3 cursor-pointer shrink-0 ml-2">
                  {adding === m.name ? "Adding..." : "Invite"}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </Sheet>
  );
}
