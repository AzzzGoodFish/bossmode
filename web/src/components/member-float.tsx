import { useMemberProfileRevision } from "../hooks/useMemberProfileRevision";
/**
 * member-float.tsx — the member detail FLOAT (fish 2026-09-02: "give details a float window, not a full page" + "drop the old full-page config page"). The depth ladder is
 * now fully Discord-shaped:
 *
 *   peek card (roster click — glance, never leaves the conversation)
 *   → detail float (this file — read-deep + config, Profile/Assets/Activity/Settings)
 *
 * The full-page member route is retired; MemberPage's sections move in here
 * as tabs (Profile first — fish: "profile "). No character arrows
 * in chrome (fish: "").
 *
 * One float instance lives at the Layout root (MemberFloatProvider); open it
 * from anywhere with useMemberFloat().open(memberId, scopeId?).
 *   scopeId `room:<id>`   → scope view tagged "this room"
 *   scopeId `dm:<member>` → scope view tagged "this DM"
 *   absent (global)       → global-only: Profile + Settings (no Activity tab)
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Info, Loader2, SendHorizonal, X } from "lucide-react";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { ActivityTab } from "./ActivityTab";
import { useDialog } from "./dialogs";
import { copyText } from "../utils/clipboard";
import {
  MemberSkillsCard, ContextSessionCard, ActiveToolsSection,
  buildModelRows, type RowOption,
  AssetSection, assetRowClass, assetActionClass, assetEmptyClass, assetFooterClass,
} from "./member-scope";
import { availableThinkingLevels, findModelOptionForBinding } from "./thinking-levels";
import {
  getMemberDetail, getMemberScopes, getAvailableModels,
  patchGlobalMember, deleteGlobalMember, getMemberProfile, getMemberSkills,
  getMemberStats, getMemberSystemPrompt, getMemberAssets,
  getMemberScopedStats,
  getConversationSession, memberAction, sendDmMessage,
  type MemberDetail, type MemberScopeInfo, type AvailableModelOption,
  type MemberProfileDoc, type MemberSkillEntry, type MemberStats,
  type ContextUsageData, type MemberSystemPromptDoc, type MemberAssets,
  type MemberExtensionAsset,
} from "../api/client";

type SaveState = "idle" | "saving" | "saved" | "error";

// ── context ─────────────────────────────────────────────────────────────────

type FloatTab = "profile" | "assets" | "activity" | "settings";
type FloatTarget = { memberId: string; scopeId?: string; tab?: FloatTab };

/** The float context is the roster↔float shared channel. saveMember is the
 * SINGLE save path for a member's global config (fish 2026-09-05: the float
 * Settings tab and the Workstations chips each called patchGlobalMember
 * directly and only updated their own view — switching a model in one place
 * left the other showing the old one). It patches, then bumps the member's
 * save version; every view depends on saveVersions and refetches, so no view
 * can forget to sync. */
type MemberFloatContextValue = {
  open: (memberId: string, scopeId?: string, tab?: FloatTab) => void;
  saveMember: (memberId: string, patch: Record<string, unknown>) => Promise<MemberDetail>;
  saveVersions: Readonly<Record<string, number>>;
};
const MemberFloatCtx = createContext<MemberFloatContextValue>({ open: () => {}, saveMember: () => Promise.reject(new Error("no float provider")), saveVersions: {} });
export const useMemberFloat = () => useContext(MemberFloatCtx);

export function MemberFloatProvider({ children, onFired, liveStatuses }: { children: React.ReactNode; onFired?: () => void; liveStatuses?: ReadonlyMap<string, string> }) {
  const [target, setTarget] = useState<FloatTarget | null>(null);
  const open = useCallback((memberId: string, scopeId?: string, tab?: FloatTab) => setTarget({ memberId, scopeId, tab }), []);
  const [saveVersions, setSaveVersions] = useState<Record<string, number>>({});
  const saveMember = useCallback(async (memberId: string, patch: Record<string, unknown>) => {
    const res = await patchGlobalMember(memberId, patch);
    setSaveVersions((prev) => ({ ...prev, [res.member.memberId]: (prev[res.member.memberId] ?? 0) + 1 }));
    return res.member;
  }, []);
  const ctx = useMemo<MemberFloatContextValue>(() => ({ open, saveMember, saveVersions }), [open, saveMember, saveVersions]);
  return (
    <MemberFloatCtx.Provider value={ctx}>
      {children}
      {target && <MemberDetailFloat key={`${target.memberId}:${target.scopeId ?? ""}`} memberId={target.memberId} scopeId={target.scopeId} initialTab={target.tab} liveStatuses={liveStatuses} onClose={() => setTarget(null)} onFired={() => { setTarget(null); onFired?.(); }} />}
    </MemberFloatCtx.Provider>
  );
}



