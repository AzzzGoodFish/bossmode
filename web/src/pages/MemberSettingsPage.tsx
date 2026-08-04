/**
 * MemberSettingsPage — global member settings (0.20).
 *
 * Sections: identity (rename), model & extensions (unified switches +
 * global model select), scopes (read-only list), danger zone (fire with
 * name-typed confirm). All edits save immediately per control (product
 * language: no form submit) with inline Saved feedback.
 *
 * APIs: GET/PATCH/DELETE /api/members/:id, GET /api/members/:id/scopes,
 * GET /api/available-models, GET /api/contacts (name availability).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { BackLink } from "../components/BackLink";
import { StaffBadge } from "../components/StaffBadge";
import {
  getMemberDetail, getMemberScopes, getAvailableModels, getContacts,
  patchGlobalMember, deleteGlobalMember,
  type MemberDetail, type MemberScopeInfo, type AvailableModelOption,
} from "../api/client";

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/i;

type SaveState = "idle" | "saving" | "saved" | "error";

export function MemberSettingsPage({ memberId, onBack, onFired }: {
  memberId: string;
  onBack: () => void;
  onFired: () => void;
}) {
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [scopes, setScopes] = useState<MemberScopeInfo[]>([]);
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [existingNames, setExistingNames] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [nameDraft, setNameDraft] = useState("");
  const [nameSave, setNameSave] = useState<SaveState>("idle");
  const [nameError, setNameError] = useState<string | null>(null);
  const [cfgSave, setCfgSave] = useState<SaveState>("idle");
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [fireDraft, setFireDraft] = useState("");
  const [firing, setFiring] = useState(false);
  const [fireError, setFireError] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getMemberDetail(memberId)
      .then((m) => { setMember(m); setNameDraft(m.name); })
      .catch((e) => setLoadError(String(e?.message || e)));
    getMemberScopes(memberId).then((r) => setScopes(r.scopes)).catch(() => {});
    getAvailableModels().then(setModels).catch(() => {});
    getContacts().then((r) => setExistingNames(new Set(r.contacts.map((c) => c.name.toLowerCase())))).catch(() => {});
    return () => { if (savedTimer.current) clearTimeout(savedTimer.current); };
  }, [memberId]);

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

  const saveName = async () => {
    if (!member) return;
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
    if (!member) return;
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
    if (!member || firing) return;
    setFiring(true); setFireError(null);
    try {
      await deleteGlobalMember(member.memberId);
      onFired();
    } catch (e) {
      setFireError(String((e as Error)?.message || e));
      setFiring(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex-1 overflow-y-auto bg-surface-1">
        <div className="w-full px-6 md:px-10 pt-7 pb-16">
          <BackLink label="Back" onClick={onBack} />
          <div role="alert" className="text-[12px] text-blocked">Couldn’t load member settings. {loadError}</div>
        </div>
      </div>
    );
  }
  if (!member) return <div className="flex-1 grid place-items-center bg-surface-1 text-xs text-ink-4">Loading…</div>;

  const nameChanged = nameDraft.trim() !== member.name;

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full px-6 md:px-10 pt-7 pb-16">
        <BackLink label="Back to conversation" onClick={onBack} />

        {/* header */}
        <div className="flex items-center gap-3.5 mb-7">
          <StaffBadge name={member.name} size="lg" />
          <div className="min-w-0">
            <h1 className="text-[19px] font-bold tracking-tight text-ink-1 truncate">{member.name}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{member.agentTemplate}</span>
              <span className="text-[11px] text-ink-4">member settings</span>
            </div>
          </div>
        </div>

        {/* 1 · identity */}
        <section className="mb-7">
          <SectionTitle title="Identity" hint="The template is the identity prompt source — edit it on the Templates page; changes apply to every member using it." />
          <label className="block text-[11px] font-semibold text-ink-3 mb-1.5">Name</label>
          <div className="flex items-center gap-2">
            <input
              value={nameDraft}
              onChange={(e) => { setNameDraft(e.target.value); setNameError(null); }}
              className="flex-1 rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void saveName()}
              disabled={!nameChanged || nameSave === "saving"}
              className="px-3.5 py-2 rounded-lg border border-line text-xs font-semibold text-ink-2 hover:bg-surface-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {nameSave === "saving" ? <Loader2 size={13} className="animate-spin" /> : nameSave === "saved" ? <span className="inline-flex items-center gap-1 text-onair"><Check size={13} />Saved</span> : "Rename"}
            </button>
          </div>
          {nameError && <div role="alert" className="text-[11px] text-blocked mt-1.5">{nameError}</div>}
          <p className="text-[11px] text-ink-4 mt-1.5">Rename propagates everywhere on next activation — scopes, rooms, and memory stay linked by ID.</p>
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
                    {member.unifiedModel ? "Every scope uses the global model below." : "Model is configured per scope — in each conversation’s member panel."}
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

        {/* 3 · scopes */}
        <section className="mb-7">
          <SectionTitle title="Scopes" hint="Where this member has a conversation. Memory is readable across scopes; each scope keeps its own working notes." />
          {scopes.length === 0 ? (
            <div className="text-[12px] text-ink-4 py-2">No scopes yet.</div>
          ) : (
            <div className="rounded-xl border border-line divide-y divide-line-soft">
              {scopes.map((s) => (
                <div key={s.scopeId} className="px-4 py-3 flex items-center gap-3">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.status === "working" ? "bg-onair" : s.status === "error" ? "bg-blocked" : "bg-ink-4"}`} />
                  <span className="text-[13px] text-ink-1 flex-1 min-w-0 truncate">{s.label}</span>
                  <span className="text-[10px] font-semibold tracking-wide uppercase text-ink-4">{s.kind}</span>
                  <span className="text-[11px] text-ink-4 w-16 text-right">{s.status}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 4 · danger zone */}
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
      </div>
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

function ToggleSwitch({ on, onToggle, label }: { on: boolean; onToggle: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onToggle(!on)}
      className={`relative shrink-0 w-9 h-5 rounded-full transition-colors cursor-pointer ${on ? "bg-accent" : "bg-line-strong"}`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}
