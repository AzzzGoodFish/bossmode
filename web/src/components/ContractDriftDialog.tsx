/**
 * ContractDriftDialog — shown after a bossmode update when members have
 * sessions running from a previous build. The user picks Reload (default),
 * Reset, or Keep per member, then applies.
 *
 * Data: GET /api/rooms/:id/contract-drift → ContractDriftEntry[]
 * Actions: reloadMemberResources / resetAgentSession per member, then
 * dismissContractDrift to clear the one-shot notification.
 */
import { useState, useCallback } from "react";
import type { ContractDriftEntry } from "../api/client";
import { reloadMemberResources, resetAgentSession } from "../api/client";
import { Sheet } from "./Sheet";
import { StaffBadge, statusFromAgent } from "./StaffBadge";

type Choice = "reload" | "reset" | "keep";

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
    Object.fromEntries(members.map((m) => [m.memberName, "reload" as Choice])),
  );
  const [applying, setApplying] = useState(false);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const setChoice = useCallback((name: string, c: Choice) => {
    setChoices((prev) => ({ ...prev, [name]: c }));
  }, []);

  const pending = members.filter((m) => !resolved.has(m.memberName));
  const reloadCount = pending.filter((m) => choices[m.memberName] === "reload").length;
  const resetCount = pending.filter((m) => choices[m.memberName] === "reset").length;
  const totalCount = reloadCount + resetCount;

  const applyLabel = totalCount === 0
    ? "Nothing to apply"
    : [reloadCount && `Reload ${reloadCount}`, resetCount && `Reset ${resetCount}`].filter(Boolean).join(" · ") + (totalCount > 1 ? " members" : " member");

  const handleApply = useCallback(async () => {
    setApplying(true);
    const targets = pending.filter((m) => choices[m.memberName] !== "keep");
    for (const m of targets) {
      try {
        if (choices[m.memberName] === "reset") {
          await resetAgentSession(roomId, m.memberName);
        } else {
          await reloadMemberResources(roomId, m.memberName);
        }
        setResolved((prev) => new Set(prev).add(m.memberName));
      } catch (err) {
        console.error(`Failed to ${choices[m.memberName]} ${m.memberName}`, err);
        onError?.(`Couldn't ${choices[m.memberName]} ${m.memberName} — try again from the member panel.`);
      }
    }
    setApplying(false);
    onApplied();
    onClose();
  }, [pending, choices, roomId, onApplied, onClose]);

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
          <b className="text-ink-1 font-semibold">{pending.length} {pending.length === 1 ? "member" : "members"}</b>{" "}
          {pending.length === 1 ? "is" : "are"} running sessions from before this update.{" "}
          <b className="text-ink-1 font-semibold">Reload applies the new version now and keeps the conversation</b>{" "}
          — enough for most updates. They'd also pick it up automatically on their next activation.
        </p>
      </div>

      <div className="mx-5 mt-3.5 rounded-xl border border-line-soft overflow-hidden">
        {members.map((m) => {
          const busy = m.status === "working";
          const done = resolved.has(m.memberName);
          const choice = choices[m.memberName] ?? "reload";
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
                      <button disabled className="rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-ink-3 opacity-40">Reload</button>
                      <button disabled className="rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-ink-3 opacity-40">Reset</button>
                      <button disabled className="rounded-md px-2.5 py-1 text-[11.5px] font-semibold text-ink-3 opacity-40">Keep</button>
                    </div>
                    <div className="text-[10px] text-ink-4 mt-1">Working now — act when idle</div>
                  </div>
                ) : (
                  <div className="flex gap-0.5 rounded-lg border border-line-soft bg-inset p-0.5">
                    {(["reload", "reset", "keep"] as const).map((c) => (
                      <button
                        key={c}
                        onClick={() => setChoice(m.memberName, c)}
                        className={`rounded-md px-2.5 py-1 text-[11.5px] font-semibold whitespace-nowrap transition-colors ${choice === c ? "bg-surface-1 text-ink-1 border border-line-soft shadow-sm" : "text-ink-3 border border-transparent"}`}
                        title={c === "reload" ? "Apply now, keep conversation" : c === "reset" ? "Fresh session — for contract updates or misbehaving sessions" : "Apply automatically on next activation"}
                      >
                        {c === "reload" ? "Reload" : c === "reset" ? "Reset" : "Keep"}
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
          <span className="shrink-0 mt-0.5 text-ink-4">↻</span>
          <span><b className="text-ink-2 font-semibold">Reload</b> (recommended) — new version takes effect now, conversation kept. Enough even for contract updates; the prompt cache is rebuilt, so the next reply may be slower.</span>
        </div>
        <div className="flex gap-2 text-[11px] text-ink-3 leading-relaxed items-start">
          <span className="shrink-0 mt-0.5 text-ink-4">⟲</span>
          <span><b className="text-ink-2 font-semibold">Reset session</b> — clean start. Worth it when an update reworks the conversation contract, or a session is misbehaving. Only in-flight context is lost — memory lives in chat, tasks, Library, principles.</span>
        </div>
        <div className="flex gap-2 text-[11px] text-ink-3 leading-relaxed items-start">
          <span className="shrink-0 mt-0.5 text-ink-4">○</span>
          <span><b className="text-ink-2 font-semibold">Keep</b> — do nothing now. The new version applies automatically on the member's next activation.</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2.5 px-5 py-4">
        <button onClick={onClose} className="text-ink-3 text-[13px] px-3 py-2 hover:text-ink-1">Later</button>
        <button
          onClick={handleApply}
          disabled={applying || totalCount === 0}
          className="rounded-lg bg-accent text-accent-contrast text-[13px] font-semibold px-4 py-2 disabled:opacity-45 hover:opacity-90"
        >
          {applying ? <span className="inline-block w-[11px] h-[11px] rounded-full border-2 border-white/30 border-t-white animate-spin align-text-bottom" /> : " "}
          {applyLabel}
        </button>
      </div>
    </Sheet>
  );
}
