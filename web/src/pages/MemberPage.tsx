/**
 * MemberPage — the member's ONE home (member-page merge v1, fish 2026-08-26:
 * "这两个页面我考虑应该合并为一个" — the global settings page and the room
 * Sheet become a single page; prototype member-page-merge-v1 approved 08-26).
 *
 * Scope is a dimension INSIDE the page: the switcher offers Global defaults
 * plus every scope the member has a conversation in.
 *   Global defaults — identity (rename/title/description), unified model &
 *     extensions, Profile & skills (member.md + skills live here — they are
 *     global content), scopes index, danger zone.
 *   A scope (room / DM) — Status grid, Model card (locks behind a
 *     "Following global defaults" banner while Unified model is on — the
 *     unified⇄scope link that used to span two pages), Session & tools,
 *     Activity.
 *
 * APIs: members-shaped globals + scope routes; room scopes reuse the room
 * member APIs (updateRoomMember/steerAgent/restartMember/resetAgentSession).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Loader2 } from "lucide-react";
import { BackLink } from "../components/BackLink";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { ActivityTab } from "../components/ActivityTab";
import { useDialog } from "../components/dialogs";
import {
  AssetTag, StatusGrid, MemberMdCard, MemberSkillsCard, CoreCard,
  ScopeModelCard, ContextSessionCard, ExtensionsAccordion, McpToolsAccordion,
  ActiveToolsSection, isAssignableMcpServer,
} from "../components/member-scope";
import {
  getMemberDetail, getMemberScopes, getAvailableModels, getContacts,
  patchGlobalMember, deleteGlobalMember,
  getMemberProfile, getMemberSkills,
  getRoomMembers, updateRoomMember, steerAgent, restartMember, resetAgentSession,
  getMemberStats, getMemberCorePrompt,
  getMemberEffectiveConfig, patchMemberScopeConfig, getMemberScopedStats, getMemberCorePromptScoped,
  getConversationSession, conversationMemberAction,
  getMcpSettings, getExtensions,
  type MemberDetail, type MemberScopeInfo, type AvailableModelOption,
  type MemberInfo, type MemberProfileDoc, type MemberSkillEntry, type MemberStats,
  type ContextUsageData, type McpServerSummary, type ExtensionRecord,
} from "../api/client";

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/i;
const GLOBAL = "global";
type ScopeKey = typeof GLOBAL | string;

type SaveState = "idle" | "saving" | "saved" | "error";

export function MemberPage({ memberId, initialScopeId, onBack, onFired, onOpenMcpSettings, onOpenExtensionsSettings }: {
  memberId: string;
  /** Preset scope (`room:<id>` / `dm:<memberId>`); absent = Global defaults. */
  initialScopeId?: string;
  onBack: () => void;
  onFired: () => void;
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
}) {
  const { toast, confirm } = useDialog();
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [scopes, setScopes] = useState<MemberScopeInfo[]>([]);
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [existingNames, setExistingNames] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scopeKey, setScopeKey] = useState<ScopeKey>(initialScopeId ?? GLOBAL);

  useEffect(() => {
    getMemberDetail(memberId)
      .then((m) => setMember(m))
      .catch((e) => setLoadError(String(e?.message || e)));
    getAvailableModels().then(setModels).catch(() => {});
    getContacts().then((r) => setExistingNames(new Set(r.contacts.map((c) => c.name.toLowerCase())))).catch(() => {});
  }, [memberId]);

  // Scope list: load + light poll so status cells/dots stay honest (no WS on
  // this page — a 5s beat is fresh enough for a config surface).
  useEffect(() => {
    let alive = true;
    const load = () => getMemberScopes(memberId).then((r) => { if (alive) setScopes(r.scopes); }).catch(() => {});
    void load();
    const t = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [memberId]);

  const activeScope = scopeKey === GLOBAL ? null : scopes.find((s) => s.scopeId === scopeKey) ?? (
    // Preset scope not in the list yet (fresh member / list still loading) —
    // derive kind from the id shape so the view can still render.
    scopeKey.startsWith("dm:") ? { scopeId: scopeKey, kind: "dm" as const, label: "Direct message", status: "inactive", lastActiveAt: null }
      : { scopeId: scopeKey, kind: "room" as const, label: "This room", status: "inactive", lastActiveAt: null }
  );

  if (loadError) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-1">
        <div className="w-full px-6 md:px-10 pt-7 pb-16">
          <BackLink label="Back" onClick={onBack} />
          <div role="alert" className="text-[12px] text-blocked">Couldn’t load the member. {loadError}</div>
        </div>
      </div>
    );
  }
  if (!member) return <div className="flex-1 grid place-items-center bg-surface-1 text-xs text-ink-4">Loading…</div>;

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full max-w-[860px] px-6 md:px-10 pt-7 pb-16">
        <BackLink label="Back to conversation" onClick={onBack} />

        {/* header */}
        <div className="flex items-center gap-3.5 mb-5">
          <StaffBadge name={member.name} status={activeScope ? statusFromAgent(activeScope.status) : undefined} size="lg" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-[19px] font-bold tracking-tight text-ink-1 truncate">{member.name}</h1>
              {activeScope && (
                <span className={`text-[10px] border rounded-full px-2 py-0.5 uppercase shrink-0 ${activeScope.status === "working" ? "text-onair border-onair/30 bg-onair/10" : "text-ink-4 border-line bg-surface-2"}`}>
                  {activeScope.status}
                </span>
              )}
            </div>
            <div className="text-[11px] text-ink-4 mt-0.5 truncate">
              {member.title ? `${member.title} · ` : ""}<span className="font-mono">@{member.name}</span>
              {member.createdAt ? ` · member since ${new Date(member.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : ""}
            </div>
          </div>
        </div>

        {/* scope switcher — scope is a dimension of the page, not a surface */}
        <ScopeSwitcher
          scopes={scopes}
          value={scopeKey}
          onChange={setScopeKey}
        />

        {scopeKey === GLOBAL ? (
          <GlobalView
            member={member}
            setMember={setMember}
            scopes={scopes}
            models={models}
            existingNames={existingNames}
            setExistingNames={setExistingNames}
            onOpenScope={setScopeKey}
            onFired={onFired}
          />
        ) : activeScope ? (
          <ScopeView
            key={activeScope.scopeId}
            member={member}
            scope={activeScope}
            models={models}
            onGoGlobal={() => setScopeKey(GLOBAL)}
            onOpenMcpSettings={onOpenMcpSettings}
            onOpenExtensionsSettings={onOpenExtensionsSettings}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── scope switcher ──────────────────────────────────────────────────────────

function ScopeSwitcher({ scopes, value, onChange }: {
  scopes: MemberScopeInfo[];
  value: ScopeKey;
  onChange: (key: ScopeKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const current = value === GLOBAL
    ? { label: "Global defaults", kind: "global", status: "" }
    : { label: scopes.find((s) => s.scopeId === value)?.label ?? "…", kind: scopes.find((s) => s.scopeId === value)?.kind ?? "", status: scopes.find((s) => s.scopeId === value)?.status ?? "" };

  const dot = (status: string, global?: boolean) =>
    global ? "bg-accent" : status === "working" ? "bg-onair" : status === "error" ? "bg-blocked" : "bg-ink-4";

  return (
    <div ref={ref} className="relative mb-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 rounded-xl border border-line bg-surface-1 px-3.5 py-2.5 text-left cursor-pointer hover:border-line-strong transition-colors"
      >
        <span className="text-[9.5px] font-extrabold tracking-[0.08em] uppercase text-ink-4">Scope</span>
        <span className="text-[13.5px] font-semibold text-ink-1 truncate">{current.label}</span>
        <span className="text-[9px] font-bold uppercase tracking-wide rounded-full px-1.5 py-0.5 bg-accent-dim text-accent-ink shrink-0">{current.kind}</span>
        <ChevronDown size={13} className={`ml-auto text-ink-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute top-[calc(100%+6px)] left-0 right-0 z-30 rounded-xl border border-line-strong bg-surface-2 shadow-pop overflow-hidden">
          <button
            type="button"
            onClick={() => { onChange(GLOBAL); setOpen(false); }}
            className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left cursor-pointer hover:bg-surface-3 ${value === GLOBAL ? "bg-accent-dim" : ""}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot("", true)}`} />
            <span className="text-[13px] font-semibold text-ink-1">Global defaults</span>
            <span className="ml-auto text-[10.5px] text-ink-4">identity · persona · unified config</span>
          </button>
          {scopes.map((s) => (
            <button
              key={s.scopeId}
              type="button"
              onClick={() => { onChange(s.scopeId); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left cursor-pointer hover:bg-surface-3 ${value === s.scopeId ? "bg-accent-dim" : ""}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot(s.status)}`} />
              <span className="text-[13px] text-ink-1 truncate">{s.label}</span>
              <span className="text-[9px] font-bold uppercase tracking-wide text-ink-4 shrink-0">{s.kind}</span>
              <span className="ml-auto text-[10.5px] text-ink-4 shrink-0">{s.status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Global defaults view (the old settings page sections + Profile & skills) ─

function GlobalView({ member, setMember, scopes, models, existingNames, setExistingNames, onOpenScope, onFired }: {
  member: MemberDetail;
  setMember: (m: MemberDetail) => void;
  scopes: MemberScopeInfo[];
  models: AvailableModelOption[];
  existingNames: Set<string>;
  setExistingNames: (fn: (prev: Set<string>) => Set<string>) => void;
  onOpenScope: (scopeId: string) => void;
  onFired: () => void;
}) {
  const [nameDraft, setNameDraft] = useState(member.name);
  const [nameSave, setNameSave] = useState<SaveState>("idle");
  const [nameError, setNameError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState(member.title ?? "");
  const [descDraft, setDescDraft] = useState(member.description ?? "");
  const [cardSave, setCardSave] = useState<SaveState>("idle");
  const [cardError, setCardError] = useState<string | null>(null);
  const [cfgSave, setCfgSave] = useState<SaveState>("idle");
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [fireDraft, setFireDraft] = useState("");
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);
  const [profile, setProfile] = useState<MemberProfileDoc | null>(null);
  const [memberSkills, setMemberSkills] = useState<MemberSkillEntry[] | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMemberProfile(member.memberId)
      .then((doc) => { if (!cancelled) setProfile(doc); })
      .catch(() => { if (!cancelled) setProfile({ path: "", frontmatter: { name: member.name }, body: "", charCount: 0, overBudget: false } as MemberProfileDoc); });
    getMemberSkills(member.memberId)
      .then((r) => { if (!cancelled) setMemberSkills(r.skills); })
      .catch(() => { if (!cancelled) setMemberSkills([]); });
    return () => { cancelled = true; if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [member.memberId, member.name]);

  const groupedModels = useMemo(() => {
    const groups = new Map<string, AvailableModelOption[]>();
    for (const m of models) {
      const key = m.profileName || m.providerSlug;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return [...groups.entries()];
  }, [models]);

  const flashSaved = (set: (s: SaveState) => void) => {
    set("saved");
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => set("idle"), 1800);
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

  const saveName = async () => {
    const next = nameDraft.trim();
    if (!NAME_RE.test(next)) { setNameError("Letters, digits, - and _ only, up to 32 chars."); return; }
    if (next.toLowerCase() !== member.name.toLowerCase() && existingNames.has(next.toLowerCase())) {
      setNameError("That name is taken.");
      return;
    }
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

  const saveConfig = async (patch: Record<string, unknown>) => {
    setCfgSave("saving"); setCfgError(null);
    try {
      const res = await patchGlobalMember(member.memberId, patch);
      setMember(res.member);
      flashSaved(setCfgSave);
    } catch (e) {
      setCfgError(String((e as Error)?.message || e));
      setCfgSave("error");
    }
  };

  const fire = async () => {
    if (firing) return;
    setFiring(true); setFireError(null);
    try {
      await deleteGlobalMember(member.memberId);
      onFired();
    } catch (e) {
      setFireError(String((e as Error)?.message || e));
      setFiring(false);
    }
  };

  const nameChanged = nameDraft.trim() !== member.name;

  return (
    <>
      {/* 1 · identity */}
      <section className="mb-7">
        <SectionTitle title="Identity" hint="Card fields stored in member.md frontmatter. The persona itself grows from your conversations — the member maintains it, not this form." />
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-x-3 gap-y-3 items-end">
          <div>
            <label className="block text-[11px] font-semibold text-ink-3 mb-1.5">Name</label>
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
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-ink-3 mb-1.5">Title</label>
            <input
              value={titleDraft}
              onChange={(e) => { setTitleDraft(e.target.value); setCardError(null); }}
              placeholder="e.g. Architect — the role on the card"
              className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4"
            />
          </div>
        </div>
        {nameError && <div role="alert" className="text-[11px] text-blocked mt-1.5">{nameError}</div>}
        <p className="text-[11px] text-ink-4 mt-1.5">Rename propagates everywhere on next activation — scopes, rooms, and memory stay linked by ID.</p>

        <label className="block text-[11px] font-semibold text-ink-3 mt-3.5 mb-1.5">Description</label>
        <textarea
          rows={2}
          value={descDraft}
          onChange={(e) => { setDescDraft(e.target.value); setCardError(null); }}
          placeholder="What this member is for and how it works."
          className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4 resize-none"
        />
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

      {/* 2 · model & extensions */}
      <section className="mb-7">
        <SectionTitle title="Model & extensions" hint="Unified switches decide whether all scopes share one global config or keep per-scope overrides." />
        <div className="rounded-xl border border-line divide-y divide-line-soft">
          <div className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-semibold text-ink-1">Unified model</div>
                <div className="text-[11px] text-ink-4 mt-0.5">
                  {member.unifiedModel ? "Every scope uses the global model below." : "Model is configured per scope — switch to a scope above."}
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

      {/* 3 · profile & skills — global content lives at the global level */}
      <section className="mb-7">
        <SectionTitle title="Profile & skills" hint="member.md — one per member, global. The member grows it from your feedback; skills are its own reusable work instructions." />
        <div className="space-y-3">
          <MemberMdCard profile={profile} memberName={member.name} />
          <MemberSkillsCard skills={memberSkills} />
        </div>
      </section>

      {/* 4 · scopes — each row jumps into that scope's view */}
      <section className="mb-7">
        <SectionTitle title="Scopes" hint="Where this member has a conversation. Open one to see its live state and per-scope config." />
        {scopes.length === 0 ? (
          <div className="text-[12px] text-ink-4 py-2">No scopes yet.</div>
        ) : (
          <div className="rounded-xl border border-line divide-y divide-line-soft">
            {scopes.map((s) => (
              <button
                key={s.scopeId}
                type="button"
                onClick={() => onOpenScope(s.scopeId)}
                className="w-full px-4 py-3 flex items-center gap-3 text-left cursor-pointer hover:bg-surface-2 transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.status === "working" ? "bg-onair" : s.status === "error" ? "bg-blocked" : "bg-ink-4"}`} />
                <span className="text-[13px] text-ink-1 flex-1 min-w-0 truncate">{s.label}</span>
                <span className="text-[10px] font-semibold tracking-wide uppercase text-ink-4">{s.kind}</span>
                <span className="text-[11px] text-ink-4 w-16 text-right">{s.status}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 5 · danger zone */}
      <section>
        <SectionTitle title="Danger zone" hint="" />
        <div className="rounded-xl border border-blocked/40 bg-blocked/5 px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="text-blocked shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink-1">Fire {member.name}</div>
              <p className="text-[11.5px] text-ink-3 mt-1 leading-snug">
                The member leaves every room and their chat windows close. Persona and scope notes are archived under
                <code className="text-[10.5px] mx-1">backups/fired-{member.name}-…</code>
                and can be re-imported from the New member page.
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
    </>
  );
}

// ── scope view (Status / Model / Session & tools / Activity) ────────────────

function ScopeView({ member, scope, models, onGoGlobal, onOpenMcpSettings, onOpenExtensionsSettings }: {
  member: MemberDetail;
  scope: MemberScopeInfo;
  models: AvailableModelOption[];
  onGoGlobal: () => void;
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
}) {
  const { toast, confirm } = useDialog();
  const dm = scope.kind === "dm";
  const roomId = dm ? null : scope.scopeId.replace(/^room:/, "");
  const dmScope = dm ? { scopeId: scope.scopeId, memberId: member.memberId } : undefined;

  const [memberInfo, setMemberInfo] = useState<MemberInfo | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageData | undefined>();
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [corePrompt, setCorePrompt] = useState<{ content: string; charCount: number } | null>(null);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [mcpLoadStatus, setMcpLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [installedExtensions, setInstalledExtensions] = useState<ExtensionRecord[]>([]);
  const [extensionsLoadStatus, setExtensionsLoadStatus] = useState<"loading" | "ready" | "error">("loading");

  // memberInfo = member identity + effective config in THIS scope (same shape
  // the old panel consumed; dm path mirrors DmPage's refreshMemberInfo).
  const loadMemberInfo = useCallback(async () => {
    if (dm) {
      const eff = await getMemberEffectiveConfig(member.memberId, scope.scopeId).catch(() => null);
      setMemberInfo({
        id: member.memberId,
        name: member.name,
        agent: member.agentTemplate,
        title: member.title ?? null,
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
  }, [dm, roomId, member, scope.scopeId]);

  useEffect(() => { void loadMemberInfo(); }, [loadMemberInfo]);

  useEffect(() => {
    let cancelled = false;
    const empty = { turns: 0, toolCalls: 0, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
    (dm
      ? getMemberScopedStats(member.memberId, scope.scopeId)
      : getMemberStats(member.memberId, roomId!)
    ).then((r) => { if (!cancelled) setStats(r); }).catch(() => { if (!cancelled) setStats(empty); });
    (dm
      ? getMemberCorePromptScoped(member.memberId, scope.scopeId)
      : getMemberCorePrompt(roomId!, member.memberId)
    ).then((r) => { if (!cancelled) setCorePrompt(r); }).catch(() => { if (!cancelled) setCorePrompt({ content: "", charCount: 0 }); });
    getConversationSession(scope.scopeId, member.memberId)
      .then((s) => { if (!cancelled) setContextUsage(s.contextUsage); })
      .catch(() => {});
    setMcpLoadStatus("loading");
    getMcpSettings()
      .then((s) => { if (cancelled) return; setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); })
      .catch(() => { if (!cancelled) setMcpLoadStatus("error"); });
    setExtensionsLoadStatus("loading");
    getExtensions()
      .then((e) => { if (cancelled) return; setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); })
      .catch(() => { if (!cancelled) setExtensionsLoadStatus("error"); });
    return () => { cancelled = true; };
  }, [dm, roomId, member.memberId, scope.scopeId]);

  // ── handlers — room flavor via room APIs, dm flavor via scope APIs (both
  // verbatim ports of the old StationPanel / DmPage handler sets) ──
  const applyPatch = useCallback(
    async (patch: Record<string, unknown>, successMsg: string, errorMsg: string) => {
      try {
        if (dm) {
          await patchMemberScopeConfig(member.memberId, scope.scopeId, patch);
          await loadMemberInfo();
        } else {
          const updated = await updateRoomMember(roomId!, member.memberId, patch);
          setMemberInfo(updated);
        }
        toast(successMsg, "success");
      } catch (err) {
        console.error("Failed to update member config", err);
        const detail = err instanceof Error && err.message ? ` ${err.message}` : "";
        toast(`${errorMsg}${detail}`, "error");
      }
    },
    [dm, roomId, member, scope.scopeId, loadMemberInfo, toast],
  );

  const handleSwitchModel = useCallback(
    (model: string | null, credentialId: string | null) =>
      applyPatch({ model, credentialId }, `${member.name} model updated. It applies on the next turn.`, "Couldn’t update the model."),
    [applyPatch, member.name],
  );
  const handleSwitchThinking = useCallback(
    (thinkingLevel: string | null) =>
      applyPatch({ thinkingLevel }, `${member.name} thinking → ${thinkingLevel ?? "default"}`, "Couldn’t update the thinking level."),
    [applyPatch, member.name],
  );
  const handleToggleMcp = useCallback(
    async (server: string) => {
      if (!memberInfo) return;
      const current = new Set(memberInfo.mcpServers || []);
      if (current.has(server)) current.delete(server); else current.add(server);
      const assignableNames = new Set(mcpServers.filter(isAssignableMcpServer).map((s) => s.name));
      const nextServers = mcpServers.map((s) => s.name).filter((name) => current.has(name) && assignableNames.has(name));
      await applyPatch({ mcpServers: nextServers }, `${memberInfo.name} tool access saved. Restart the member to apply it.`, "Couldn’t save tool access.");
    },
    [memberInfo, mcpServers, applyPatch],
  );
  const handleToggleExtension = useCallback(
    async (extId: string) => {
      if (!memberInfo) return;
      const current = new Set(memberInfo.extensions || []);
      const hit = [...current].find((c) => c === extId || c === `npm:${extId}` || extId.endsWith(c) || c.endsWith(extId));
      if (hit) current.delete(hit);
      else current.add(extId);
      await applyPatch({ extensions: Array.from(current) }, "Saved.", "Couldn’t save extension access.");
    },
    [memberInfo, applyPatch],
  );
  const handleCompact = useCallback(async () => {
    try {
      if (dm) await conversationMemberAction(scope.scopeId, member.memberId, "steer", "/compact");
      else await steerAgent(roomId!, member.memberId, "/compact");
      toast(`Compact started for ${member.name}`, "success");
    } catch (err) {
      console.error("Failed to compact member context", err);
      toast("Couldn’t compact this conversation. Try again.", "error");
    }
  }, [dm, roomId, member, scope.scopeId, toast]);
  const handleResetSession = useCallback(async () => {
    const ok = await confirm(`Reset session for @${member.name}?\n\nThis clears the member's working session memory and starts fresh. Messages and activity history stay visible.`);
    if (!ok) return;
    try {
      if (dm) await conversationMemberAction(scope.scopeId, member.memberId, "reset-session");
      else await resetAgentSession(roomId!, member.memberId);
      toast(`${member.name} session reset`, "success");
    } catch (err) {
      console.error("Failed to reset member session", err);
      toast("Couldn’t reset this session. Try again.", "error");
    }
  }, [dm, roomId, member, scope.scopeId, confirm, toast]);
  const handleRestart = useCallback(async () => {
    try {
      await restartMember(member.memberId, roomId!);
      toast(`${member.name} restarted`, "success");
    } catch (err) {
      console.error("Failed to restart member", err);
      toast("Couldn’t restart this member. Try again, or check Runtime settings.", "error");
    }
  }, [member, roomId, toast]);

  if (!memberInfo) return <div className="text-xs text-ink-4 py-8 text-center">Loading this scope…</div>;

  const globalModelLabel = member.global?.model ?? null;

  return (
    <div className="space-y-4 pb-6">
      <StatusGrid status={scope.status} member={memberInfo} contextUsage={contextUsage} stats={stats} models={models} dm={dm} />
      <ScopeModelCard
        dm={dm}
        member={memberInfo}
        models={models}
        unifiedModel={member.unifiedModel}
        globalModelLabel={globalModelLabel}
        onGoGlobal={onGoGlobal}
        onSwitchModel={handleSwitchModel}
        onSwitchThinking={handleSwitchThinking}
      />
      <ContextSessionCard
        contextUsage={contextUsage}
        onCompact={handleCompact}
        onResetSession={handleResetSession}
        onRestart={handleRestart}
        dm={dm}
      />
      <ActiveToolsSection
        roomId={dm ? scope.scopeId : roomId!}
        memberRef={memberInfo.id || memberInfo.name}
        status={scope.status}
        reloadKey={0}
        dmScope={dmScope}
      />
      <ExtensionsAccordion
        installedExtensions={installedExtensions}
        extensionsLoadStatus={extensionsLoadStatus}
        onRetryExtensions={() => {
          setExtensionsLoadStatus("loading");
          void getExtensions()
            .then((e) => { setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); })
            .catch(() => setExtensionsLoadStatus("error"));
        }}
        memberExtensions={memberInfo.extensions || []}
        onToggleExtension={handleToggleExtension}
        onOpenExtensionsSettings={onOpenExtensionsSettings}
      />
      <McpToolsAccordion
        mcpEnabled={mcpEnabled}
        mcpServers={mcpServers}
        mcpLoadStatus={mcpLoadStatus}
        onRetryMcp={() => {
          setMcpLoadStatus("loading");
          void getMcpSettings()
            .then((s) => { setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); })
            .catch(() => setMcpLoadStatus("error"));
        }}
        memberMcpServers={memberInfo.mcpServers || []}
        onToggleMcp={handleToggleMcp}
        onOpenMcpSettings={() => onOpenMcpSettings?.()}
      />
      <CoreCard corePrompt={corePrompt} />
      <section className="rounded-xl border border-line-soft bg-surface-1 overflow-hidden">
        <div className="flex items-center gap-2 px-4 pt-3 min-w-0">
          <h3 className="text-[13.5px] font-bold text-ink-1 truncate">Activity</h3>
          <AssetTag tone={dm ? "dm" : "room"}>{dm ? "this DM" : "this room"}</AssetTag>
        </div>
        <div className="text-[11.5px] text-ink-4 px-4 mt-0.5 pb-2">Recent turns by this member in {dm ? "this DM" : "this room"}.</div>
        <div className="h-[440px] border-t border-line-soft">
          <ActivityTab
            roomId={dm ? scope.scopeId : roomId!}
            agentName={member.name}
            dmScope={dmScope}
          />
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-2.5">
      <h2 className="text-[13px] font-semibold text-ink-1">{title}</h2>
      {hint && <p className="text-[11.5px] text-ink-4 mt-0.5 leading-snug">{hint}</p>}
    </div>
  );
}
