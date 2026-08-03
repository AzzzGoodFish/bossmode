/**
 * DmPage — direct-message conversation with a member (scope = dm).
 *
 * One member, one private scope. No @ needed — everything you say activates
 * them. Right panel is the member card: public zone (identity, global status,
 * effective model, tokens) + scope zone (this DM's context, tools, mainline).
 *
 * Data: mock/contacts (contract-shaped; swap for api/client when backend lands).
 */
import { useMemo, useState } from "react";
import { PanelRight, Send, Info } from "lucide-react";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { getMember, getDmMessages, formatTokens } from "../mock/contacts";

export function DmPage({ memberId, onBack }: { memberId: string; onBack: () => void }) {
  const member = getMember(memberId);
  const messages = useMemo(() => getDmMessages(memberId), [memberId]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [draft, setDraft] = useState("");

  if (!member) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-3">
        <div className="text-center">
          <div className="text-sm font-medium text-ink-2 mb-1">Member not found</div>
          <button type="button" onClick={onBack} className="text-xs text-accent-ink hover:underline cursor-pointer">Back to contacts</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0 bg-surface-1">
      {/* conversation column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* header */}
        <div className="h-12 shrink-0 border-b border-line-soft flex items-center gap-3 px-4">
          <StaffBadge name={member.name} status={statusFromAgent(member.status)} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-ink-1">{member.name}</span>
              <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{member.template}</span>
            </div>
          </div>
          <div className="text-[11.5px] text-ink-4">
            {member.status === "working" ? (
              <span className="text-onair font-medium">● Working{member.activeScope ? ` in ${member.activeScope}` : ""}</span>
            ) : "Idle"}
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              title="Member panel"
              className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${panelOpen ? "bg-accent-dim text-accent-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink-1"}`}
            >
              <PanelRight size={16} />
            </button>
          </div>
        </div>

        {/* messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="flex items-center gap-3 my-2">
            <span className="flex-1 h-px bg-line-soft" />
            <span className="text-[10.5px] text-ink-4">Direct messages · memory is shared across every scope</span>
            <span className="flex-1 h-px bg-line-soft" />
          </div>
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-2.5 py-2">
              {msg.from === "member" ? (
                <StaffBadge name={member.name} status={statusFromAgent(member.status)} size="xs" />
              ) : (
                <StaffBadge name="you" status="boss" size="xs" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-ink-4 mb-0.5">
                  {msg.from === "member" ? member.name : "you"} · {formatTime(msg.ts)}
                </div>
                <div className="text-[13.5px] text-ink-1 leading-relaxed whitespace-pre-wrap">{msg.text}</div>
              </div>
            </div>
          ))}
        </div>

        {/* composer */}
        <div className="shrink-0 border-t border-line-soft p-3">
          <div className="rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5 flex items-end gap-2 focus-within:border-accent transition-colors">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              placeholder={`Message ${member.name}… (no @ needed in DM)`}
              className="flex-1 bg-transparent outline-none resize-none text-[13.5px] text-ink-1 placeholder:text-ink-4"
            />
            <button
              type="button"
              title="Send (backend pending)"
              className="w-8 h-8 rounded-lg bg-accent text-accent-contrast flex items-center justify-center hover:opacity-90 cursor-pointer shrink-0 disabled:opacity-40"
              disabled={!draft.trim()}
              onClick={() => setDraft("")}
            >
              <Send size={15} />
            </button>
          </div>
          <div className="text-[10.5px] text-ink-4 mt-1.5 px-1">Everything you say activates {member.name}. Scope: dm · tools differ by scope.</div>
        </div>
      </div>

      {/* member panel */}
      {panelOpen && (
        <aside className="w-[320px] shrink-0 border-l border-line-soft overflow-y-auto">
          <div className="p-4 space-y-4">
            {/* public zone */}
            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <StaffBadge name={member.name} status={statusFromAgent(member.status)} size="lg" />
                <div className="min-w-0">
                  <div className="text-[15px] font-bold text-ink-1">{member.name}</div>
                  <div className="text-[11.5px] text-ink-3 mt-0.5">{member.description}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <Zone label="Template" value={member.template} />
                <Zone label="Model" value={member.model} mono />
                <Zone label="Tokens" value={formatTokens(member.tokenTotal)} mono />
                <Zone label="Scopes" value={String(member.scopes.length)} />
              </div>
              <div className="text-[11px] text-ink-4 leading-relaxed border-t border-line-soft pt-2.5">
                Unified config: model {member.unified.model ? "on" : "off"} · extensions {member.unified.extensions ? "on" : "off"}.
                {member.unified.model ? " All scopes share the global model config." : " This member overrides model per scope."}
              </div>
            </section>

            {/* scope zone (this DM) */}
            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-4 font-semibold">
                <Info size={12} /> This conversation (dm)
              </div>
              <div>
                <div className="flex items-center justify-between text-xs text-ink-4 mb-1.5">
                  <span>Context used</span><span>{member.contextPct}%</span>
                </div>
                <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
                  <div className={`h-full rounded-full ${member.contextPct >= 80 ? "bg-blocked" : "bg-accent"}`} style={{ width: `${member.contextPct}%` }} />
                </div>
              </div>
              <div className="text-[11.5px] text-ink-3 leading-relaxed">
                Memory layers active here: persona (global) → scope principles (dm) → mainline (dm) → chat history.
              </div>
            </section>
          </div>
        </aside>
      )}
    </div>
  );
}

function Zone({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface-1 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-4">{label}</div>
      <div className={`text-[12px] mt-0.5 truncate ${mono ? "tabular-nums" : ""} text-ink-2 font-medium`} title={value}>{value}</div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
