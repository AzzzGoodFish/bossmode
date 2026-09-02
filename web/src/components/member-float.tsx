/**
 * member-float.tsx — the member detail FLOAT (fish 2026-09-02: "详情给一个
 * 浮窗吧，不要全页的" + "不要原来那个整页的配置页面了"). The depth ladder is
 * now fully Discord-shaped:
 *
 *   peek card (roster click — glance, never leaves the conversation)
 *   → detail float (this file — read-deep + config, Profile/Activity/Settings)
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
import { AlertTriangle, Check, ChevronRight, Loader2, SendHorizonal, X } from "lucide-react";
import { ToggleSwitch } from "./ToggleSwitch";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { ActivityTab } from "./ActivityTab";
import { useDialog } from "./dialogs";
import {
  MemberMdCard, MemberSkillsCard, CoreCard, ScopeModelCard, ContextSessionCard,
  ExtensionsAccordion, McpToolsAccordion, ActiveToolsSection, isAssignableMcpServer,
  formatTokens, compactModelId,
} from "./member-scope";
import {
  getMemberDetail, getMemberScopes, getAvailableModels, getContacts,
  patchGlobalMember, deleteGlobalMember, getMemberProfile, getMemberSkills,
  getRoomMembers, updateRoomMember, steerAgent, restartMember, resetAgentSession,
  getMemberStats, getMemberCorePrompt,
  getMemberEffectiveConfig, patchMemberScopeConfig, getMemberScopedStats, getMemberCorePromptScoped,
  getConversationSession, conversationMemberAction, getMcpSettings, getExtensions, sendDmMessage,
  type MemberDetail, type MemberScopeInfo, type AvailableModelOption,
  type MemberInfo, type MemberProfileDoc, type MemberSkillEntry, type MemberStats,
  type ContextUsageData, type McpServerSummary, type ExtensionRecord,
} from "../api/client";

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/i;
type SaveState = "idle" | "saving" | "saved" | "error";

// ── context ─────────────────────────────────────────────────────────────────

type FloatTarget = { memberId: string; scopeId?: string };
const MemberFloatCtx = createContext<{ open: (memberId: string, scopeId?: string) => void }>({ open: () => {} });
export const useMemberFloat = () => useContext(MemberFloatCtx);

export function MemberFloatProvider({ children, onFired }: { children: React.ReactNode; onFired?: () => void }) {
  const [target, setTarget] = useState<FloatTarget | null>(null);
  const open = useCallback((memberId: string, scopeId?: string) => setTarget({ memberId, scopeId }), []);
  return (
    <MemberFloatCtx.Provider value={{ open }}>
      {children}
      {target && <MemberDetailFloat memberId={target.memberId} scopeId={target.scopeId} onClose={() => setTarget(null)} onFired={() => { setTarget(null); onFired?.(); }} />}
    </MemberFloatCtx.Provider>
  );
}

/** Banner hue derived from the member's name — every member's card/float gets
 * its own face color (prototype member-peek-v1, fish-picked). */
export function memberHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ── the float ───────────────────────────────────────────────────────────────

