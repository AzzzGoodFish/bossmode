/**
 * StalePill — persistent top-right notification carrier for members that need
 * a reload (mount/contract stale). Unlike the 3s toast, this stays until the
 * user acts. Click to open a popover listing pending members with per-member
 * Reload buttons.
 */
import { useState, useCallback } from "react";
import { reloadMemberResources } from "../api/client";

export interface StaleMemberInfo {
  mounts?: { since: number; fields: string[] };
  contract?: boolean;
}

export function StalePill({
  roomId,
  staleMembers,
  agentStatus,
}: {
  roomId: string;
  staleMembers: Record<string, StaleMemberInfo>;
  agentStatus: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const handleReload = useCallback(async (name: string) => {
    setBusy((prev) => new Set(prev).add(name));
    try {
      await reloadMemberResources(roomId, name);
    } catch (err) {
      console.error(`Failed to reload ${name}`, err);
    } finally {
      setBusy((prev) => { const n = new Set(prev); n.delete(name); return n; });
      setOpen(false);
    }
  }, [roomId]);

  const pending = Object.entries(staleMembers);
  if (pending.length === 0) return null;

  const hasContract = pending.some(([, s]) => s.contract);

  const fieldLabel = (fields: string[] = []) => {
    const map: Record<string, string> = { mcpServers: "MCP servers", extensions: "Extensions", unifiedExtensions: "Extensions" };
    return [...new Set(fields.map((f) => map[f] || f))].join(" · ");
  };

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full px-2.5 py-1 bg-surface-1 border border-line-strong shadow-md text-[11px] font-semibold text-ink-1 hover:border-blocked transition-colors z-[60]"
        title="Members need a reload"
      >
        <span className="w-2 h-2 rounded-full bg-blocked shrink-0" />
        <span>{hasContract ? "Update" : "Reload"}</span>
        <span className="text-ink-3 font-normal">{pending.length}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[59]" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 w-80 rounded-xl border border-line bg-surface-1 shadow-xl overflow-hidden z-[61]">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-line-soft">
            <span className="text-[12px] font-bold text-ink-1">{hasContract ? "Pending updates" : "Pending reloads"}</span>
            <span className="text-[10.5px] text-ink-4 font-normal">red dots clear after Reload</span>
          </div>
          {pending.map(([name, stale]) => {
            const isBusy = agentStatus[name] === "working";
            return (
              <div key={name} className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line-soft last:border-b-0">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-semibold text-ink-1">{name}</div>
                  <div className="flex gap-1 flex-wrap mt-0.5">
                    {stale.contract && <span className="text-[10px] rounded-full px-1.5 py-0.5 border border-blocked/35 text-blocked bg-blocked-dim/60 whitespace-nowrap">App updated</span>}
                    {stale.mounts && <span className="text-[10px] rounded-full px-1.5 py-0.5 border border-blocked/35 text-blocked bg-blocked-dim/60 whitespace-nowrap">{fieldLabel(stale.mounts.fields)} changed</span>}
                  </div>
                </div>
                <div className="ml-auto shrink-0">
                  <button
                    onClick={() => handleReload(name)}
                    disabled={isBusy || busy.has(name)}
                    title={isBusy ? "Working now — act when idle" : "Reload to apply"}
                    className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-contrast disabled:opacity-40 hover:opacity-90"
                  >
                    {busy.has(name) ? <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-white/30 border-t-white animate-spin" /> : "Reload"}
                  </button>
                  {isBusy && <div className="text-[9.5px] text-ink-4 mt-0.5 text-center">when idle</div>}
                </div>
              </div>
            );
          })}
          <div className="px-3.5 py-2 text-[10.5px] text-ink-4 border-t border-line-soft">Same marks shown on the member avatar and in Session &amp; tools.</div>
          </div>
        </>
      )}
    </div>
  );
}