// ── the float ───────────────────────────────────────────────────────────────

function MemberDetailFloat({ memberId, scopeId, initialTab, liveStatuses, onClose, onFired }: {
  memberId: string;
  scopeId?: string;
  initialTab?: FloatTab;
  liveStatuses?: ReadonlyMap<string, string>;
  onClose: () => void;
  onFired: () => void;
}) {
  const { toast } = useDialog();
  const { saveVersions } = useMemberFloat();
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [scopes, setScopes] = useState<MemberScopeInfo[]>([]);
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<FloatTab>(initialTab ?? "profile");
  const [dmDraft, setDmDraft] = useState("");
  const [dmSent, setDmSent] = useState(false);
  const [dmSending, setDmSending] = useState(false);

  useEffect(() => {
    getMemberScopes(memberId).then((r) => setScopes(r.scopes)).catch(() => {});
    getAvailableModels().then(setModels).catch(() => {});
  }, [memberId]);

  const profileRevision = useMemberProfileRevision(memberId);
  const saveVersion = saveVersions[memberId];
  useEffect(() => {
    let active = true;
    getMemberDetail(memberId)
      .then((detail) => { if (active) { setMember(detail); setLoadError(null); } })
      .catch((e) => { if (active) setLoadError(String(e?.message || e)); });
    // A read started before a save must not replace the saved record later.
    return () => { active = false; };
  }, [saveVersion, memberId, profileRevision]);

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

  const liveStatus = scope && member
    ? liveStatuses?.get(`${scope.scopeId}:${member.memberId}`) ?? liveStatuses?.get(`${scope.scopeId}:${member.name}`)
    : undefined;
  const effectiveStatus = liveStatus ?? scope?.status;
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
          <StaffBadge name={member?.name ?? "?"} status={effectiveStatus ? statusFromAgent(effectiveStatus) : "offline"} size="lg" />
          <div className="min-w-0 pb-0.5">
            {member ? (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[17px] font-bold text-ink-1 truncate">{member.name}</span>
                </div>
                {member.title && <div className="text-[11px] text-ink-3 mt-0.5 truncate">{member.title}</div>}
              </>
            ) : (
              <div className="text-[13px] text-ink-4">{loadError ? `Couldn't load — ${loadError}` : "Loading…"}</div>
            )}
          </div>
        </div>

        {/* tabs — Profile first (fish 2026-09-02: profile ) */}
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
            {tab === "assets" && <AssetsTab member={member} scope={scope} liveStatus={effectiveStatus} />}
            {tab === "activity" && scope && (
              <div className="h-[420px] rounded-xl border border-line-soft overflow-hidden">
                <ActivityTab
                  roomId={scope.kind === "dm" ? scope.scopeId : scope.scopeId.replace(/^room:/, "")}
                  agentName={member.name}
                  memberId={member.memberId}
                  dmScope={scope.kind === "dm" ? { scopeId: scope.scopeId, memberId: member.memberId } : undefined}
                />
              </div>
            )}
            {tab === "settings" && <SettingsTab member={member} setMember={setMember} scope={scope} models={models} liveStatus={effectiveStatus} onFired={onFired} />}
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
  const float = useMemberFloat();
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
      const saved = await float.saveMember(member.memberId, { title });
      setMember(saved);
      flashSaved(setCardSave);
    } catch (e) {
      setCardError(String((e as Error)?.message || e));
      setCardSave("error");
    }
  };

  return (
    <div className="space-y-4 pb-2">
      {/* identity — database-backed name and title; this panel currently edits title only */}
      <section>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-[11px] font-semibold text-ink-3">Name</span>
              <span className="inline-flex cursor-help" title="The name is stored in the member registry. Name editing is not available in this panel.">
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

      {/* persona — the persona.md body in a plain read-only box (fish
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

function AssetsTab({ member, scope, liveStatus }: {
  member: MemberDetail;
  scope: MemberScopeInfo | null;
  liveStatus?: string;
}) {
  const [assets, setAssets] = useState<MemberAssets | null>(null);
  const [assetsFailed, setAssetsFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAssets(null); setAssetsFailed(false);
    getMemberAssets(member.memberId)
      .then((a) => { if (!cancelled) setAssets(a); })
      .catch(() => { if (!cancelled) setAssetsFailed(true); });
    return () => { cancelled = true; };
  }, [member.memberId]);

  const home = `~/.bossmode/members/${member.memberId}`;

  return (
    <div className="space-y-4 pb-2">
      {/* fish 2026-09-03: Assets order = live first — Active tools, MCP
       * Servers, Pi extensions, Skills, Memory, System prompt.
       * Batch 6: member assets are the member's own files (presence =
       * enabled) — read-only listings here, the member edits them in chat. */}
      <p className="text-[11px] text-ink-4">The member manages these itself — ask in chat.</p>
      {scope && (
        <ActiveToolsSection
          roomId={scope.kind === "dm" ? scope.scopeId : scope.scopeId.replace(/^room:/, "")}
          memberRef={member.memberId || member.name}
          status={liveStatus ?? scope.status}
          reloadKey={0}
          dmScope={scope.kind === "dm" ? { scopeId: scope.scopeId, memberId: member.memberId } : undefined}
        />
      )}

      <WorkspacesSection member={member} assets={assets} assetsFailed={assetsFailed} />

      <AssetSection title="MCP Servers" count={assets ? String(assets.mcpServers.length) : undefined}>
        {assets === null && !assetsFailed && <div className={assetEmptyClass}>Loading…</div>}
        {assetsFailed && <div className={assetEmptyClass}>Couldn’t load this member’s MCP servers.</div>}
        {assets && assets.mcpServers.length === 0 ? (
          <div className="flex items-baseline gap-2 px-0.5 py-2 text-[12px] text-ink-4">
            None yet.
            <span className={`ml-auto ${assetFooterClass} pt-0`} title={`${home}/mcp.json`}>{home}/mcp.json</span>
          </div>
        ) : (
          <>
            <div>
              {assets?.mcpServers.map((srv) => (
                <div key={srv.name} className={assetRowClass}>
                  <span className="font-mono text-[12px] font-medium text-ink-1 truncate">{srv.name}</span>
                  {typeof srv.toolCount === "number" && <span className="ml-auto shrink-0 text-[10px] text-ink-4 tabular-nums">{srv.toolCount} tools</span>}
                </div>
              ))}
            </div>
            <div className={assetFooterClass} title={`${home}/mcp.json`}>{home}/mcp.json</div>
          </>
        )}
      </AssetSection>

      <AssetSection
        title="Pi extensions"
        info="Discovered on disk — what Pi can load, not a load-success list."
        count={assets ? String(assets.extensions.length) : undefined}
      >
        {assets === null && !assetsFailed && <div className={assetEmptyClass}>Loading…</div>}
        {assetsFailed && <div className={assetEmptyClass}>Couldn’t load this member’s extensions.</div>}
        {assets && assets.extensions.length === 0 ? (
          <div className="flex items-baseline gap-2 px-0.5 py-2 text-[12px] text-ink-4">
            None yet.
            <span className={`ml-auto ${assetFooterClass} pt-0`} title={`${home}/extensions/`}>{home}/extensions/</span>
          </div>
        ) : (
          <>
            <MemberExtensionRows extensions={assets?.extensions ?? []} />
            <div className={assetFooterClass} title={`${home}/extensions/`}>{home}/extensions/</div>
          </>
        )}
      </AssetSection>

      {assetsFailed ? (
        <AssetSection title="Skills">
          <div className={assetEmptyClass}>Couldn’t load this member’s skills.</div>
        </AssetSection>
      ) : (
        <MemberSkillsCard skills={assets?.skills ?? null} home={home} />
      )}

      {/* memory — shared platform directories, the same for every member:
       * static knowledge, not an asset — one quiet line, not two rows. */}
      <AssetSection
        title="Memory"
        info="Shared across all members — the same directories everyone reads."
        count="2"
      >
        <div className="flex items-center gap-2.5 px-0.5 py-2">
          <span className="font-mono text-[11.5px] text-ink-3 truncate">~/.bossmode/memory/</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-ink-4">user/ · projects/</span>
        </div>
      </AssetSection>

      <SystemPromptSection member={member} scope={scope} liveStatus={liveStatus} />
    </div>
  );
}

