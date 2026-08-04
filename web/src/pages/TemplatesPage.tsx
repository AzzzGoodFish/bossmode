/**
 * TemplatesPage — agent template management (0.20).
 *
 * Templates are identity prompt sources: members follow a template, and
 * template edits apply to every referencing member on next activation.
 * Built-in templates (factory catalog + general) are immutable; custom
 * templates can be edited/deleted — deleting a referenced template needs
 * force and falls those members back to general (server posts a system
 * alert to their DM + rooms).
 *
 * APIs: GET /api/templates, GET/POST/PUT/DELETE /api/agents[/:name],
 * GET /api/contacts (resolve referencedBy IDs → names).
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import { BackLink } from "../components/BackLink";
import {
  getTemplates, getAgent, createAgent, updateAgent, deleteAgent, forceDeleteAgent, getContacts,
  type TemplateInfo, type AgentDetail,
} from "../api/client";

function scaffold(name: string, description: string, prompt: string): string {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${prompt}`;
}

export function TemplatesPage({ selected, onSelect }: { selected?: string; onSelect?: (name: string | null) => void }) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [memberNames, setMemberNames] = useState<Map<string, string>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () => {
    getTemplates().then(setTemplates).catch((e) => setLoadError(String(e?.message || e)));
    getContacts()
      .then((r) => setMemberNames(new Map(r.contacts.map((c) => [c.memberId, c.name]))))
      .catch(() => {});
  };
  useEffect(load, []);

  const resolveNames = useMemo(
    () => (ids: string[]) => ids.map((id) => memberNames.get(id) ?? id.slice(0, 12)),
    [memberNames],
  );

  if (creating) {
    return (
      <TemplateCreate
        onBack={() => setCreating(false)}
        onCreated={(name) => { setCreating(false); load(); onSelect?.(name); }}
      />
    );
  }
  if (selected) {
    const t = templates?.find((x) => x.name === selected);
    return (
      <TemplateDetail
        name={selected}
        builtin={t?.builtin ?? false}
        referencedBy={resolveNames(t?.referencedBy ?? [])}
        onBack={() => { load(); onSelect?.(null); }}
        onDeleted={() => { load(); onSelect?.(null); }}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full max-w-3xl mx-auto px-6 pt-7 pb-16">
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <h1 className="text-[19px] font-bold tracking-tight text-ink-1">Templates</h1>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-contrast text-xs font-semibold hover:opacity-90 cursor-pointer"
          >
            <Plus size={13} /> New template
          </button>
        </div>
        <p className="text-[12.5px] text-ink-3 mb-5">
          Identity prompt sources — a member follows its template; edits apply to every member using it on next activation.
        </p>

        {loadError && <div role="alert" className="text-[12px] text-blocked mb-3">Couldn’t load templates. {loadError}</div>}
        {!templates ? (
          <div className="text-xs text-ink-4 py-4">Loading…</div>
        ) : (
          <div className="rounded-xl border border-line divide-y divide-line-soft">
            {templates.map((t) => {
              const usedBy = resolveNames(t.referencedBy);
              return (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => onSelect?.(t.name)}
                  className="w-full text-left px-4 py-3.5 hover:bg-surface-2 transition-colors cursor-pointer flex items-center gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13.5px] font-semibold text-ink-1">{t.name}</span>
                      {t.builtin && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-surface-2 text-ink-3 border border-line">
                          <Lock size={9} /> built-in
                        </span>
                      )}
                    </div>
                    <div className="text-[11.5px] text-ink-3 mt-0.5 truncate">{t.description}</div>
                  </div>
                  <span className="shrink-0 text-[11px] text-ink-4" title={usedBy.join(", ")}>
                    {usedBy.length === 0 ? "unused" : `used by ${usedBy.length}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── detail ── */