function MemberDetailFloat({ memberId, scopeId, onClose, onFired }: {
  memberId: string;
  scopeId?: string;
  onClose: () => void;
  onFired: () => void;
}) {
  const { toast } = useDialog();
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [scopes, setScopes] = useState<MemberScopeInfo[]>([]);
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [existingNames, setExistingNames] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"profile" | "activity" | "settings">("profile");
  const [dmDraft, setDmDraft] = useState("");
  const [dmSent, setDmSent] = useState(false);
  const [dmSending, setDmSending] = useState(false);

  useEffect(() => {
    getMemberDetail(memberId).then(setMember).catch((e) => setLoadError(String(e?.message || e)));
    getMemberScopes(memberId).then((r) => setScopes(r.scopes)).catch(() => {});
    getAvailableModels().then(setModels).catch(() => {});
    getContacts().then((r) => setExistingNames(new Set(r.contacts.map((c) => c.name.toLowerCase())))).catch(() => {});
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

  const hue = memberHue(member?.name ?? "?");
  const hasActivityTab = !!scope;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-[720px] max-w-[calc(100vw-48px)] max-h-[calc(100vh-96px)] rounded-2xl border border-line-strong bg-surface-1 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={member ? `${member.name} details` : "Member details"}
      >
        {/* banner + header */}
        <div className="h-14 shrink-0" style={{ background: `linear-gradient(120deg, hsl(${hue} 45% 38% / .85), hsl(${hue} 40% 22% / .4))` }} />
        <button onClick={onClose} title="Close" className="absolute top-3 right-3 w-7 h-7 rounded-lg bg-black/40 text-ink-1 hover:bg-black/60 flex items-center justify-center cursor-pointer z-10"><X size={14} /></button>
        <div className="px-5 flex items-end gap-3.5 -mt-7 shrink-0">
          <div className="rounded-full ring-4 ring-surface-1"><StaffBadge name={member?.name ?? "?"} status={scope ? statusFromAgent(scope.status) : "offline"} size="lg" /></div>
          <div className="min-w-0 pb-0.5">
            {member ? (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[17px] font-bold text-ink-1 truncate">{member.name}</span>
                  {scope && <span className="text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 bg-accent-dim text-accent-ink shrink-0">{scope.kind === "dm" ? "this DM" : "this room"}</span>}
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
            {(["profile", "activity", "settings"] as const).filter((t) => t !== "activity" || hasActivityTab).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-2 text-[12.5px] font-semibold border-b-2 cursor-pointer transition-colors ${tab === t ? "text-ink-1 border-accent" : "text-ink-3 border-transparent hover:text-ink-1"}`}
              >
                {t === "profile" ? "Profile" : t === "activity" ? "Activity" : "Settings"}
              </button>
            ))}
          </div>
        )}

        {/* body */}
        {member && (
          <div className="flex-1 overflow-y-auto min-h-[260px] px-5 py-4">
            {tab === "profile" && <ProfileTab member={member} setMember={setMember} scopes={scopes} existingNames={existingNames} setExistingNames={setExistingNames} />}
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

function ProfileTab({ member, setMember, scopes, existingNames, setExistingNames }: {
  member: MemberDetail;
  setMember: (m: MemberDetail) => void;
  scopes: MemberScopeInfo[];
  existingNames: Set<string>;
  setExistingNames: (fn: (prev: Set<string>) => Set<string>) => void;
}) {
  const [nameDraft, setNameDraft] = useState(member.name);
  const [nameSave, setNameSave] = useState<SaveState>("idle");
  const [nameError, setNameError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState(member.title ?? "");
  const [descDraft, setDescDraft] = useState(member.description ?? "");
  const [cardSave, setCardSave] = useState<SaveState>("idle");
  const [cardError, setCardError] = useState<string | null>(null);
  const [profile, setProfile] = useState<MemberProfileDoc | null>(null);
  const [memberSkills, setMemberSkills] = useState<MemberSkillEntry[] | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMemberProfile(member.memberId).then((doc) => { if (!cancelled) setProfile(doc); }).catch(() => {});
    getMemberSkills(member.memberId).then((r) => { if (!cancelled) setMemberSkills(r.skills); }).catch(() => { if (!cancelled) setMemberSkills([]); });
    return () => { cancelled = true; if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [member.memberId]);

  const flashSaved = (set: (s: SaveState) => void) => {
    set("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => set("idle"), 1800);
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!NAME_RE.test(next)) { setNameError("Letters, digits, - and _ only, up to 32 chars."); return; }
    if (next.toLowerCase() !== member.name.toLowerCase() && existingNames.has(next.toLowerCase())) { setNameError("That name is taken."); return; }
    if (next === member.name) return;
    setNameSave("saving"); setNameError(null);
    try {
      const res = await patchGlobalMember(member.memberId, { name: next });
      setMember(res.member);
      setExistingNames((prev) => { const s = new Set(prev); s.delete(member.name.toLowerCase()); s.add(next.toLowerCase()); return s; });
      flashSaved(setNameSave);
    } catch (e) {
      setNameError(String((e as Error)?.message || e));
      setNameSave("error");
    }
  };

  const saveCard = async () => {
    const title = titleDraft.trim();
    const description = descDraft.trim();
    if (title === (member.title ?? "") && description === (member.description ?? "")) return;
    setCardSave("saving"); setCardError(null);
    try {
      const res = await patchGlobalMember(member.memberId, { title, description });
      setMember(res.member);
      flashSaved(setCardSave);
    } catch (e) {
      setCardError(String((e as Error)?.message || e));
      setCardSave("error");
    }
  };

  const nameChanged = nameDraft.trim() !== member.name;

  return (
    <div className="space-y-4 pb-2">
      {/* identity — the card fields */}
      <section>
        <div className="text-[11px] font-semibold text-ink-3 mb-1.5">Name</div>
        <div className="flex items-center gap-2">
          <input
            value={nameDraft}
            onChange={(e) => { setNameDraft(e.target.value); setNameError(null); }}
            className="flex-1 min-w-0 rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void saveName()}
            disabled={!nameChanged || nameSave === "saving"}
            className="shrink-0 px-3.5 py-2 rounded-lg border border-line text-xs font-semibold text-ink-2 hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {nameSave === "saving" ? <Loader2 size={13} className="animate-spin" /> : nameSave === "saved" ? <span className="inline-flex items-center gap-1 text-onair"><Check size={13} />Saved</span> : "Rename"}
          </button>
        </div>
        {nameError && <div role="alert" className="text-[11px] text-blocked mt-1.5">{nameError}</div>}
        <div className="grid grid-cols-2 gap-3 mt-3">
          <div>
            <div className="text-[11px] font-semibold text-ink-3 mb-1.5">Title</div>
            <input
              value={titleDraft}
              onChange={(e) => { setTitleDraft(e.target.value); setCardError(null); }}
              placeholder="e.g. Architect — the role on the card"
              className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4"
            />
          </div>
          <div>
            <div className="text-[11px] font-semibold text-ink-3 mb-1.5">Description</div>
            <input
              value={descDraft}
              onChange={(e) => { setDescDraft(e.target.value); setCardError(null); }}
              placeholder="What this member is for and how it works."
              className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => void saveCard()}
            disabled={cardSave === "saving" || (titleDraft.trim() === (member.title ?? "") && descDraft.trim() === (member.description ?? ""))}
            className="px-3.5 py-2 rounded-lg border border-line text-xs font-semibold text-ink-2 hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {cardSave === "saving" ? <Loader2 size={13} className="animate-spin" /> : cardSave === "saved" ? <span className="inline-flex items-center gap-1 text-onair"><Check size={13} />Saved</span> : "Save card"}
          </button>
          {cardError && <div role="alert" className="text-[11px] text-blocked">{cardError}</div>}
        </div>
      </section>

      {/* persona + skills (global content) */}
      <MemberMdCard profile={profile} memberName={member.name} />
      <MemberSkillsCard skills={memberSkills} />

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

// ── Settings tab: scope config (when scoped) + global config + danger ───────

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
  const dmScope = dm && scope ? { scopeId: scope.scopeId, memberId: member.memberId } : undefined;

  const [memberInfo, setMemberInfo] = useState<MemberInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageData | undefined>();
  const [corePrompt, setCorePrompt] = useState<{ content: string; charCount: number } | null>(null);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [mcpLoadStatus, setMcpLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [installedExtensions, setInstalledExtensions] = useState<ExtensionRecord[]>([]);
  const [extensionsLoadStatus, setExtensionsLoadStatus] = useState<"loading" | "ready" | "error">("loading");

  const loadMemberInfo = useCallback(async () => {
    if (!scope) return;
    if (dm && scope) {
      const eff = await getMemberEffectiveConfig(member.memberId, scope.scopeId).catch(() => null);
      setMemberInfo({
        id: member.memberId, name: member.name, agent: member.agentTemplate, title: member.title ?? null,
        model: eff?.model ?? member.global?.model ?? null,
        credentialId: eff?.credentialId ?? member.global?.credentialId ?? null,
        thinkingLevel: eff?.thinkingLevel ?? member.global?.thinkingLevel ?? "",
        mcpServers: eff?.mcpServers ?? member.global?.mcpServers ?? [],
        extensions: eff?.extensions ?? member.global?.extensions ?? [],
        createdAt: member.createdAt,
      });
    } else if (roomId) {
      const members = await getRoomMembers(roomId).catch(() => [] as MemberInfo[]);
      const found = members.find((m) => m.id === member.memberId || m.name === member.name);
      if (found) setMemberInfo(found);
    }
  }, [dm, roomId, member, scope]);

  useEffect(() => { void loadMemberInfo(); }, [loadMemberInfo]);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    (dm
      ? getMemberCorePromptScoped(member.memberId, scope.scopeId)
      : getMemberCorePrompt(roomId!, member.memberId)
    ).then((r) => { if (!cancelled) setCorePrompt(r); }).catch(() => { if (!cancelled) setCorePrompt({ content: "", charCount: 0 }); });
    getConversationSession(scope.scopeId, member.memberId).then((s) => { if (!cancelled) setContextUsage(s.contextUsage); }).catch(() => {});
    setMcpLoadStatus("loading");
    getMcpSettings().then((s) => { if (cancelled) return; setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); }).catch(() => { if (!cancelled) setMcpLoadStatus("error"); });
    setExtensionsLoadStatus("loading");
    getExtensions().then((e) => { if (cancelled) return; setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); }).catch(() => { if (!cancelled) setExtensionsLoadStatus("error"); });
    return () => { cancelled = true; };
  }, [dm, roomId, member.memberId, scope]);

  const applyPatch = useCallback(
    async (patch: Record<string, unknown>, successMsg: string, errorMsg: string) => {
      if (!scope) return;
      try {
        if (dm) { await patchMemberScopeConfig(member.memberId, scope.scopeId, patch); await loadMemberInfo(); }
        else { const updated = await updateRoomMember(roomId!, member.memberId, patch); setMemberInfo(updated); }
        toast(successMsg, "success");
      } catch (err) {
        console.error("Failed to update member config", err);
        const detail = err instanceof Error && err.message ? ` ${err.message}` : "";
        toast(`${errorMsg}${detail}`, "error");
      }
    },
    [dm, roomId, member, scope, loadMemberInfo, toast],
  );

  const handleSwitchModel = useCallback((model: string | null, credentialId: string | null) =>
    applyPatch({ model, credentialId }, `${member.name} model updated. It applies on the next turn.`, "Couldn’t update the model."), [applyPatch, member.name]);
  const handleSwitchThinking = useCallback((thinkingLevel: string | null) =>
    applyPatch({ thinkingLevel }, `${member.name} thinking → ${thinkingLevel ?? "default"}`, "Couldn’t update the thinking level."), [applyPatch, member.name]);
  const handleToggleMcp = useCallback(async (server: string) => {
    if (!memberInfo) return;
    const current = new Set(memberInfo.mcpServers || []);
    if (current.has(server)) current.delete(server); else current.add(server);
    const assignableNames = new Set(mcpServers.filter(isAssignableMcpServer).map((s) => s.name));
    const nextServers = mcpServers.map((s) => s.name).filter((name) => current.has(name) && assignableNames.has(name));
    await applyPatch({ mcpServers: nextServers }, `${memberInfo.name} tool access saved. Restart the member to apply it.`, "Couldn’t save tool access.");
  }, [memberInfo, mcpServers, applyPatch]);
  const handleToggleExtension = useCallback(async (extId: string) => {
    if (!memberInfo) return;
    const current = new Set(memberInfo.extensions || []);
    const hit = [...current].find((c) => c === extId || c === `npm:${extId}` || extId.endsWith(c) || c.endsWith(extId));
    if (hit) current.delete(hit); else current.add(extId);
    await applyPatch({ extensions: Array.from(current) }, "Saved.", "Couldn’t save extension access.");
  }, [memberInfo, applyPatch]);
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

  const groupedModels = useMemo(() => {
    const groups = new Map<string, AvailableModelOption[]>();
    for (const m of models) {
      const key = m.profileName || m.providerSlug;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return [...groups.entries()];
  }, [models]);

  return (
    <div className="space-y-4 pb-2">
      {/* scope config — only when the float is scope-bound */}
      {scope && memberInfo && (
        <>
          <ScopeModelCard
            dm={!!dm}
            member={memberInfo}
            models={models}
            unifiedModel={member.unifiedModel}
            globalModelLabel={member.global?.model ?? null}
            onGoGlobal={() => { document.getElementById("mf-global-defaults")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
            onSwitchModel={handleSwitchModel}
            onSwitchThinking={handleSwitchThinking}
          />
          <ContextSessionCard contextUsage={contextUsage} onCompact={handleCompact} onResetSession={handleResetSession} onRestart={handleRestart} dm={!!dm} />
          <ActiveToolsSection roomId={dm ? scope.scopeId : roomId!} memberRef={memberInfo.id || memberInfo.name} status={scope.status} reloadKey={0} dmScope={dmScope} />
          <ExtensionsAccordion
            installedExtensions={installedExtensions}
            extensionsLoadStatus={extensionsLoadStatus}
            onRetryExtensions={() => {
              setExtensionsLoadStatus("loading");
              void getExtensions().then((e) => { setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); }).catch(() => setExtensionsLoadStatus("error"));
            }}
            memberExtensions={memberInfo.extensions || []}
            onToggleExtension={handleToggleExtension}
          />
          <McpToolsAccordion
            mcpEnabled={mcpEnabled}
            mcpServers={mcpServers}
            mcpLoadStatus={mcpLoadStatus}
            onRetryMcp={() => {
              setMcpLoadStatus("loading");
              void getMcpSettings().then((s) => { setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); }).catch(() => setMcpLoadStatus("error"));
            }}
            memberMcpServers={memberInfo.mcpServers || []}
            onToggleMcp={handleToggleMcp}
            onOpenMcpSettings={() => {}}
          />
          <CoreCard corePrompt={corePrompt} />
        </>
      )}

      {/* global config — always present */}
      <section id="mf-global-defaults">
        <div className="text-[10px] font-bold tracking-[0.06em] text-ink-4 uppercase mb-2">Global defaults</div>
        <div className="rounded-xl border border-line divide-y divide-line-soft">
          <div className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold text-ink-1">Unified model</div>
                <div className="text-[11px] text-ink-4 mt-0.5">
                  {member.unifiedModel ? "Every scope uses the global model below." : "Model is configured per scope."}
                </div>
              </div>
              <ToggleSwitch on={member.unifiedModel} onToggle={(v) => void saveConfig({ unifiedModel: v })} label="Unified model" />
            </div>
            {member.unifiedModel && (
              <select
                value={member.global?.model ?? ""}
                onChange={(e) => void saveConfig({ model: e.target.value || null })}
                className="mt-3 w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent cursor-pointer"
              >
                <option value="">Not configured</option>
                {groupedModels.map(([group, items]) => (
                  <optgroup key={group} label={group}>
                    {items.map((m) => (
                      <option key={m.ref} value={m.ref}>{m.displayName || m.modelId} · {m.ref}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </div>
          <div className="px-4 py-3.5 flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold text-ink-1">Unified extensions</div>
              <div className="text-[11px] text-ink-4 mt-0.5">
                {member.unifiedExtensions ? "Skills, extensions, and MCP servers are shared across scopes." : "Extensions are configured per scope."}
              </div>
            </div>
            <ToggleSwitch on={member.unifiedExtensions} onToggle={(v) => void saveConfig({ unifiedExtensions: v })} label="Unified extensions" />
          </div>
        </div>
        <div className="flex items-center gap-2 mt-2 min-h-4">
          {cfgSave === "saving" && <span className="text-[11px] text-ink-4 inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />Saving…</span>}
          {cfgSave === "saved" && <span className="text-[11px] text-onair inline-flex items-center gap-1"><Check size={11} />Saved</span>}
          {cfgError && <span role="alert" className="text-[11px] text-blocked">{cfgError}</span>}
        </div>
      </section>

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
