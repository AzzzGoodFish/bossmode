/**
 * MemberCreatePage — import-only (batch-1 identity rework, fish 2026-08-25).
 *
 * New members are created one-click from the Contacts header (zero form — the
 * backend assigns a unique default name, the member wakes up in its DM). This
 * page keeps the remaining reason to visit: importing a member from a legacy /
 * fired archive (memory comes back, chat windows start fresh).
 *
 * API: GET /api/members/archive-list, POST /api/members (importFromArchive).
 */
import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { BackLink } from "../components/BackLink";
import { createGlobalMember, getMemberArchiveList, type ArchiveEntry } from "../api/client";

export function MemberCreatePage({ onBack, onCreated }: {
  onBack: () => void;
  onCreated: (memberId: string) => void;
}) {
  const [archives, setArchives] = useState<ArchiveEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    getMemberArchiveList()
      .then((r) => setArchives(r.archives))
      .catch((e) => setLoadError(String(e?.message || e)));
  }, []);

  const importArchive = async (a: ArchiveEntry) => {
    setImportingPath(a.archivePath);
    setSubmitError(null);
    try {
      const res = await createGlobalMember({
        name: a.name,
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

        <h1 className="text-[19px] font-bold tracking-tight text-ink-1">Import member</h1>
        <p className="text-[12.5px] text-ink-3 mt-1 mb-6">
          Members from a previous version — memory comes back (persona, scope notes), chat windows start fresh.
        </p>

        {loadError && <div role="alert" className="text-[12px] text-blocked mb-3">Couldn't load archives. {loadError}</div>}
        {submitError && <div role="alert" className="text-[12px] text-blocked mb-3">{submitError}</div>}

        {!archives ? (
          <div className="text-xs text-ink-4 py-3">Loading…</div>
        ) : archives.length === 0 ? (
          <div className="rounded-xl border border-line-soft bg-surface-1 px-4 py-8 text-center">
            <div className="text-[13px] text-ink-3">No archived members.</div>
            <div className="text-[11.5px] text-ink-4 mt-1">Fired or legacy members show up here. To hire a new one, use New member on the Contacts page.</div>
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}
