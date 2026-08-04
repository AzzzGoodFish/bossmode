/**
 * MemberCreatePage — hire a digital employee (0.20).
 *
 * Flow: pick a template → name (globally unique, live-checked) → optional
 * model → create → lands in the DM. Below: import a member from a legacy /
 * fired archive (memory comes back, chat windows start fresh).
 *
 * APIs: GET /api/agents (templates), GET /api/available-models,
 * GET /api/members/archive-list, POST /api/members (409 name_taken).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { BackLink } from "../components/BackLink";
import {
  getAgents, getAvailableModels, getContacts, getMemberArchiveList, createGlobalMember,
  type AgentInfo, type AvailableModelOption, type ArchiveEntry,
} from "../api/client";

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/i;

export function MemberCreatePage({ onBack, onCreated }: {
  onBack: () => void;
  onCreated: (memberId: string) => void;
}) {
  const [templates, setTemplates] = useState<AgentInfo[] | null>(null);
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [archives, setArchives] = useState<ArchiveEntry[]>([]);
  const [existingNames, setExistingNames] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [template, setTemplate] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [modelRef, setModelRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    getAgents().then(setTemplates).catch((e) => setLoadError(String(e?.message || e)));
    getAvailableModels().then(setModels).catch(() => {});
    getMemberArchiveList().then((r) => setArchives(r.archives)).catch(() => {});
    getContacts().then((r) => setExistingNames(new Set(r.contacts.map((c) => c.name.toLowerCase())))).catch(() => {});
  }, []);

  const nameTrim = name.trim();
  const nameValid = NAME_RE.test(nameTrim);
  const nameTaken = nameValid && existingNames.has(nameTrim.toLowerCase());
  const canCreate = !!template && nameValid && !nameTaken && !busy;

  const groupedModels = useMemo(() => {
    const groups = new Map<string, AvailableModelOption[]>();
    for (const m of models) {
      const key = m.profileName || m.providerSlug;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return [...groups.entries()];
  }, [models]);

  const create = async () => {
    if (!canCreate || !template) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await createGlobalMember({
        name: nameTrim,
        agentTemplate: template,
        ...(modelRef ? { model: modelRef } : {}),
      });
      onCreated(res.member.memberId);
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      setSubmitError(msg.includes("name_taken") ? `The name "${nameTrim}" is already taken.` : msg);
      setBusy(false);
    }
  };

  const importArchive = async (a: ArchiveEntry) => {
    setImportingPath(a.archivePath);
    setSubmitError(null);
    try {
      const res = await createGlobalMember({
        name: a.name,
        agentTemplate: a.template,
        importFromArchive: a.archivePath,
      });
      onCreated(res.member.memberId);
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      setSubmitError(msg.includes("name_taken") ? `"${a.name}" already exists — delete or rename the existing member first.` : msg);
      setImportingPath(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full px-6 md:px-10 pt-7 pb-16">
        <BackLink label="Contacts" onClick={onBack} />

        <h1 className="text-[19px] font-bold tracking-tight text-ink-1">New member</h1>
        <p className="text-[12.5px] text-ink-3 mt-1 mb-6">
          Hire a digital employee — one identity that works in DM and any room, with shared memory.
        </p>

        {loadError && <div role="alert" className="text-[12px] text-blocked mb-3">Couldn’t load templates. {loadError}</div>}

        {/* 1 · template */}
        <Section index="1" title="Template" hint="Identity prompt source — the member follows the template, changes apply on next activation.">
          {!templates ? (
            <div className="text-xs text-ink-4 py-3">Loading…</div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
              {templates.map((t) => {
                const on = template === t.name;
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => setTemplate(t.name)}
                    className={`rounded-xl border p-3 text-left transition-colors cursor-pointer ${
                      on ? "border-accent bg-accent-dim/40" : "border-line bg-surface-1 hover:border-line-strong"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[13px] font-semibold ${on ? "text-accent-ink" : "text-ink-1"}`}>{t.name}</span>
                      {on && <Check size={14} className="text-accent-ink shrink-0" />}
                    </div>
                    <div className="text-[11px] text-ink-3 mt-1 leading-snug line-clamp-2">{t.description}</div>
                  </button>
                );
              })}
            </div>
          )}
        </Section>

        {/* 2 · name */}
        <Section index="2" title="Name" hint="Globally unique — how you'll @ them in every scope.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. arch-bossmode"
            className={`w-full rounded-lg border bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none placeholder:text-ink-4 ${
              nameTaken ? "border-blocked" : "border-line focus:border-accent"
            }`}
          />
          {nameTrim && !nameValid && <div className="text-[11px] text-blocked mt-1.5">Letters, digits, - and _ only, up to 32 chars.</div>}
          {nameTaken && <div className="text-[11px] text-blocked mt-1.5">That name is taken.</div>}
          {nameValid && !nameTaken && <div className="text-[11px] text-onair mt-1.5">✓ Available</div>}
        </Section>

        {/* 3 · model (optional) */}
        <Section index="3" title="Model" hint="Optional — configure now or later in member settings. Unified config is on by default (all scopes share it).">
          <select
            value={modelRef}
            onChange={(e) => setModelRef(e.target.value)}
            className="w-full max-w-lg rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent cursor-pointer"
          >
            <option value="">Configure later</option>
            {groupedModels.map(([group, items]) => (
              <optgroup key={group} label={group}>
                {items.map((m) => (
                  <option key={m.ref} value={m.ref}>{m.displayName || m.modelId} · {m.ref}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Section>

        {submitError && <div role="alert" className="text-[12px] text-blocked mb-3">{submitError}</div>}

        <button
          type="button"
          onClick={() => void create()}
          disabled={!canCreate}
          className="w-full max-w-lg py-2.5 rounded-lg bg-accent text-accent-contrast text-sm font-semibold hover:opacity-90 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Create member
        </button>

        {/* archive import */}
        {archives.length > 0 && (
          <div className="mt-10">
            <div className="flex items-center gap-3 mb-3">
              <span className="flex-1 h-px bg-line-soft" />
              <span className="text-[11px] uppercase tracking-wide text-ink-4 font-semibold">Import from archive</span>
              <span className="flex-1 h-px bg-line-soft" />
            </div>
            <p className="text-[12px] text-ink-3 mb-3">
              Members from a previous version — memory comes back (persona, scope notes), chat windows start fresh.
            </p>
            <div className="space-y-2">
              {archives.map((a) => (
                <div key={a.archivePath + a.name} className="rounded-xl border border-line bg-surface-1 px-4 py-3 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink-1">{a.name}</span>
                      <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{a.template}</span>
                      <span className="text-[10px] text-ink-4">{a.kind}</span>
                    </div>
                    <div className="text-[11px] text-ink-4 mt-0.5">
                      {a.hasPersona ? "persona ✓" : "no persona"} · {a.roomScopes.length} room scope{a.roomScopes.length === 1 ? "" : "s"}
                      {a.credentialHint ? ` · credential hint ${a.credentialHint}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void importArchive(a)}
                    disabled={importingPath !== null}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 border border-line rounded-lg text-xs font-semibold text-ink-2 hover:bg-surface-2 cursor-pointer disabled:opacity-40"
                  >
                    {importingPath === a.archivePath ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    Import
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ index, title, hint, children }: { index: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[11px] font-bold text-accent-ink tabular-nums">{index}</span>
        <h2 className="text-[13px] font-semibold text-ink-1">{title}</h2>
      </div>
      <p className="text-[11.5px] text-ink-4 mb-2.5">{hint}</p>
      {children}
    </section>
  );
}