/** The member's Pi extensions inventory (ext-inventory-ui, backend contract
 * 2026-09-08): one row per discovered package/script — name + source + path.
 * Symlinks show the resolved target; multi-entry packages expand to list entry
 * files; broken items say so in red (issues come from the backend verbatim).
 * Discovery ≠ load success; the section info tooltip says that. Rows are keyed
 * by source+path — names need not be unique. */
function shortenAssetPath(p: string): string {
  const i = p.indexOf("/.bossmode/");
  return i > 0 ? `~${p.slice(i)}` : p;
}

/** For diagnostic text that EMBEDS a path (backend issues): shorten only the
 * path token, keep the message wording verbatim — never eat the sentence. */
function shortenIssueText(text: string): string {
  return text.replace(/(^|\s)\S*?(\/\.bossmode\/)/g, "$1~$2");
}

function MemberExtensionRows({ extensions }: { extensions: MemberExtensionAsset[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copyState, setCopyState] = useState<{ key: string; ok: boolean } | null>(null);

  const copyPath = async (key: string, full: string) => {
    const ok = await copyText(full);
    setCopyState({ key, ok });
    window.setTimeout(() => setCopyState(null), 1400);
  };

  return (
    <div>
      {extensions.map((ext) => {
        const key = `${ext.source}:${ext.path}`;
        const displayPath = shortenAssetPath(ext.path);
        const displayReal = ext.realPath ? shortenAssetPath(ext.realPath) : null;
        const multi = ext.entryPoints.length > 1;
        const expanded = !!open[key];
        const copied = copyState?.key === key && copyState.ok;
        const failed = copyState?.key === key && !copyState.ok;
        return (
          <div key={key} className="border-b border-line-soft last:border-b-0">
            <div className="group flex items-center gap-2.5 px-0.5 py-2">
              <span className="font-mono text-[12px] font-medium text-ink-1 truncate shrink-0 max-w-[34%]">{ext.name}</span>
              <span className={`text-[10px] uppercase tracking-wide shrink-0 ${ext.source === "builtin" ? "text-accent-ink" : "text-ink-4"}`}>
                {ext.source === "builtin" ? "built-in" : "member"}
              </span>
              {multi && (
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [key]: !expanded }))}
                  aria-expanded={expanded}
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-ink-3 hover:bg-surface-2 hover:text-ink-1 cursor-pointer shrink-0"
                >
                  <ChevronRight size={10} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
                  {ext.entryPoints.length} entries
                </button>
              )}
              <span
                className="ml-auto min-w-0 max-w-[46%] truncate font-mono text-[10.5px] text-ink-4 text-right"
                title={ext.realPath ? `${ext.path} → ${ext.realPath}` : ext.path}
              >
                {displayPath}{displayReal && <span className="opacity-75"> → {displayReal}</span>}
              </span>
              <button
                type="button"
                onClick={() => void copyPath(key, ext.path)}
                title={failed ? "Copy failed — clipboard unavailable" : "Copy the full path"}
                className={`shrink-0 ${assetActionClass} transition-opacity ${copied || failed ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              >
                {copied ? <Check size={11} className="text-onair" /> : failed ? <X size={11} className="text-blocked" /> : <Copy size={11} />}
                {copied ? "Copied" : failed ? "Failed" : "Copy"}
              </button>
            </div>
            {multi && expanded && (
              <div className="pb-1.5">
                {ext.entryPoints.map((ep) => (
                  <div key={ep} className="flex items-center gap-2 pl-[18px] pr-0.5 py-0.5 font-mono text-[10.5px] text-ink-3">
                    <span className="truncate">{ep.startsWith(ext.path + "/") ? ep.slice(ext.path.length + 1) : shortenAssetPath(ep)}</span>
                    <span className="text-[9.5px] text-ink-4 shrink-0">entry</span>
                  </div>
                ))}
              </div>
            )}
            {ext.issues.map((issue, i) => (
              <div key={i} className="flex items-center gap-1.5 pl-[18px] pr-0.5 pb-2 text-[11px] text-blocked">
                <AlertTriangle size={11} className="shrink-0" />
                <span>{shortenIssueText(issue)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** The member's workspaces (batch 7): where it can work — original (its own
 * home) plus ssh remotes. Active row carries the green dot; the member's ssh
 * public key sits at the bottom with a copy button (fish pastes it into a
 * remote machine's authorized_keys to authorize this member). */
function WorkspacesSection({ member, assets, assetsFailed }: {
  member: MemberDetail;
  assets: MemberAssets | null;
  assetsFailed: boolean;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const copyKey = async () => {
    if (!assets?.sshPublicKey) return;
    const ok = await copyText(assets.sshPublicKey);
    setCopied(ok);
    window.setTimeout(() => setCopied(null), 1400);
  };

  return (
    <AssetSection title="Workspaces" count={assets ? String(assets.workspaces.length) : undefined}>
      {assets === null && !assetsFailed && <div className={assetEmptyClass}>Loading…</div>}
      {assetsFailed && <div className={assetEmptyClass}>Couldn’t load this member’s workspaces.</div>}
      <div>
        {assets?.workspaces.map((ws) => (
          <div key={ws.id} className={assetRowClass}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ws.active ? "bg-onair" : "bg-ink-4/40"}`} />
            <span className="font-mono text-[12px] font-medium text-ink-1 truncate">{ws.id}</span>
            <span className="text-[10px] text-ink-4 uppercase tracking-wide shrink-0">{ws.kind}</span>
            {ws.kind === "ssh" && ws.host && <span className="text-[10.5px] text-ink-4 truncate">{ws.user ? `${ws.user}@` : ""}{ws.host}</span>}
            <span className="ml-auto shrink-0 max-w-[45%] truncate font-mono text-[10.5px] text-ink-4" title={ws.root}>{ws.root}</span>
          </div>
        ))}
        {assets?.sshPublicKey && (
          <div className={assetRowClass}>
            <span className="text-[11px] text-ink-3 shrink-0">SSH public key</span>
            <span className="font-mono text-[10.5px] text-ink-4 truncate min-w-0" title={assets.sshPublicKey}>{assets.sshPublicKey}</span>
            <button
              type="button"
              onClick={() => void copyKey()}
              title={copied === false ? "Copy failed — clipboard unavailable" : "Copy the public key"}
              className={`ml-auto shrink-0 ${assetActionClass}`}
            >
              {copied === true ? <Check size={11} className="text-onair" /> : copied === false ? <X size={11} className="text-blocked" /> : <Copy size={11} />}
              {copied === true ? "Copied" : copied === false ? "Failed" : "Copy"}
            </button>
          </div>
        )}
      </div>
    </AssetSection>
  );
}

