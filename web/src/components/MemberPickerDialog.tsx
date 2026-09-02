import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { AgentInfo } from "../api/client";
import { getAgents } from "../api/client";
import { Sheet } from "./Sheet";
import { StaffBadge } from "./StaffBadge";
import { userActionError } from "../utils/user-error";

export interface PickedMemberDraft {
  name: string;
  agent: string;
  leader?: boolean;
}

interface MemberPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called when user picks a single agent (template). */
  onPickAgent: (draft: PickedMemberDraft) => void;
}

/** Add-member picker: pick an agent template as a named member (0.20 — team templates removed). */
export function MemberPickerDialog({ open, onClose, onPickAgent }: MemberPickerDialogProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) { setError(null); return; }
    if (agents.length > 0) return;
    setLoading(true);
    getAgents()
      .then(setAgents)
      .catch((err) => {
        console.error("Failed to load agents", err);
        setError(userActionError("load agents"));
      })
      .finally(() => setLoading(false));
  }, [open, agents.length]);

  if (!open) return null;

  return (
    <Sheet open onClose={onClose} size="lg" closeOnOverlayClick>
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink-1">Add member</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1">
          <X size={18} />
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
        {error && (
          <div role="alert" className="mb-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
            {error}
          </div>
        )}

        {loading ? (
          <p className="py-6 text-center text-sm text-ink-4">Loading templates…</p>
        ) : agents.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-4">No templates available.</p>
        ) : (
          <div className="space-y-2">
            {agents.map((a) => (
              <PickRow
                key={a.name}
                icon={<StaffBadge name={a.name} avatar={a.avatar} status="idle" size="sm" />}
                title={a.name}
                subtitle={a.description || "Template"}
                onClick={() => {
                  onPickAgent({ name: a.name, agent: a.name });
                  onClose();
                }}
              />
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function PickRow({
  icon, title, subtitle, onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface-1 px-3.5 py-3 text-left hover:border-line-strong hover:bg-surface-2 transition-colors"
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-ink-1">{title}</span>
        <span className="mt-0.5 block truncate text-xs text-ink-4">{subtitle}</span>
      </span>
    </button>
  );
}
