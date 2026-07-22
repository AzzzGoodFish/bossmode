import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { TeamAgentSummary, TeamTemplateDetail } from "../api/client";
import { getTeam } from "../api/client";
import { Markdown } from "../components/Markdown";
import { userActionError } from "../utils/user-error";

interface TeamDetailPageProps {
  name: string;
  onBack: () => void;
}

function avatarLetter(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

function SkillChip({ name }: { name: string }) {
  return (
    <span className="rounded-full border border-think/40 bg-think/10 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-think">
      {name}
    </span>
  );
}

function AgentAccordion({ agent, isLeader }: { agent: TeamAgentSummary; isLeader: boolean }) {
  const [open, setOpen] = useState(false);
  const skills = agent.skills ?? [];
  return (
    <div className="mb-2 overflow-hidden rounded-[11px] border border-line-soft bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-bold text-ink-2">
          {avatarLetter(agent.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-semibold text-ink-1">{agent.name}.md</span>
            {isLeader && (
              <span className="rounded-full border border-accent bg-accent-dim px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-accent-ink">
                leader
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-4">{agent.description || "Agent"}</div>
        </div>
        <div className="hidden flex-wrap gap-1 sm:flex">
          {skills.map((s) => <SkillChip key={s} name={s} />)}
        </div>
        <ChevronRight size={14} className={`shrink-0 text-ink-4 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="border-t border-line-soft bg-inset px-4 py-3">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-ink-4">frontmatter</div>
          <pre className="mb-2.5 whitespace-pre-wrap rounded-md bg-surface-2 px-2.5 py-2 font-mono text-[11px] text-ink-3">
{`name: ${agent.name}${agent.description ? `\ndescription: ${agent.description}` : ""}${skills.length ? `\nskills: [${skills.join(", ")}]` : ""}`}
          </pre>
          {(agent.description || agent.systemPrompt) && (
            <>
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-ink-4">about</div>
              <div className="mb-2 text-[12.5px] leading-relaxed text-ink-2">
                {agent.systemPrompt ? <Markdown content={agent.systemPrompt} /> : <p>{agent.description}</p>}
              </div>
            </>
          )}
          {skills.length > 0 && (
            <>
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-ink-4">uses skills (from this team's skills/)</div>
              <div className="flex flex-wrap gap-1.5">{skills.map((s) => <SkillChip key={s} name={s} />)}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Team template detail — team.md, agents accordion, skills, other resources. */
export function TeamDetailPage({ name, onBack }: TeamDetailPageProps) {
  const [team, setTeam] = useState<TeamTemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTeam(name)
      .then((t) => { if (!cancelled) setTeam(t); })
      .catch((err) => {
        console.error("Failed to load team", err);
        if (!cancelled) setError(userActionError("load team"));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [name]);

  if (loading && !team) {
    return (
      <div className="flex flex-1 items-center justify-center bg-surface-1 text-sm text-ink-4">Loading team…</div>
    );
  }

  if (error || !team) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-surface-1 px-6">
        <p className="text-sm text-blocked">{error || "Team not found."}</p>
        <button type="button" onClick={onBack} className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2">Back to teams</button>
      </div>
    );
  }

  const meta = team.meta;
  const skills = team.skills ?? [];
  const resources = team.otherResources ?? [];
  const agents = team.agents ?? [];
  const leader = meta.leader;

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="mx-auto w-full max-w-[880px] px-6 py-7 md:px-9 pb-16">
        <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-xs text-ink-4 hover:text-ink-1">
          <ArrowLeft size={14} /> Teams
        </button>

        <div className="mb-5 flex items-start gap-3.5">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] bg-accent-dim text-lg font-extrabold text-accent-ink">
            {avatarLetter(meta.name)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-[19px] font-bold tracking-tight text-ink-1">
              {meta.name}{" "}
              <span className={`ml-1 align-middle rounded-full border px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide ${
                team.builtIn ? "border-line-soft bg-surface-2 text-ink-3" : "border-accent bg-accent-dim text-accent-ink"
              }`}>
                {meta.version}
              </span>
            </h1>
            <p className="mt-1 text-[11.5px] text-ink-4">
              {agents.length} agent{agents.length === 1 ? "" : "s"}
              {skills.length > 0 ? ` · ${skills.length} skill${skills.length === 1 ? "" : "s"}` : ""}
              {leader ? <> · leader <b className="text-ink-2">{leader}</b></> : null}
              {" · "}
              {(team.usedInRoomCount ?? 0) > 0
                ? `used in ${team.usedInRoomCount} room${team.usedInRoomCount === 1 ? "" : "s"}`
                : "not used yet"}
            </p>
          </div>
        </div>

        <SectionLabel>team.md — introduction</SectionLabel>
        <div className="rounded-xl border border-line-soft bg-surface-1 px-4 py-3.5">
          {team.teamMdBody?.trim() ? (
            <div className="preview-markdown text-[13px] leading-relaxed text-ink-2">
              <Markdown content={team.teamMdBody} />
            </div>
          ) : (
            <p className="text-sm text-ink-4">{meta.description || "No introduction."}</p>
          )}
        </div>

        <SectionLabel>agents/ — roster ({agents.length}) · click to expand</SectionLabel>
        <div>
          {agents.length === 0 ? (
            <p className="text-sm text-ink-4">No agents in this template.</p>
          ) : (
            agents.map((a) => (
              <AgentAccordion key={a.name} agent={a} isLeader={a.name === leader} />
            ))
          )}
        </div>

        <SectionLabel>skills/ — bundled skills ({skills.length})</SectionLabel>
        <div className="rounded-xl border border-line-soft bg-surface-1 px-4 py-1">
          {skills.length === 0 ? (
            <p className="py-3 text-xs text-ink-4">No bundled skills.</p>
          ) : (
            skills.map((s) => (
              <div key={s.name} className="flex items-center gap-3 border-b border-line-soft py-2.5 last:border-b-0">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xs text-think">◆</span>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[12.5px] font-semibold text-ink-1">{s.name}/SKILL.md</div>
                  <div className="mt-0.5 text-[10.5px] text-ink-4">
                    {s.description || ""}
                    {s.usedBy?.length ? ` · used by ${s.usedBy.join(", ")}` : " · unused"}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {resources.length > 0 && (
          <>
            <SectionLabel>other resources ({resources.length})</SectionLabel>
            <div className="rounded-xl border border-line-soft bg-surface-1 px-4 py-1">
              {resources.map((path) => (
                <div key={path} className="flex items-center gap-3 border-b border-line-soft py-2.5 last:border-b-0">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-xs text-ink-3">▤</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12.5px] font-semibold text-ink-1">{path}</div>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-ink-4">
              Extra files bundled in the template, referenced from <code className="rounded bg-surface-3 px-1 py-0.5 text-[11px]">team.md</code>. Not part of the team standard — shown so nothing in the package is hidden.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 mt-5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-ink-4 first:mt-0">
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-line-soft" />
    </div>
  );
}