/** Reads the current SDK session prompt. Polling while the panel is open
 * prevents instance creation or destruction from leaving stale text visible;
 * status transitions also trigger an immediate refresh. */
export function SystemPromptSection({ member, scope, liveStatus }: {
  member: MemberDetail;
  scope: MemberScopeInfo | null;
  liveStatus?: string;
}) {
  const [doc, setDoc] = useState<MemberSystemPromptDoc | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const effectiveScope = scope?.scopeId ?? `dm:${member.memberId}`;

  useEffect(() => {
    setDoc(null);
    setFailed(false);
  }, [member.memberId, effectiveScope]);

  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = await getMemberSystemPrompt(member.memberId, effectiveScope);
        if (!cancelled) {
          setDoc(next);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        loading = false;
      }
    };
    if (liveStatus === "inactive") {
      setDoc({ available: false, reason: "instance_not_running", scopeId: effectiveScope });
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [member.memberId, effectiveScope, liveStatus]);

  const available = !failed && doc?.available === true ? doc : null;
  const copy = async () => {
    if (!available) return;
    const ok = await copyText(available.text);
    setCopied(ok);
    window.setTimeout(() => setCopied(null), 1400);
  };

  return (
    <AssetSection
      title="System prompt"
      info="The current system prompt reported by this member’s running SDK session."
      count={available ? `${available.charCount.toLocaleString()} chars` : undefined}
      action={available ? (
        <button
          type="button"
          onClick={() => void copy()}
          title={copied === false ? "Copy failed — clipboard unavailable" : "Copy the full prompt"}
          className={assetActionClass}
        >
          {copied === true ? <Check size={11} className="text-onair" /> : copied === false ? <X size={11} className="text-blocked" /> : <Copy size={11} />}
          {copied === true ? "Copied" : copied === false ? "Failed" : "Copy"}
        </button>
      ) : undefined}
    >
      {failed ? (
        <div className={assetEmptyClass}>Couldn’t load the system prompt for this scope.</div>
      ) : doc === null ? (
        <div className={assetEmptyClass}>Loading…</div>
      ) : !doc.available ? (
        <div className={assetEmptyClass}>Run this member to view its system prompt.</div>
      ) : (
        <div className="rounded-lg border border-line-soft bg-inset/50 px-3 py-2 max-h-[340px] overflow-y-auto">
          <div className="whitespace-pre-wrap font-mono text-[11.5px] text-ink-3 leading-relaxed">{doc.text}</div>
        </div>
      )}
      {available && (
        <div className={assetFooterClass} title={`scope ${available.scopeId ?? "global"} · contract ${available.contractFingerprint}`}>
          {available.scopeId ?? "global"} · {available.contractFingerprint.slice(0, 8)}
        </div>
      )}
    </AssetSection>
  );
}

