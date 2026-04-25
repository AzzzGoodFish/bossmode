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
          <h2 className="text-sm font-semibold text-white">Add Member</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-white text-lg transition-colors cursor-pointer">×</button>
        </div>

        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search members..."
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white mb-3
                     focus:outline-none focus:ring-2 focus:ring-blue-600 placeholder:text-zinc-600"
          autoFocus
        />

        <div className="space-y-1 max-h-56 overflow-y-auto">
          {available.length === 0 ? (
            <div className="text-center py-6 text-xs text-zinc-600">
              {members.length === 0 ? "No members configured" : "No matching members"}
            </div>
          ) : (
            available.map((m) => (
              <div key={m.id} className="flex items-center justify-between px-3 py-2 rounded hover:bg-zinc-800 transition-colors">
                <div className="min-w-0">
                  <div className="text-sm text-zinc-300">{m.name}</div>
                  <div className="text-xs text-zinc-600 truncate">{m.agent} · {m.runtime}</div>
                </div>
                <button onClick={() => handleAdd(m.name)} disabled={adding === m.name}
                  className="text-xs text-blue-400 hover:text-blue-300 disabled:text-zinc-600 cursor-pointer shrink-0 ml-2">
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
