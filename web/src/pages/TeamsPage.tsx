import { useEffect, useRef, useState } from "react";
import { Search, Upload } from "lucide-react";
import type { TeamTemplateSummary } from "../api/client";
import { getTeams, importTeamZip } from "../api/client";
import { matchesWorkspaceResourceSearch } from "./resource-list-filter";
import { userActionError } from "../utils/user-error";

interface TeamsPageProps {
  onSelectTeam: (name: string) => void;
  onRefresh?: () => void;
}

function avatarLetter(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

/** Teams template library — list + import entry (prototype: Teams zone). */
export function TeamsPage({ onSelectTeam, onRefresh }: TeamsPageProps) {
  const [teams, setTeams] = useState<TeamTemplateSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      setTeams(await getTeams());
    } catch (err) {
      console.error("Failed to load teams", err);
      setError(userActionError("load teams"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = teams.filter((t) => matchesWorkspaceResourceSearch({ name: t.name, description: t.description }, search));

  const handleImport = async (file: File | null) => {
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      const team = await importTeamZip(file);
      await load();
      onRefresh?.();
      onSelectTeam(team.meta?.name || team.slug);
    } catch (err) {
      console.error("Failed to import team", err);
      setImportError(err instanceof Error ? err.message : userActionError("import team"));
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-surface-1">
      <div className="w-full max-w-[960px] mx-auto px-6 md:px-9 pt-7 pb-16">
        <div className="flex items-end justify-between gap-4 mb-1">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-ink-1">Teams</h1>
            <p className="text-xs text-ink-4 mt-0.5 max-w-xl">
              Reusable team templates — a named group of agents plus their skills. Instantiate one into a Room to start working.
            </p>
          </div>
          <div className="shrink-0 mb-0.5">
            <input
              ref={fileRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => void handleImport(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              disabled={importing}
              onClick={() => fileRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-3 py-2 text-xs font-semibold text-ink-2 hover:border-line-strong hover:bg-surface-2 disabled:opacity-50"
            >
              <Upload size={14} />
              {importing ? "Importing…" : "Import team (.zip)"}
            </button>
          </div>
        </div>

        {(error || importError) && (
          <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
            <span>{error ? `Couldn't load teams. ${error}` : `Import failed. ${importError}`}</span>
            <button type="button" onClick={() => { setImportError(null); void load(); }} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked-dim">Retry</button>
          </div>
        )}

        <div className="relative mb-5 mt-4 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search teams…"
            className="w-full rounded-lg border border-line bg-inset py-2 pl-9 pr-3 text-sm text-ink-1 outline-none focus:border-line-strong"
          />
        </div>

        {loading && !teams.length ? (
          <p className="text-sm text-ink-4">Loading teams…</p>
        ) : filtered.length === 0 && !loading ? (
          <div className="rounded-xl border border-dashed border-line bg-inset px-6 py-12 text-center">
            <p className="text-sm font-medium text-ink-2">{search ? "No teams match your search." : "No team templates yet."}</p>
            <p className="mt-1 text-xs text-ink-4">
              {search ? "Try a different query." : "Import a .zip package with team.md + agents/ (+ optional skills/)."}
            </p>
            {!search && (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-accent-contrast hover:opacity-90"
              >
                <Upload size={14} /> Import team (.zip)
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {filtered.map((t) => {
              const agentNames = t.agentNames ?? [];
              const skillCount = (t.skillNames ?? []).length;
              return (
                <button
                  key={t.slug || t.name}
                  type="button"
                  onClick={() => onSelectTeam(t.slug || t.name)}
                  className="flex flex-col gap-3 rounded-xl border border-line bg-surface-1 p-4 text-left transition-colors hover:border-line-strong hover:shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-accent-dim text-sm font-extrabold text-accent-ink">
                      {avatarLetter(t.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1 truncate text-[14.5px] font-bold text-ink-1">{t.name}</div>
                        <span className="shrink-0 rounded-full border border-line-soft px-2 py-0.5 font-mono text-[10px] text-ink-4">{t.version}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-ink-3">{t.description || "No description."}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {agentNames.slice(0, 8).map((n) => (
                      <span
                        key={n}
                        title={n + (n === t.leader ? " (leader)" : "")}
                        className={`flex items-center justify-center rounded-full bg-surface-3 text-[9px] font-bold text-ink-2 ${
                          n === t.leader ? "outline outline-2 outline-offset-1 outline-accent" : ""
                        }`}
                        style={{ width: 22, height: 22 }}
                      >
                        {avatarLetter(n)}
                      </span>
                    ))}
                    <span className="ml-1 text-[10.5px] text-ink-4">
                      {agentNames.length} agent{agentNames.length === 1 ? "" : "s"}
                      {skillCount > 0 ? ` · ${skillCount} skill${skillCount === 1 ? "" : "s"}` : ""}
                      {t.leader ? <> · leader <b className="text-ink-2">{t.leader}</b></> : null}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[10.5px] text-ink-4">
                    {t.builtIn ? (
                      <span className="rounded-full border border-line-soft bg-surface-2 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-3">built-in</span>
                    ) : (
                      <span className="rounded-full border border-line px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-ink-4">template</span>
                    )}
                    <span>{t.usedInRoomCount > 0 ? `used in ${t.usedInRoomCount} room${t.usedInRoomCount === 1 ? "" : "s"}` : "not used yet"}</span>
                    <span className="ml-auto font-semibold text-accent-ink">Open →</span>
                  </div>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex min-h-[150px] flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-line bg-surface-1 p-4 text-ink-4 transition-colors hover:border-line-strong hover:text-ink-2"
            >
              <Upload size={22} />
              <span className="text-[12.5px] font-semibold">Import a team</span>
              <span className="text-[10.5px]">zip package · team.md + agents/ + skills/</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
