/**
 * ContractDriftDialog — shown after a bossmode update when members have
 * sessions running from a previous build. The user picks Reload (default),
 * Reset, or Keep per member, then applies.
 *
 * Data: GET /api/rooms/:id/contract-drift → ContractDriftEntry[]
 * Actions: resetAgentSession per member (Reset), then
 * dismissContractDrift to clear the one-shot notification.
 */
import { useState, useCallback } from "react";
import type { ContractDriftEntry } from "../api/client";
import { resetAgentSession } from "../api/client";
import { Sheet } from "./Sheet";
import { StaffBadge, statusFromAgent } from "./StaffBadge";

type Choice = "reset" | "keep";

interface DriftMember extends ContractDriftEntry {
  status: string;
}

export function ContractDriftDialog({
  roomId,
  members,
  onClose,
  onApplied,
  onError,
}: {
  roomId: string;
  members: DriftMember[];
  onClose: () => void;
  onApplied: () => void;
  onError?: (msg: string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(members.map((m) => [m.memberName, "keep" as Choice])),
  );
  const [applying, setApplying] = useState(false);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const setChoice = useCallback((name: string, c: Choice) => {
    setChoices((prev) => ({ ...prev, [name]: c }));
  }, []);

  const pending = members.filter((m) => !resolved.has(m.memberName));
  const resetCount = pending.filter((m) => choices[m.memberName] === "reset").length;

  const applyLabel = resetCount === 0
    ? "Nothing to apply"
    : `Reset ${resetCount} ${resetCount > 1 ? "members" : "member"}`;

  const handleApply = useCallback(async () => {
    setApplying(true);
    const targets = pending.filter((m) => choices[m.memberName] === "reset");
    for (const m of targets) {
      try {
        await resetAgentSession(roomId, m.memberName);
        setResolved((prev) => new Set(prev).add(m.memberName));
      } catch (err) {
        console.error(`Failed to reset ${m.memberName}`, err);
        onError?.(`Couldn't reset ${m.memberName} — try again from the member panel.`);
      }
    }
    setApplying(false);
    onApplied();
    onClose();
  }, [pending, choices, roomId, onApplied, onClose, onError]);

  return (
    <Sheet open onClose={onClose} size="lg">
      <div className="px-5 pt-5">
        <div className="flex items-center gap-2 text-[15px] font-bold text-ink-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-ink">
            <circle cx="12" cy="12" r="10" />
            <polyline points="16 12 12 8 8 12" />
            <line x1="12" y1="16" x2="12" y2="8" />
          </svg>
          Bossmode updated
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
          <b className="text-ink-1 font-semibold">{pending.length} {pending.length === 1 ? "member" : "members"}</b> have sessions from before this contract update. The new version takes effect automatically on their next activation. If this update changed how members converse, or a session is misbehaving, <b className="text-ink-1 font-semibold">Reset</b> gives it a clean start — memory lives in chat, tasks, Library and principles, unaffected.
        </p>
      </div>

      <div className="mx-5 mt-3.5 rounded-xl border border-line-soft overflow-hidden">
        {members.map((m) => {
          const busy = m.status === "working";
          const done = resolved.has(m.memberName);
          const choice = choices[m.memberName] ?? "keep";
          return (
            <div key={m.memberId} className={`flex items-center gap-2.5 px-3 py-2.5 border-b border-line-soft last:border-b-0 bg-surface-1 ${busy ? "opacity-75" : ""}`}>
              <StaffBadge name={m.memberName} status={statusFromAgent(m.status)} size="sm" />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold text-ink-1">{m.memberName}</span>
                  <span className="text-[10px] rounded-full px-1.5 py-0.5 border border-line bg-surface-2 text-ink-4 whitespace-nowrap">{m.scopeLabel}</span>
                </div>
                <div className="text-[10.5px] text-ink-4 mt-0.5">
                  {busy ? <span className="text-on-air">● working</span> : "idle"} · session started before update
                </div>
              </div>
              <div className="ml-auto shrink-0">
                {done ? (
                  <span className="text-on-air text-[11px] font-bold">✓ done</span>
                ) : busy ? (
                  <div className="text-right">
                    <div className="flex gap-0.5 rounded-lg border border-line-soft bg-inset p-0.5">
                      <button disabled className="rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-ink-3 opacity-40">Keep</button>
                      <button disabled className="rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-ink-3 opacity-40">Reset</button>
                    </div>
                    <div className="text-[10px] text-ink-4 mt-1">Working now — act when idle</div>
                  </div>
                ) : (
                  <div className="flex gap-0.5 rounded-lg border border-line-soft bg-inset p-0.5">
                    {(["keep", "reset"] as const).map((c) => (
                      <button
                        key={c}
                        onClick={() => setChoice(m.memberName, c)}
                        className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold whitespace-nowrap transition-colors ${choice === c ? "bg-surface-1 text-ink-1 border border-line-soft shadow-sm" : "text-ink-3 border border-transparent"}`}
                        title={c === "reset" ? "Fresh session — for contract updates or misbehaving sessions" : "Apply automatically on next activation"}
                      >
                        {c === "reset" ? "Reset" : "Keep"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mx-5 mt-3 flex flex-col gap-1.5">
        <div className="flex gap-2 text-[11px] text-ink-3 leading-relaxed items-start">
          <span className="shrink-0 mt-0.5 text-ink-4">⟲</span>
          <span><b className="text-ink-2 font-semibold">Reset session</b> — clean start. Worth it when an update reworks the conversation contract (like this week's chat-tool switch), or a session is misbehaving. Only in-flight context is lost — memory lives in chat, tasks, Library, principles.</span>
        </div>
        <div className="flex gap-2 text-[11px] text-ink-3 leading-relaxed items-start">
          <span className="shrink-0 mt-0.5 text-ink-4">○</span>
          <span><b className="text-ink-2 font-semibold">Keep</b> (default) — do nothing. The new version applies automatically on the member's next activation.</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2.5 px-5 py-4">
        <button onClick={onClose} className="text-ink-3 text-[13px] px-3 py-2 hover:text-ink-1">Later</button>
        <button
          onClick={handleApply}
          disabled={applying || resetCount === 0}
          className="rounded-lg bg-accent text-accent-contrast text-[13px] font-semibold px-4 py-2 disabled:opacity-45 hover:opacity-90"
        >
          {applying ? <span className="inline-block w-[11px] h-[11px] rounded-full border-2 border-white/30 border-t-white animate-spin align-text-bottom" /> : " "}
          {applyLabel}
        </button>
      </div>
    </Sheet>
  );
}
