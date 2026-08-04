/**
 * DmPage — direct-message conversation with a member (scope = dm).
 *
 * One member, one private scope. No @ needed — everything you say activates
 * them. Right panel is the member card: public zone (identity, global status,
 * effective model, tokens) + scope zone (this DM's context, memory layers).
 * Data: /api/members/:id, /api/dm/:memberId/{messages,session}.
 */
import { useCallback, useEffect, useState } from "react";
import { PanelRight, Send, Info, Settings2 } from "lucide-react";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import {
  getMemberDetail, getDmMessages, getDmSession, sendDmMessage, postConversationRead,
  type MemberDetail, type DmMessage, type DmSession,
} from "../api/client";
import { formatTokenCount } from "./ContactsPage";

export function DmPage({ memberId, onBack, onOpenSettings }: { memberId: string; onBack: () => void; onOpenSettings?: (memberId: string) => void }) {
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [session, setSession] = useState<DmSession | null>(null);
  const [messages, setMessages] = useState<DmMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, msgs, sess] = await Promise.all([
        getMemberDetail(memberId),
        getDmMessages(memberId, { limit: 50 }),
        getDmSession(memberId).catch(() => null),
      ]);
      setMember(m);
      setMessages(msgs.messages);
      setSession(sess);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    }
  }, [memberId]);

  useEffect(() => { void load(); }, [load]);

  // Report read position — clears the user-cursor unread badge (contract v1.3).
  useEffect(() => {
    if (!messages) return;
    postConversationRead(`dm:${memberId}`).catch(() => {});
  }, [memberId, messages]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendDmMessage(memberId, text);
      setDraft("");
      // Optimistic append; server event/stream will reconcile when runtime lands.
      setMessages((prev) => [...(prev ?? []), { seq: (prev?.[prev.length - 1]?.seq ?? 0) + 1, sender: "user", text, ts: Date.now() }]);
    } catch (err) {
      setError(`Couldn't send. ${String((err as Error)?.message || err)}`);
    } finally {
      setSending(false);
    }
  }, [draft, sending, memberId]);

  if (error && !member) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-3">
        <div className="text-center">
          <div className="text-sm font-medium text-ink-2 mb-1">Couldn’t load this member</div>
          <div className="text-xs text-blocked mb-2">{error}</div>
          <button type="button" onClick={onBack} className="text-xs text-accent-ink hover:underline cursor-pointer">Back to contacts</button>
        </div>
      </div>
    );
  }
  if (!member) return <div className="flex-1 flex items-center justify-center text-sm text-ink-3">Loading…</div>;

  const status = session?.status ?? "idle";
  const contextPct = session?.contextPct ?? null;

  return (
    <div className="flex-1 flex min-h-0 bg-surface-1">
      {/* conversation column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* header */}
        <div className="h-12 shrink-0 border-b border-line-soft flex items-center gap-3 px-4">
          <StaffBadge name={member.name} status={statusFromAgent(status)} size="sm" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-ink-1">{member.name}</span>
              <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{member.agentTemplate}</span>
            </div>
          </div>
          <div className="text-[11.5px] text-ink-4">
            {status === "working" ? <span className="text-onair font-medium">● Working</span> : "Idle"}
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
          {error && <div role="alert" className="text-[12px] text-blocked mb-2">{error}</div>}
          {!messages ? (
            <div className="text-sm text-ink-3 py-8 text-center">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="text-center py-12 text-ink-3">
              <div className="text-sm font-medium text-ink-2 mb-1">No messages yet</div>
              <div className="text-xs">Say something — everything here activates {member.name} directly.</div>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.seq} className="flex gap-2.5 py-2">
                {msg.sender === "member" ? (
                  <StaffBadge name={member.name} status={statusFromAgent(status)} size="xs" />
                ) : (
                  <StaffBadge name="you" status="boss" size="xs" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-ink-4 mb-0.5">
                    {msg.sender === "member" ? member.name : "you"} · {formatTime(msg.ts)}
                  </div>
                  <div className="text-[13.5px] text-ink-1 leading-relaxed whitespace-pre-wrap">{msg.text}</div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* composer */}
        <div className="shrink-0 border-t border-line-soft p-3">
          <div className="rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5 flex items-end gap-2 focus-within:border-accent transition-colors">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={1}
              placeholder={`Message ${member.name}… (no @ needed in DM)`}
              className="flex-1 bg-transparent outline-none resize-none text-[13.5px] text-ink-1 placeholder:text-ink-4"
            />
            <button
              type="button"
              title="Send"
              onClick={() => void send()}
              className="w-8 h-8 rounded-lg bg-accent text-accent-contrast flex items-center justify-center hover:opacity-90 cursor-pointer shrink-0 disabled:opacity-40"
              disabled={!draft.trim() || sending}
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
                <StaffBadge name={member.name} status={statusFromAgent(status)} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-bold text-ink-1">{member.name}</div>
                  <div className="text-[11.5px] text-ink-3 mt-0.5">{member.agentTemplate} member</div>
                </div>
                {onOpenSettings && (
                  <button
                    type="button"
                    title="Member settings"
                    onClick={() => onOpenSettings(member.memberId)}
                    className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-ink-4 hover:text-ink-1 hover:bg-surface-2 cursor-pointer"
                  >
                    <Settings2 size={15} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <Zone label="Template" value={member.agentTemplate} />
                <Zone label="Model" value={member.global?.model ?? "—"} mono />
                <Zone label="Unified" value={member.unifiedModel && member.unifiedExtensions ? "on" : "custom"} />
                <Zone label="Scopes" value="—" />
              </div>
              <div className="text-[11px] text-ink-4 leading-relaxed border-t border-line-soft pt-2.5">
                {member.unifiedModel ? "All scopes share the global model config." : "This member overrides model per scope."}
              </div>
            </section>

            {/* scope zone (this DM) */}
            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-4 font-semibold">
                <Info size={12} /> This conversation (dm)
              </div>
              {contextPct != null ? (
                <div>
                  <div className="flex items-center justify-between text-xs text-ink-4 mb-1.5">
                    <span>Context used</span><span>{contextPct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
                    <div className={`h-full rounded-full ${contextPct >= 80 ? "bg-blocked" : "bg-accent"}`} style={{ width: `${contextPct}%` }} />
                  </div>
                </div>
              ) : (
                <div className="text-[11.5px] text-ink-4">Context usage unavailable until the first turn runs.</div>
              )}
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
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