function TemplateDetail({ name, builtin, referencedBy, onBack, onDeleted }: {
  name: string;
  builtin: boolean;
  referencedBy: string[];
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    getAgent(name)
      .then(setAgent)
      .catch((e) => setLoadError(String(e?.message || e)));
  }, [name]);

  const startEdit = () => {
    if (!agent) return;
    setDraft(scaffold(agent.name, agent.description ?? "", agent.systemPrompt ?? ""));
    setEditing(true);
    setSaveError(null);
  };

  const save = async () => {
    setSaveState("saving"); setSaveError(null);
    try {
      await updateAgent(name, draft);
      const fresh = await getAgent(name);
      setAgent(fresh);
      setEditing(false);
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1800);
    } catch (e) {
      setSaveError(String((e as Error)?.message || e));
      setSaveState("error");
    }
  };

  const doDelete = async (force: boolean) => {
    setDeleting(true); setDeleteError(null);
    try {
      if (force) await forceDeleteAgent(name);
      else await deleteAgent(name);
      onDeleted();
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg.includes("referenced")) setDeleteError("Still referenced — use force delete below.");
      else setDeleteError(msg);
      setDeleting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full max-w-3xl mx-auto px-6 pt-7 pb-16">
        <BackLink label="Templates" onClick={onBack} />
        <div className="flex items-center gap-2.5 mb-1">
          <h1 className="text-[19px] font-bold tracking-tight text-ink-1">{name}</h1>
          {builtin && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-surface-2 text-ink-3 border border-line">
              <Lock size={9} /> built-in
            </span>
          )}
        </div>
        <p className="text-[12.5px] text-ink-3 mb-4">{agent?.description ?? ""}</p>

        <div className="flex items-center gap-1.5 flex-wrap mb-5">
          <span className="text-[11px] text-ink-4 mr-1">Used by:</span>
          {referencedBy.length === 0 ? (
            <span className="text-[11px] text-ink-4">no members</span>
          ) : (
            referencedBy.map((n) => (
              <span key={n} className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{n}</span>
            ))
          )}
        </div>

        {loadError && <div role="alert" className="text-[12px] text-blocked mb-3">{loadError}</div>}

        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold tracking-[0.06em] text-ink-3">PROMPT</h2>
          {!builtin && !editing && agent && (
            <button type="button" onClick={startEdit} className="text-[11.5px] font-semibold text-accent-ink hover:underline cursor-pointer">Edit</button>
          )}
        </div>

        {builtin ? (
          <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
            <pre className="text-[11.5px] text-ink-2 leading-relaxed whitespace-pre-wrap font-mono max-h-[420px] overflow-y-auto">{agent?.systemPrompt ?? "…"}</pre>
            <p className="text-[11px] text-ink-4 mt-3 pt-2.5 border-t border-line-soft">Built-in templates are immutable — they can’t be edited or deleted.</p>
          </div>
        ) : editing ? (
          <div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              className="w-full rounded-xl border border-line bg-inset px-4 py-3.5 text-[11.5px] font-mono text-ink-1 leading-relaxed outline-none focus:border-accent resize-y"
            />
            <div className="flex items-center gap-2 mt-2.5">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saveState === "saving"}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-accent text-accent-contrast text-xs font-semibold hover:opacity-90 cursor-pointer disabled:opacity-40"
              >
                {saveState === "saving" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
              </button>
              <button type="button" onClick={() => setEditing(false)} className="px-3.5 py-2 rounded-lg border border-line text-xs font-semibold text-ink-2 hover:bg-surface-2 cursor-pointer">Cancel</button>
              {saveError && <span role="alert" className="text-[11px] text-blocked">{saveError}</span>}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-inset px-4 py-3.5">
            <pre className="text-[11.5px] text-ink-2 leading-relaxed whitespace-pre-wrap font-mono max-h-[420px] overflow-y-auto">{agent?.systemPrompt ?? "…"}</pre>
            {saveState === "saved" && <p className="text-[11px] text-onair mt-3 pt-2.5 border-t border-line-soft">✓ Saved — applies to referencing members on next activation.</p>}
          </div>
        )}

        {/* danger zone — custom only */}
        {!builtin && (
          <div className="mt-8 rounded-xl border border-blocked/40 bg-blocked/5 px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ink-1">Delete template</div>
                <p className="text-[11.5px] text-ink-3 mt-0.5">
                  {referencedBy.length > 0
                    ? `${referencedBy.length} member${referencedBy.length === 1 ? "" : "s"} use it — force delete falls them back to general and posts a system alert.`
                    : "No members use this template."}
                </p>
              </div>
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-blocked/50 text-blocked text-xs font-semibold hover:bg-blocked/10 cursor-pointer"
                >
                  <Trash2 size={13} /> Delete
                </button>
              ) : (
                <div className="shrink-0 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void doDelete(false)}
                    disabled={deleting}
                    className="px-3 py-1.5 rounded-lg bg-blocked text-white text-xs font-semibold cursor-pointer disabled:opacity-40"
                  >
                    {deleting ? <Loader2 size={13} className="animate-spin" /> : "Confirm delete"}
                  </button>
                  {referencedBy.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void doDelete(true)}
                      disabled={deleting}
                      className="px-3 py-1.5 rounded-lg border border-blocked text-blocked text-xs font-semibold cursor-pointer disabled:opacity-40"
                    >
                      Force (→ general)
                    </button>
                  )}
                  <button type="button" onClick={() => { setConfirmDelete(false); setDeleteError(null); }} className="text-[11.5px] text-ink-3 hover:underline cursor-pointer">Cancel</button>
                </div>
              )}
            </div>
            {deleteError && <div role="alert" className="text-[11px] text-blocked mt-2">{deleteError}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── create ── */

function TemplateCreate({ onBack, onCreated }: { onBack: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = /^[a-z0-9][a-z0-9-_]{0,31}$/i.test(name.trim());
  const canCreate = nameValid && prompt.trim().length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      await createAgent(name.trim(), scaffold(name.trim(), description.trim(), prompt));
      onCreated(name.trim());
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full max-w-3xl mx-auto px-6 pt-7 pb-16">
        <BackLink label="Templates" onClick={onBack} />
        <h1 className="text-[19px] font-bold tracking-tight text-ink-1 mb-1">New template</h1>
        <p className="text-[12.5px] text-ink-3 mb-5">A reusable identity — members are hired from templates on the New member page.</p>

        <label className="block text-[11px] font-semibold text-ink-3 mb-1.5">Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. security-reviewer"
          className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4 mb-3"
        />
        <label className="block text-[11px] font-semibold text-ink-3 mb-1.5">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One line — what this identity owns"
          className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-[13px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4 mb-3"
        />
        <label className="block text-[11px] font-semibold text-ink-3 mb-1.5">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={14}
          placeholder="# Role&#10;&#10;You are…"
          className="w-full rounded-xl border border-line bg-inset px-4 py-3.5 text-[11.5px] font-mono text-ink-1 leading-relaxed outline-none focus:border-accent resize-y placeholder:text-ink-4"
        />
        {error && <div role="alert" className="text-[11px] text-blocked mt-2">{error}</div>}
        <button
          type="button"
          onClick={() => void create()}
          disabled={!canCreate}
          className="mt-3 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-accent text-accent-contrast text-sm font-semibold hover:opacity-90 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy && <Loader2 size={14} className="animate-spin" />} Create template
        </button>
      </div>
    </div>
  );
}
