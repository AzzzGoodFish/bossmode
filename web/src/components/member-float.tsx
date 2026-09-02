/**
 * member-float.tsx — the member detail FLOAT (fish 2026-09-02: "详情给一个
 * 浮窗吧，不要全页的" + "不要原来那个整页的配置页面了"). The depth ladder is
 * now fully Discord-shaped:
 *
 *   peek card (roster click — glance, never leaves the conversation)
 *   → detail float (this file — read-deep + config, Profile/Assets/Activity/Settings)
 *
 * The full-page member route is retired; MemberPage's sections move in here
 * as tabs (Profile first — fish: "profile 是基本信息"). No character arrows
 * in chrome (fish: "不要用字符的右箭头").
 *
 * One float instance lives at the Layout root (MemberFloatProvider); open it
 * from anywhere with useMemberFloat().open(memberId, scopeId?).
 *   scopeId `room:<id>`   → scope view tagged "this room"
 *   scopeId `dm:<member>` → scope view tagged "this DM"
 *   absent (Contacts)     → global-only: Profile + Settings (no Activity tab)
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Info, Loader2, SendHorizonal, X } from "lucide-react";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { ActivityTab } from "./ActivityTab";
import { useDialog } from "./dialogs";
import { copyText } from "../utils/clipboard";
import {
  MemberSkillsCard, ContextSessionCard,
  ExtensionsAccordion, McpToolsAccordion, ActiveToolsSection, isAssignableMcpServer,
  formatTokens,
} from "./member-scope";
import { availableThinkingLevels, findModelOptionForBinding } from "./thinking-levels";
import {
  getMemberDetail, getMemberScopes, getAvailableModels,
  patchGlobalMember, deleteGlobalMember, getMemberProfile, getMemberSkills,
  steerAgent, restartMember, resetAgentSession,
  getMemberStats, getMemberSystemPrompt,
  getMemberScopedStats,
  getConversationSession, conversationMemberAction, getMcpSettings, getExtensions, sendDmMessage,
  type MemberDetail, type MemberScopeInfo, type AvailableModelOption,
  type MemberProfileDoc, type MemberSkillEntry, type MemberStats,
  type ContextUsageData, type McpServerSummary, type ExtensionRecord, type MemberSystemPromptDoc,
} from "../api/client";

type SaveState = "idle" | "saving" | "saved" | "error";

// ── context ─────────────────────────────────────────────────────────────────

type FloatTab = "profile" | "assets" | "activity" | "settings";
type FloatTarget = { memberId: string; scopeId?: string; tab?: FloatTab };
const MemberFloatCtx = createContext<{ open: (memberId: string, scopeId?: string, tab?: FloatTab) => void }>({ open: () => {} });
export const useMemberFloat = () => useContext(MemberFloatCtx);

export function MemberFloatProvider({ children, onFired, onOpenSettings }: { children: React.ReactNode; onFired?: () => void; onOpenSettings?: (section: "integrations" | "extensions") => void }) {
  const [target, setTarget] = useState<FloatTarget | null>(null);
  const open = useCallback((memberId: string, scopeId?: string, tab?: FloatTab) => setTarget({ memberId, scopeId, tab }), []);
  return (
    <MemberFloatCtx.Provider value={{ open }}>
      {children}
      {target && <MemberDetailFloat key={`${target.memberId}:${target.scopeId ?? ""}`} memberId={target.memberId} scopeId={target.scopeId} initialTab={target.tab} onClose={() => setTarget(null)} onFired={() => { setTarget(null); onFired?.(); }} onOpenSettings={onOpenSettings} />}
    </MemberFloatCtx.Provider>
  );
}



// ── the float ───────────────────────────────────────────────────────────────

function MemberDetailFloat({ memberId, scopeId, initialTab, onClose, onFired, onOpenSettings }: {
  memberId: string;
  scopeId?: string;
  initialTab?: FloatTab;
  onClose: () => void;
  onFired: () => void;
  onOpenSettings?: (section: "integrations" | "extensions") => void;
}) {
  const { toast } = useDialog();
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [scopes, setScopes] = useState<MemberScopeInfo[]>([]);
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<FloatTab>(initialTab ?? "profile");
  const [dmDraft, setDmDraft] = useState("");
  const [dmSent, setDmSent] = useState(false);
  const [dmSending, setDmSending] = useState(false);

  useEffect(() => {
    getMemberDetail(memberId).then(setMember).catch((e) => setLoadError(String(e?.message || e)));
    getMemberScopes(memberId).then((r) => setScopes(r.scopes)).catch(() => {});
    getAvailableModels().then(setModels).catch(() => {});
  }, [memberId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const scope = scopeId
    ? scopes.find((s) => s.scopeId === scopeId) ?? (scopeId.startsWith("dm:")
        ? { scopeId, kind: "dm" as const, label: "Direct message", status: "inactive", lastActiveAt: null }
        : { scopeId, kind: "room" as const, label: "This room", status: "inactive", lastActiveAt: null })
    : null;

  const sendDm = async () => {
    const text = dmDraft.trim();
    if (!text || dmSending) return;
    setDmSending(true);
    try {
      await sendDmMessage(memberId, text);
      setDmDraft(""); setDmSent(true);
      window.setTimeout(() => setDmSent(false), 1400);
    } catch (e) {
      toast(`Couldn't send. ${String((e as Error)?.message || e)}`, "error");
    } finally {
      setDmSending(false);
    }
  };

  const hasActivityTab = !!scope;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[720px] max-w-[calc(100vw-48px)] max-h-[calc(100vh-96px)] rounded-2xl border border-line-strong bg-surface-1 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={member ? `${member.name} details` : "Member details"}
      >
        {/* header — no banner strip (fish 2026-09-02: drop the gradient) */}
        <button onClick={onClose} title="Close" className="absolute top-3 right-3 w-7 h-7 rounded-lg text-ink-4 hover:text-ink-1 hover:bg-surface-2 flex items-center justify-center cursor-pointer z-10 transition-colors"><X size={14} /></button>
        <div className="px-5 pt-4 flex items-center gap-3.5 shrink-0">
          <StaffBadge name={member?.name ?? "?"} status={scope ? statusFromAgent(scope.status) : "offline"} size="lg" />
          <div className="min-w-0 pb-0.5">
            {member ? (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[17px] font-bold text-ink-1 truncate">{member.name}</span>
                </div>
                <div className="text-[11px] text-ink-3 mt-0.5 truncate">
                  {member.title ? `${member.title} · ` : ""}<span className="font-mono">@{member.name}</span>
                  {scope ? ` · ${scope.status}` : ""}
                </div>
              </>
            ) : (
              <div className="text-[13px] text-ink-4">{loadError ? `Couldn't load — ${loadError}` : "Loading…"}</div>
            )}
          </div>
        </div>

        {/* tabs — Profile first (fish 2026-09-02: profile 是基本信息放首位) */}
        {member && (
          <div className="flex gap-0.5 px-5 mt-3.5 border-b border-line-soft shrink-0">
            {(["profile", "assets", "activity", "settings"] as const).filter((t) => t !== "activity" || hasActivityTab).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-[12.5px] font-semibold border-b-2 cursor-pointer transition-colors ${tab === t ? "text-ink-1 border-accent" : "text-ink-3 border-transparent hover:text-ink-1"}`}
              >
                {t === "profile" ? "Profile" : t === "assets" ? "Assets" : t === "activity" ? "Activity" : "Settings"}
              </button>
            ))}
          </div>
        )}

        {/* body */}
        {member && (
          <div className="flex-1 overflow-y-auto min-h-[260px] px-5 py-4">
            {tab === "profile" && <ProfileTab member={member} setMember={setMember} scopes={scopes} />}
            {tab === "assets" && <AssetsTab member={member} setMember={setMember} scope={scope} onOpenSettings={(sec) => { onClose(); onOpenSettings?.(sec); }} />}
            {tab === "activity" && scope && (
              <div className="h-[420px] rounded-xl border border-line-soft overflow-hidden">
                <ActivityTab
                  roomId={scope.kind === "dm" ? scope.scopeId : scope.scopeId.replace(/^room:/, "")}
                  agentName={member.name}
                  dmScope={scope.kind === "dm" ? { scopeId: scope.scopeId, memberId: member.memberId } : undefined}
                />
              </div>
            )}
            {tab === "settings" && <SettingsTab member={member} setMember={setMember} scope={scope} models={models} onFired={onFired} />}
          </div>
        )}

        {/* footer: inline DM (Discord card signature — message the member in place) */}
        {member && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-line-soft shrink-0">
            <input
              value={dmDraft}
              onChange={(e) => setDmDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void sendDm(); }}
              placeholder={dmSent ? "Sent ✓" : `Message @${member.name}…`}
              className="flex-1 min-w-0 rounded-lg border border-line bg-inset px-3 py-2 text-[12.5px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4"
            />
            <button
              type="button"
              onClick={() => void sendDm()}
              disabled={!dmDraft.trim() || dmSending}
              title="Send to this member’s DM"
              className="shrink-0 w-9 h-9 rounded-lg bg-accent text-accent-contrast flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {dmSending ? <Loader2 size={14} className="animate-spin" /> : <SendHorizonal size={14} />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Profile tab: identity form + persona + skills + about ───────────────────

function ProfileTab({ member, setMember, scopes }: {
  member: MemberDetail;
  setMember: (m: MemberDetail) => void;
  scopes: MemberScopeInfo[];
}) {
  const [titleDraft, setTitleDraft] = useState(member.title ?? "");
  const [cardSave, setCardSave] = useState<SaveState>("idle");
  const [cardError, setCardError] = useState<string | null>(null);
  const [profile, setProfile] = useState<MemberProfileDoc | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMemberProfile(member.memberId).then((doc) => { if (!cancelled) setProfile(doc); }).catch(() => {});
    return () => { cancelled = true; if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [member.memberId]);

  const flashSaved = (set: (s: SaveState) => void) => {
    set("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => set("idle"), 1800);
  };


  const saveCard = async () => {
    const title = titleDraft.trim();
    if (title === (member.title ?? "")) return;
    setCardSave("saving"); setCardError(null);
    try {
      const res = await patchGlobalMember(member.memberId, { title });
      setMember(res.member);
      flashSaved(setCardSave);
    } catch (e) {
      setCardError(String((e as Error)?.message || e));
      setCardSave("error");
    }
  };

  return (
    <div className="space-y-4 pb-2">
      {/* identity — name read-only (routing key, T1), title editable */}
      <section>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[11px] font-semibold text-ink-3">Name</span>
              <span className="inline-flex cursor-help" title="The name is the routing key — it can’t be changed here.">
                <Info size={11} className="text-ink-4" />
              </span>
            </div>
            <div className="rounded-lg border border-line-soft bg-surface-1 px-3 py-2 text-[13px] text-ink-1">{member.name}</div>
          </div>
          <div>
            <div className="text-[11px] font-semibold text-ink-3 mb-1.5">Title</div>
            <div className="flex items-center gap-2">
              <input
                value={titleDraft}
                onChange={(e) => { setTitleDraft(e.target.value); setCardError(null); }}
                placeholder="e.g. Architect"
                className="flex-1 min-w-0 rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4"
              />
              <button
                type="button"
                onClick={() => void saveCard()}
                disabled={cardSave === "saving" || titleDraft.trim() === (member.title ?? "")}
                className="shrink-0 px-3.5 py-2 rounded-lg border border-line text-xs font-semibold text-ink-2 hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {cardSave === "saving" ? <Loader2 size={13} className="animate-spin" /> : cardSave === "saved" ? <span className="inline-flex items-center gap-1 text-onair"><Check size={13} />Saved</span> : "Save"}
              </button>
            </div>
            {cardError && <div role="alert" className="text-[11px] text-blocked mt-1.5">{cardError}</div>}
          </div>
        </div>
      </section>

      {/* persona — the member.md body in a plain read-only box (fish
       * 2026-09-02: name/title/persona/about only; the ⓘ carries the
       * "this is the persona file" note + path). */}
      <section>
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[11px] font-semibold text-ink-3">Persona</span>
          <span
            className="inline-flex cursor-help"
            title={profile?.path
              ? `This file IS ${member.name}'s persona — the member grows it from your feedback.\n${profile.path}`
              : `This file IS ${member.name}'s persona — the member grows it from your feedback.`}
          >
            <Info size={11} className="text-ink-4" />
          </span>
        </div>
        <div className="rounded-lg border border-line-soft bg-surface-1 px-3 py-2 max-h-[300px] overflow-y-auto">
          {profile === null ? (
            <div className="text-[12px] text-ink-4 py-1">Loading…</div>
          ) : !profile.body.trim() ? (
            <div className="text-[12px] text-ink-4 py-1">No persona yet — the member writes here as your feedback teaches it something lasting.</div>
          ) : (
            <div className="whitespace-pre-wrap font-mono text-[12px] text-ink-2 leading-relaxed">{profile.body}</div>
          )}
        </div>
      </section>

      {/* about */}
      <section className="rounded-xl border border-line-soft bg-surface-1 p-4">
        <div className="text-[10px] font-bold tracking-[0.06em] text-ink-4 uppercase mb-1.5">About</div>
        <div className="text-[12px] text-ink-3 leading-relaxed">
          {member.createdAt ? <>Member since <b className="text-ink-1 font-semibold">{new Date(member.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}</b> · </> : null}
          Scopes: {scopes.length === 0 ? <span className="text-ink-4">none yet</span> : scopes.map((s) => (
            <span key={s.scopeId} className="inline-flex items-center gap-1 mr-2">
              <span className={`w-1.5 h-1.5 rounded-full ${s.status === "working" ? "bg-onair" : "bg-ink-4"}`} />
              <b className="text-ink-1 font-semibold">{s.label}</b> <span className="text-ink-4">({s.kind})</span>
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

// ── Assets tab: what the member HAS (skills / extensions / tools / memory) ──
// Config is globally unified (batch 5b) — toggles here write the member's
// global lists, never per-scope. Memory is shared platform directories,
// shown as read-only pointers, never as a member-private asset (pm boundary).

function AssetsTab({ member, setMember, scope, onOpenSettings }: {
  member: MemberDetail;
  setMember: (m: MemberDetail) => void;
  scope: MemberScopeInfo | null;
  onOpenSettings: (section: "integrations" | "extensions") => void;
}) {
  const { toast } = useDialog();
  const [memberSkills, setMemberSkills] = useState<MemberSkillEntry[] | null>(null);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [mcpLoadStatus, setMcpLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [installedExtensions, setInstalledExtensions] = useState<ExtensionRecord[]>([]);
  const [extensionsLoadStatus, setExtensionsLoadStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    getMemberSkills(member.memberId).then((r) => { if (!cancelled) setMemberSkills(r.skills); }).catch(() => { if (!cancelled) setMemberSkills([]); });
    setMcpLoadStatus("loading");
    getMcpSettings().then((s) => { if (cancelled) return; setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); }).catch(() => { if (!cancelled) setMcpLoadStatus("error"); });
    setExtensionsLoadStatus("loading");
    getExtensions().then((e) => { if (cancelled) return; setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); }).catch(() => { if (!cancelled) setExtensionsLoadStatus("error"); });
    return () => { cancelled = true; };
  }, [member.memberId]);

  const saveGlobal = useCallback(async (patch: Record<string, unknown>, successMsg: string, errorMsg: string) => {
    try {
      const res = await patchGlobalMember(member.memberId, patch);
      setMember(res.member);
      toast(successMsg, "success");
    } catch (err) {
      console.error("Failed to update member assets", err);
      const detail = err instanceof Error && err.message ? ` ${err.message}` : "";
      toast(`${errorMsg}${detail}`, "error");
    }
  }, [member.memberId, setMember, toast]);

  const handleToggleMcp = useCallback(async (server: string) => {
    const current = new Set(member.global?.mcpServers ?? []);
    if (current.has(server)) current.delete(server); else current.add(server);
    const assignableNames = new Set(mcpServers.filter(isAssignableMcpServer).map((s) => s.name));
    const nextServers = mcpServers.map((s) => s.name).filter((name) => current.has(name) && assignableNames.has(name));
    await saveGlobal({ mcpServers: nextServers }, `${member.name} tool access saved. Restart the member to apply it.`, "Couldn’t save tool access.");
  }, [member, mcpServers, saveGlobal]);

  const handleToggleExtension = useCallback(async (extId: string) => {
    const current = new Set(member.global?.extensions ?? []);
    const hit = [...current].find((c) => c === extId || c === `npm:${extId}` || extId.endsWith(c) || c.endsWith(extId));
    if (hit) current.delete(hit); else current.add(extId);
    await saveGlobal({ extensions: Array.from(current) }, "Saved.", "Couldn’t save extension access.");
  }, [member, saveGlobal]);

  return (
    <div className="space-y-4 pb-2">
      <MemberSkillsCard skills={memberSkills} />
      <ExtensionsAccordion
        installedExtensions={installedExtensions}
        extensionsLoadStatus={extensionsLoadStatus}
        onRetryExtensions={() => {
          setExtensionsLoadStatus("loading");
          void getExtensions().then((e) => { setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); }).catch(() => setExtensionsLoadStatus("error"));
        }}
        memberExtensions={member.global?.extensions ?? []}
        onToggleExtension={handleToggleExtension}
        onOpenExtensionsSettings={() => onOpenSettings("extensions")}
      />
      <McpToolsAccordion
        mcpEnabled={mcpEnabled}
        mcpServers={mcpServers}
        mcpLoadStatus={mcpLoadStatus}
        onRetryMcp={() => {
          setMcpLoadStatus("loading");
          void getMcpSettings().then((s) => { setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); }).catch(() => setMcpLoadStatus("error"));
        }}
        memberMcpServers={member.global?.mcpServers ?? []}
        onToggleMcp={handleToggleMcp}
        onOpenMcpSettings={() => onOpenSettings("integrations")}
      />

      {/* active tools — this scope's live session (moved from Settings,
       * fish 2026-09-02 item 3: Settings keeps config, Assets lists tools) */}
      {scope && (
        <ActiveToolsSection
          roomId={scope.kind === "dm" ? scope.scopeId : scope.scopeId.replace(/^room:/, "")}
          memberRef={member.memberId || member.name}
          status={scope.status}
          reloadKey={0}
          dmScope={scope.kind === "dm" ? { scopeId: scope.scopeId, memberId: member.memberId } : undefined}
        />
      )}

      {/* memory — shared platform directories, pointers only */}
      <section className="rounded-xl border border-line-soft bg-surface-1">
        <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2">
          <h3 className="text-[13.5px] font-bold text-ink-1">Memory</h3>
        </div>
        <div className="px-4 py-3 space-y-2">
          {["~/.bossmode/memory/user/", "~/.bossmode/memory/projects/"].map((path) => (
            <div key={path} className="flex items-center gap-2.5 rounded-lg border border-dashed border-line px-3 py-2">
              <span className="font-mono text-[11.5px] text-ink-3 truncate">{path}</span>
            </div>
          ))}
          <p className="text-[11px] text-ink-4 leading-relaxed">
            Shared across all members — the same directories everyone reads.
          </p>
        </div>
      </section>

      <SystemPromptSection member={member} scope={scope} />
    </div>
  );
}

/** The member's assembled system prompt for the current scope — same compiler
 * as activation, byte-identical (fish 2026-09-02 item 5). Falls back to the
 * member's DM scope when the float is opened globally (Contacts). */
function SystemPromptSection({ member, scope }: { member: MemberDetail; scope: MemberScopeInfo | null }) {
  const [doc, setDoc] = useState<MemberSystemPromptDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const effectiveScope = scope?.scopeId ?? `dm:${member.memberId}`;

  useEffect(() => {
    let cancelled = false;
    setDoc(null); setFailed(false);
    getMemberSystemPrompt(member.memberId, effectiveScope)
      .then((d) => { if (!cancelled) setDoc(d); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [member.memberId, effectiveScope]);

  const copy = async () => {
    if (!doc) return;
    const ok = await copyText(doc.text);
    setCopied(ok);
    window.setTimeout(() => setCopied(null), 1400);
  };

  return (
    <section className="rounded-xl border border-line-soft bg-surface-1">
      <div className="px-4 py-2.5 border-b border-line-soft flex items-center gap-2">
        <h3 className="text-[13.5px] font-bold text-ink-1">System prompt</h3>
        <span className="inline-flex cursor-help" title="The exact prompt this member runs with in this scope — assembled live, byte-identical to what activation injects.">
          <Info size={11} className="text-ink-4" />
        </span>
        {doc && <span className="text-[10px] text-ink-4 tabular-nums">{doc.charCount.toLocaleString()} chars</span>}
        {doc && (
          <button
            type="button"
            onClick={() => void copy()}
            title={copied === false ? "Copy failed — clipboard unavailable" : "Copy the full prompt"}
            className="ml-auto shrink-0 inline-flex items-center gap-1 rounded-md border border-line-soft px-2 py-1 text-[10.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-1 cursor-pointer"
          >
            {copied === true ? <Check size={11} className="text-onair" /> : copied === false ? <X size={11} className="text-blocked" /> : <Copy size={11} />}
            {copied === true ? "Copied" : copied === false ? "Failed" : "Copy"}
          </button>
        )}
      </div>
      <div className="px-4 py-3">
        {failed ? (
          <div className="text-[12px] text-ink-4 py-1">Couldn’t load the system prompt for this scope.</div>
        ) : doc === null ? (
          <div className="text-[12px] text-ink-4 py-1">Loading…</div>
        ) : (
          <div className="rounded-lg border border-line-soft bg-inset/50 px-3 py-2 max-h-[340px] overflow-y-auto">
            <div className="whitespace-pre-wrap font-mono text-[11.5px] text-ink-3 leading-relaxed">{doc.text}</div>
          </div>
        )}
        {doc && (
          <div className="mt-2 font-mono text-[10.5px] text-ink-4 truncate" title={`scope ${doc.scopeId} · contract ${doc.contractFingerprint}`}>
            {doc.scopeId} · {doc.contractFingerprint.slice(0, 8)}
          </div>
        )}
      </div>
    </section>
  );
}

function ModelRowSelect({ value, models, onChange }: {
  value: { model: string | null; credentialId: string | null };
  models: AvailableModelOption[];
  onChange: (v: { model: string | null; credentialId: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const current = value.model
    ? models.find((m) => (value.credentialId ? m.profileId === value.credentialId && m.ref === value.model : m.ref === value.model))
    : undefined;
  const rows = [...models].sort((a, b) =>
    (a.providerDisplayName || a.providerSlug).localeCompare(b.providerDisplayName || b.providerSlug) || (a.displayName || a.modelId).localeCompare(b.displayName || b.modelId));
  const pairCount = new Map<string, number>();
  for (const m of rows) {
    const k = `${m.displayName || m.modelId}::${m.providerDisplayName || m.providerSlug}`;
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  const quietLabel = (m: AvailableModelOption) => {
    const provider = m.providerDisplayName || m.providerSlug;
    const k = `${m.displayName || m.modelId}::${provider}`;
    return pairCount.get(k)! > 1 ? `${provider} · ${m.profileName}` : provider;
  };

  const caps = (m: AvailableModelOption) => {
    const parts = [m.provider || m.providerSlug];
    if (m.contextWindow) parts.push(`${formatTokens(m.contextWindow)} ctx`);
    if (m.maxTokens) parts.push(`${formatTokens(m.maxTokens)} out`);
    if (m.reasoning) parts.push("thinking");
    if (m.images) parts.push("images");
    return parts.join(" · ");
  };

  const rowLabel = (m: AvailableModelOption) => m.displayName || m.modelId;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 rounded-lg border border-line bg-inset px-3 py-2 text-left cursor-pointer hover:border-line-strong transition-colors"
      >
        {current ? (
          <>
            <span className="text-[13px] font-semibold text-ink-1 truncate">{rowLabel(current)}</span>
            <span className="text-[11px] text-ink-4 truncate">{quietLabel(current)}</span>
          </>
        ) : value.model ? (
          <>
            <span className="text-[13px] font-semibold text-think truncate">{value.model}</span>
            <span className="text-[11px] text-think truncate">unavailable</span>
          </>
        ) : (
          <span className="text-[13px] text-ink-4">Not configured</span>
        )}
        <ChevronDown size={12} className={`ml-auto shrink-0 text-ink-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-64 overflow-y-auto rounded-lg border border-line-strong bg-surface-3 p-1" style={{ boxShadow: "var(--shadow-pop)" }}>
          <button
            type="button"
            onClick={() => { setOpen(false); onChange({ model: null, credentialId: null }); }}
            className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left cursor-pointer hover:bg-surface-2 transition-colors"
          >
            <span className="text-[12.5px] text-ink-4">Not configured</span>
            {!value.model && <Check size={12} className="ml-auto shrink-0 text-accent-ink" />}
          </button>
          {value.model && !current && (
            <div className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 opacity-70">
              <span className="text-[12.5px] font-medium text-think truncate">{value.model}</span>
              <span className="text-[10.5px] text-think truncate">unavailable</span>
              <Check size={12} className="ml-auto shrink-0 text-think" />
            </div>
          )}
          {rows.map((m) => {
            const selected = current ? m.profileId === current.profileId && m.ref === current.ref : false;
            return (
              <button
                key={`${m.profileId}::${m.ref}`}
                type="button"
                title={caps(m)}
                onClick={() => { setOpen(false); onChange({ model: m.ref, credentialId: m.profileId }); }}
                className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left cursor-pointer hover:bg-surface-2 transition-colors"
              >
                <span className="text-[12.5px] font-medium text-ink-1 truncate">{rowLabel(m)}</span>
                <span className="text-[10.5px] text-ink-4 truncate">{quietLabel(m)}</span>
                {selected && <Check size={12} className="ml-auto shrink-0 text-accent-ink" />}
              </button>
            );
          })}
          {rows.length === 0 && (
            <div className="px-2.5 py-2 text-[11px] text-think">No models available. Connect a provider in Settings → Models.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Settings tab: the member's global model + this scope's session + fire ───
// Batch 5b: config is globally unified — no per-scope model card, no unified
// toggles, no "following global" banner. The model select IS the global one.

function SettingsTab({ member, setMember, scope, models, onFired }: {
  member: MemberDetail;
  setMember: (m: MemberDetail) => void;
  scope: MemberScopeInfo | null;
  models: AvailableModelOption[];
  onFired: () => void;
}) {
  const { toast, confirm } = useDialog();
  const [cfgSave, setCfgSave] = useState<SaveState>("idle");
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [fireDraft, setFireDraft] = useState("");
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dm = scope?.kind === "dm";
  const roomId = scope && !dm ? scope.scopeId.replace(/^room:/, "") : null;
  const [contextUsage, setContextUsage] = useState<ContextUsageData | undefined>();

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    getConversationSession(scope.scopeId, member.memberId).then((s) => { if (!cancelled) setContextUsage(s.contextUsage); }).catch(() => {});
    return () => { cancelled = true; if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [dm, roomId, member.memberId, scope]);

  const handleCompact = useCallback(async () => {
    if (!scope) return;
    try {
      if (dm) await conversationMemberAction(scope.scopeId, member.memberId, "steer", "/compact");
      else await steerAgent(roomId!, member.memberId, "/compact");
      toast(`Compact started for ${member.name}`, "success");
    } catch (err) { console.error(err); toast("Couldn’t compact this conversation. Try again.", "error"); }
  }, [dm, roomId, member, scope, toast]);
  const handleResetSession = useCallback(async () => {
    if (!scope) return;
    const ok = await confirm(`Reset session for @${member.name}?\n\nThis clears the member's working session memory and starts fresh. Messages and activity history stay visible.`);
    if (!ok) return;
    try {
      if (dm) await conversationMemberAction(scope.scopeId, member.memberId, "reset-session");
      else await resetAgentSession(roomId!, member.memberId);
      toast(`${member.name} session reset`, "success");
    } catch (err) { console.error(err); toast("Couldn’t reset this session. Try again.", "error"); }
  }, [dm, roomId, member, scope, confirm, toast]);
  const handleRestart = useCallback(async () => {
    if (!roomId) return;
    try {
      await restartMember(member.memberId, roomId);
      toast(`${member.name} restarted`, "success");
    } catch (err) { console.error(err); toast("Couldn’t restart this member. Try again.", "error"); }
  }, [member, roomId, toast]);

  const flashCfg = () => {
    setCfgSave("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setCfgSave("idle"), 1800);
  };
  const saveConfig = async (patch: Record<string, unknown>) => {
    setCfgSave("saving"); setCfgError(null);
    try {
      const res = await patchGlobalMember(member.memberId, patch);
      setMember(res.member);
      flashCfg();
    } catch (e) {
      setCfgError(String((e as Error)?.message || e));
      setCfgSave("error");
    }
  };
  const fire = async () => {
    if (firing) return;
    setFiring(true); setFireError(null);
    try { await deleteGlobalMember(member.memberId); onFired(); }
    catch (e) { setFireError(String((e as Error)?.message || e)); setFiring(false); }
  };

  const globalModel = member.global?.model ?? null;
  const globalCredentialId = member.global?.credentialId ?? null;
  const globalThinking = member.global?.thinkingLevel ?? "";
  const boundModel = findModelOptionForBinding(globalModel, globalCredentialId, models);
  const thinkingOptions = availableThinkingLevels(boundModel).filter((l) => l.value !== null).map((l) => l.value as string);
  const thinkingCurrent = globalThinking || "off";
  const thinkingAll = thinkingOptions.includes(thinkingCurrent) ? thinkingOptions : [thinkingCurrent, ...thinkingOptions];

  return (
    <div className="space-y-4 pb-2">
      {/* the member's model — global, applies to every scope */}
      <section className="rounded-xl border border-line-soft bg-surface-1 p-4">
        <div className="text-[13px] font-semibold text-ink-1">Model</div>
        <div className="text-[11px] text-ink-4 mt-0.5">Applies on the next turn.</div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_170px] gap-2.5 items-start mt-3">
          <label className="block space-y-1.5 min-w-0">
            <span className="text-[11px] font-medium text-ink-3">Model</span>
            <ModelRowSelect
              value={{ model: globalModel, credentialId: globalCredentialId }}
              models={models}
              onChange={(v) => void saveConfig({ model: v.model, credentialId: v.credentialId })}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium text-ink-3">Think level</span>
            <select
              value={thinkingCurrent}
              onChange={(e) => void saveConfig({ thinkingLevel: e.target.value === "off" ? null : e.target.value })}
              className="w-full bg-surface-3 border border-line rounded px-2.5 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
            >
              {thinkingAll.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </label>
        </div>
        <div className="flex items-center gap-2 mt-2 min-h-4">
          {cfgSave === "saving" && <span className="text-[11px] text-ink-4 inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />Saving…</span>}
          {cfgSave === "saved" && <span className="text-[11px] text-onair inline-flex items-center gap-1"><Check size={11} />Saved</span>}
          {cfgError && <span role="alert" className="text-[11px] text-blocked">{cfgError}</span>}
        </div>
      </section>

      {/* this scope's live session — operational actions stay scope-bound */}
      {scope && (
        <ContextSessionCard contextUsage={contextUsage} onCompact={handleCompact} onResetSession={handleResetSession} onRestart={handleRestart} dm={!!dm} />
      )}

      {/* danger */}
      <section>
        <div className="rounded-xl border border-blocked/40 bg-blocked/5 px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="text-blocked shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink-1">Fire {member.name}</div>
              <p className="text-[11.5px] text-ink-3 mt-1 leading-snug">
                The member leaves every room and their chat windows close. Persona and scope notes are archived.
              </p>
              <div className="flex items-center gap-2 mt-3">
                <input
                  value={fireDraft}
                  onChange={(e) => setFireDraft(e.target.value)}
                  placeholder={`Type "${member.name}" to confirm`}
                  className="flex-1 rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-blocked placeholder:text-ink-4"
                />
                <button
                  type="button"
                  onClick={() => void fire()}
                  disabled={fireDraft.trim() !== member.name || firing}
                  className="px-3.5 py-2 rounded-lg bg-blocked text-white text-xs font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {firing ? <Loader2 size={13} className="animate-spin" /> : "Fire member"}
                </button>
              </div>
              {fireError && <div role="alert" className="text-[11px] text-blocked mt-1.5">{fireError}</div>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