/** Row visuals for both selects — row building for models lives in
 * member-scope.buildModelRows (shared with the roster chip pop). */
function RowSelect({ value, rows, onChange, emptyLabel, emptyHint }: {
  value: string | null;
  rows: RowOption[];
  onChange: (id: string | null) => void;
  emptyLabel?: string;
  emptyHint?: string;
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

  const current = rows.find((r) => r.id === value);

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
            <span className={`text-[13px] font-semibold truncate ${current.unavailable ? "text-think" : "text-ink-1"}`}>{current.label}</span>
            {current.quiet && <span className={`text-[11px] truncate ${current.unavailable ? "text-think" : "text-ink-4"}`}>{current.quiet}</span>}
          </>
        ) : (
          <span className="text-[13px] text-ink-4">{emptyLabel ?? "Not configured"}</span>
        )}
        <ChevronDown size={12} className={`ml-auto shrink-0 text-ink-4 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-64 overflow-y-auto rounded-lg border border-line-strong bg-surface-3 p-1" style={{ boxShadow: "var(--shadow-pop)" }}>
          {emptyLabel !== undefined && (
            <button
              type="button"
              onClick={() => { setOpen(false); onChange(null); }}
              className="w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left cursor-pointer hover:bg-surface-2 transition-colors"
            >
              <span className="text-[12.5px] text-ink-4">{emptyLabel}</span>
              {value === null && <Check size={12} className="ml-auto shrink-0 text-accent-ink" />}
            </button>
          )}
          {rows.length === 0 && emptyHint && (
            <div className="px-2.5 py-2 text-[11px] text-think">{emptyHint}</div>
          )}
          {rows.map((r) => {
            const selected = r.id === value;
            const cls = r.unavailable ? "opacity-70" : "cursor-pointer hover:bg-surface-2 transition-colors";
            const inner = (
              <>
                <span className={`text-[12.5px] font-medium truncate ${r.unavailable ? "text-think" : "text-ink-1"}`}>{r.label}</span>
                {r.quiet && <span className={`text-[10.5px] truncate ${r.unavailable ? "text-think" : "text-ink-4"}`}>{r.quiet}</span>}
                {selected && <Check size={12} className={`ml-auto shrink-0 ${r.unavailable ? "text-think" : "text-accent-ink"}`} />}
              </>
            );
            return r.unavailable ? (
              <div key={r.id} title={r.title} className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 ${cls}`}>{inner}</div>
            ) : (
              <button key={r.id} type="button" title={r.title} onClick={() => { setOpen(false); onChange(r.id); }} className={`w-full flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left ${cls}`}>{inner}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelRowSelect({ value, models, onChange }: {
  value: { model: string | null; credentialId: string | null };
  models: AvailableModelOption[];
  onChange: (v: { model: string | null; credentialId: string | null }) => void;
}) {
  const { rows, byId, currentId } = buildModelRows(models, value);

  return (
    <RowSelect
      value={currentId}
      rows={rows}
      emptyLabel="Not configured"
      emptyHint="No models available. Connect a provider in Settings → Models."
      onChange={(id) => {
        if (id === null) { onChange({ model: null, credentialId: null }); return; }
        if (id === "__current") return;
        const m = byId.get(id);
        if (m) onChange({ model: m.ref, credentialId: m.profileId });
      }}
    />
  );
}

function ThinkRowSelect({ value, options, onChange }: {
  value: string;
  options: string[];
  onChange: (level: string | null) => void;
}) {
  return (
    <RowSelect
      value={value}
      rows={options.map((l) => ({ id: l, label: l }))}
      onChange={(id) => onChange(id === null || id === "off" ? null : id)}
    />
  );
}

// ── Settings tab: the member's global model + this scope's session + fire ───
// Batch 5b: config is globally unified — no per-scope model card, no unified
// toggles, no "following global" banner. The model select IS the global one.

function SettingsTab({ member, setMember, scope, models, liveStatus, onFired }: {
  member: MemberDetail;
  setMember: (m: MemberDetail) => void;
  scope: MemberScopeInfo | null;
  models: AvailableModelOption[];
  liveStatus?: string;
  onFired: () => void;
}) {
  const { toast, confirm } = useDialog();
  const float = useMemberFloat();
  const [cfgSave, setCfgSave] = useState<SaveState>("idle");
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [fireDraft, setFireDraft] = useState("");
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dm = scope?.kind === "dm";
  const roomId = scope && !dm ? scope.scopeId.replace(/^room:/, "") : null;
  const [contextUsage, setContextUsage] = useState<ContextUsageData | undefined>();

  // context usage refetches when the live status changes (fish 2026-09-03:
  // the float used to show a snapshot — after a daemon restart or a fresh
  // turn, the usage number stayed stale until reopen)
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    getConversationSession(scope.scopeId, member.memberId).then((s) => { if (!cancelled) setContextUsage(s.contextUsage ?? undefined); }).catch(() => {});
    return () => { cancelled = true; if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [dm, roomId, member.memberId, scope, liveStatus]);

  const handleCompact = useCallback(async () => {
    try {
      const result = await memberAction(member.memberId, "compact");
      if (result.action === "stopped") {
        toast("Compaction stopped", "info");
      } else if (result.ok) {
        toast(`Compacted ${member.name}`, "success");
      } else {
        throw new Error(result.message || "Couldn’t compact this conversation.");
      }
    } catch (err) { console.error(err); toast(String((err as Error)?.message || "Couldn’t compact this conversation."), "error"); }
  }, [member, toast]);
  const handleResetSession = useCallback(async () => {
    if (!scope) return;
    const ok = await confirm(`Reset session for @${member.name}?\n\nThis clears the member's working session memory and starts fresh. Messages and activity history stay visible.`);
    if (!ok) return;
    try {
      await memberAction(member.memberId, "reset");
      toast(`${member.name} session reset`, "success");
    } catch (err) { console.error(err); toast("Couldn’t reset this session. Try again.", "error"); }
  }, [member, confirm, toast]);
  const handleRestart = useCallback(async () => {
    try {
      await memberAction(member.memberId, "restart");
      toast(`${member.name} restarted`, "success");
    } catch (err) { console.error(err); toast("Couldn’t restart this member. Try again.", "error"); }
  }, [member, toast]);

  const flashCfg = () => {
    setCfgSave("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setCfgSave("idle"), 1800);
  };
  const saveConfig = async (patch: Record<string, unknown>) => {
    setCfgSave("saving"); setCfgError(null);
    try {
      const saved = await float.saveMember(member.memberId, patch);
      setMember(saved);
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
            <ThinkRowSelect
              value={thinkingCurrent}
              options={thinkingAll}
              onChange={(level) => void saveConfig({ thinkingLevel: level })}
            />
          </label>
        </div>
        {(cfgSave !== "idle" || cfgError) && (
          <div className="flex items-center gap-2 mt-2">
            {cfgSave === "saving" && <span className="text-[11px] text-ink-4 inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" />Saving…</span>}
            {cfgSave === "saved" && <span className="text-[11px] text-onair inline-flex items-center gap-1"><Check size={11} />Saved</span>}
            {cfgError && <span role="alert" className="text-[11px] text-blocked">{cfgError}</span>}
          </div>
        )}
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
