/**
 * member-scope.tsx — the merged member page's building blocks (member-page
 * merge v1, fish 2026-08-26: settings page + room Sheet become ONE page).
 *
 * Everything here moved VERBATIM from StationPanel.tsx's MemberConfigPanel
 * family (fusion, not repaint — fish 2026-08-26: blend into the existing UI) plus four
 * extractions that turn panel JSX into reusable sections:
 *   ContextSessionCard (and the SessionSectionAccordion shell for Active tools).
 * StationPanel imports the shared utils back from here; nothing here imports
 * StationPanel (no cycle).
 *
 * Batch 5b (config globally unified): ScopeModelCard retired. Batch 6
 * (member-owned assets): the toggle accordions retired — Assets shows
 * read-only listings of the member's own files (presence = enabled).
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  getMemberActiveTools, getConversationTools,
  type AvailableModelOption, type ContextUsageData,
  type MemberActiveTool,
  type MemberSkillEntry, type MemberStats,
} from "../api/client";

// ── shared small utils (moved from StationPanel; imported back there) ──────

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

/** Keep the discriminating model id visible in the compact workstation card. */
export function compactModelId(modelRef: string, models: Pick<AvailableModelOption, "ref" | "modelId">[]): string {
  const catalogModelId = models.find((model) => model.ref === modelRef)?.modelId;
  if (catalogModelId) return catalogModelId;
  const slash = modelRef.indexOf("/");
  return slash >= 0 && modelRef.slice(slash + 1) ? modelRef.slice(slash + 1) : modelRef;
}

export function memberModelAvailabilityLabel(
  modelRef: string | null | undefined,
  credentialId: string | null | undefined,
  models: Pick<AvailableModelOption, "ref" | "profileId" | "modelId">[],
): string | null {
  if (!modelRef || !credentialId) return null;
  if (models.length === 0) return "No model connected";
  const slash = modelRef.indexOf("/");
  const modelId = slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
  const available = models.some((model) => model.profileId === credentialId && model.modelId === modelId);
  return available ? null : `${compactModelId(modelRef, models)} · unavailable`;
}

export function statusLabel(status: string): string {
  switch (status) {
    case "working": return "WORKING";
    case "thinking": return "THINKING";
    case "idle": return "IDLE";
    case "off": return "OFF";
    default: return "OFFLINE";
  }
}

// ── card primitives (verbatim from StationPanel) ────────────────────────────

export function AssetTag({ children, tone }: { children: string; tone?: "room" | "dm" }) {
  return (
    <span className={`text-[9.5px] font-bold uppercase tracking-wide border rounded-full px-2 py-0.5 shrink-0 ${tone === "dm" ? "border-line-soft bg-think-dim text-think" : "border-line-soft bg-surface-2 text-ink-4"}`}>
      {children}
    </span>
  );
}

export function PanelCard({ title, tag, aside, hint, children }: {
  title: string;
  tag?: React.ReactNode;
  aside?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line-soft bg-surface-1 p-4">
      <div className="flex items-center gap-2 min-w-0">
        <h3 className="text-[13.5px] font-bold text-ink-1 truncate">{title}</h3>
        {tag}
        {aside}
      </div>
      {hint ? <div className="text-[11.5px] text-ink-4 mt-0.5 leading-relaxed">{hint}</div> : null}
      {children}
    </section>
  );
}

// ── profile & skills (verbatim from StationPanel) ───────────────────────────

/** The member's skills/ directory, read-only: skills are the member's private,
 * self-maintained assets. */
export function MemberSkillsCard({ skills }: { skills: MemberSkillEntry[] | null }) {
  return (
    <PanelCard
      title="Skills"
      tag={<AssetTag>{skills === null ? "…" : `${skills.length} on file`}</AssetTag>}
    >
      {skills === null ? (
        <div className="text-xs text-ink-4 py-1">Loading…</div>
      ) : skills.length === 0 ? (
        <div className="text-[12px] text-ink-4 py-1">No skills yet — the member writes its own as recurring work settles into routine.</div>
      ) : (
        <div className="mt-2 space-y-1.5">
          {skills.map((sk) => (
            <div key={sk.path} className="rounded-lg border border-line-soft bg-surface-2 px-3 py-2">
              <div className="text-[12px] font-semibold text-ink-1">{sk.name}</div>
              {sk.description ? <div className="text-[11px] text-ink-4 mt-0.5 leading-snug">{sk.description}</div> : null}
            </div>
          ))}
        </div>
      )}
    </PanelCard>
  );
}

// ── context & session (extracted verbatim layout from MemberConfigPanel) ────

export function ContextSessionCard({ contextUsage, onCompact, onResetSession, onRestart, dm }: {
  contextUsage?: ContextUsageData;
  onCompact: () => void;
  onResetSession: () => void;
  onRestart: () => void;
  dm: boolean;
}) {
  const hasUsage = contextUsage != null && contextUsage.supported !== false && typeof contextUsage.percentage === "number";
  const pct = hasUsage ? Math.round(contextUsage!.percentage!) : 0;
  return (
    <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink-1">Context &amp; Session</div>
        </div>
      </div>
      {hasUsage ? (
        <div className="rounded-lg border border-line-soft bg-surface-1 p-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-ink-4"><span>Context used</span><span>{pct}% · {formatTokens(contextUsage!.totalTokens || 0)}</span></div>
          <div className="h-2 rounded-full bg-surface-3 overflow-hidden"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
        </div>
      ) : (
        <div className="rounded-lg border border-line-soft bg-surface-1 p-3 text-xs text-ink-4">Context usage is unavailable for this member.</div>
      )}

      <div className="space-y-2">
        <div className="rounded-xl border border-line-soft bg-surface-1 px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink-1 leading-5">Compact</div>
            <div className="text-[11px] text-ink-4 leading-relaxed">Compress conversation history without changing this member’s setup.</div>
          </div>
          <button
            type="button"
            onClick={onCompact}
            className="shrink-0 min-w-20 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink-2 shadow-sm cursor-pointer transition-colors hover:bg-surface-3 hover:text-ink-1 hover:border-line-strong active:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Run
          </button>
        </div>
        <div className="rounded-xl border border-blocked/30 bg-blocked-dim/25 px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-blocked leading-5">Reset session</div>
            <div className="text-[11px] text-ink-3 leading-relaxed">Start fresh and clear working memory. Room messages stay visible.</div>
          </div>
          <button
            type="button"
            onClick={onResetSession}
            className="shrink-0 min-w-20 rounded-lg border border-blocked/40 bg-blocked/10 px-3 py-1.5 text-xs font-semibold text-blocked shadow-sm cursor-pointer transition-colors hover:bg-blocked/15 hover:border-blocked/60 active:bg-blocked/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-blocked/50"
          >
            Reset…
          </button>
        </div>
      </div>

      {!dm && (
        <div className="rounded-xl border border-line-soft bg-surface-1 px-3 py-2.5 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink-1 leading-5">Restart member</div>
            <div className="text-[11px] text-ink-4 leading-relaxed">If the member is stuck, restart it.</div>
          </div>
          <button
            type="button"
            onClick={onRestart}
            className="shrink-0 min-w-20 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-semibold text-ink-2 shadow-sm cursor-pointer transition-colors hover:bg-surface-3 hover:text-ink-1 hover:border-line-strong active:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            Restart
          </button>
        </div>
      )}
    </section>
  );
}

// ── session accordions (SessionSectionAccordion verbatim; ext/mcp contents
// extracted from MemberConfigPanel JSX) ──────────────────────────────────────

export function SessionSectionAccordion({
  title,
  summary,
  action,
  defaultOpen = false,
  children,
}: {
  title: string;
  summary: string;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-xl border border-line bg-inset/50">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((v) => !v); } }}
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
      >
        <ChevronRight size={14} className={`shrink-0 text-ink-4 transition-transform ${open ? "rotate-90" : ""}`} />
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-semibold ${open ? "text-ink-1" : "text-ink-2"}`}>{title}</div>
          <div className="text-xs text-ink-4 mt-0.5 truncate">{summary}</div>
        </div>
        {action && (
          <div className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            {action}
          </div>
        )}
      </div>
      {open && <div className="px-4 pb-4 space-y-2.5">{children}</div>}
    </section>
  );
}

// ── Active tools (verbatim from StationPanel) ───────────────────────────────

function activeToolsAccordionSummary(
  loading: boolean,
  error: boolean,
  sessionActive: boolean,
  tools: MemberActiveTool[],
): string {
  if (loading) return "Loading…";
  if (error) return "Couldn’t load";
  if (!sessionActive) return "No active session";
  if (tools.length === 0) return "0 live";
  let builtin = 0;
  let bossmode = 0;
  let extension = 0;
  let mcp = 0;
  for (const t of tools) {
    const kind = toolSourceKind(t.source);
    if (kind === "builtin") builtin += 1;
    else if (kind === "bossmode") bossmode += 1;
    else if (kind === "extension") extension += 1;
    else if (kind === "mcp") mcp += 1;
  }
  const parts = [`${tools.length} live`];
  if (bossmode) parts.push(`bossmode ${bossmode}`);
  if (builtin) parts.push(`built-in ${builtin}`);
  if (extension) parts.push(`extension ${extension}`);
  if (mcp) parts.push(`MCP ${mcp}`);
  return parts.join(" · ");
}

type ToolFilter = "all" | "builtin" | "bossmode" | "extension" | "mcp";

function toolSourceKind(source: string): ToolFilter {
  if (source === "builtin") return "builtin";
  if (source === "bossmode") return "bossmode";
  if (source === "mcp" || source.startsWith("mcp:")) return "mcp";
  if (source.startsWith("extension:")) return "extension";
  return "all";
}

function toolSourceLabel(source: string): string {
  if (source === "builtin") return "Builtin";
  if (source === "bossmode") return "Bossmode";
  if (source === "mcp") return "MCP";
  if (source.startsWith("mcp:")) return `MCP · ${source.slice(4)}`;
  if (source.startsWith("extension:")) {
    const id = source.slice("extension:".length);
    return id === "unknown" ? "Extension" : `Extension · ${id}`;
  }
  return source;
}

function toolBadgeClass(source: string): string {
  const kind = toolSourceKind(source);
  if (kind === "builtin") return "text-ink-3 border-line-strong";
  if (kind === "bossmode") return "text-accent-ink border-accent bg-accent-dim";
  if (kind === "extension") return "text-thinking border-thinking bg-thinking-dim";
  if (kind === "mcp") return "text-[#7aa2ff] border-[#7aa2ff] bg-[rgba(122,162,255,.12)]";
  return "text-ink-4 border-line";
}

function groupToolsBySource(tools: MemberActiveTool[]): Array<{ source: string; tools: MemberActiveTool[] }> {
  const order: string[] = [];
  const map = new Map<string, MemberActiveTool[]>();
  for (const t of tools) {
    if (!map.has(t.source)) {
      map.set(t.source, []);
      order.push(t.source);
    }
    map.get(t.source)!.push(t);
  }
  const rank = (s: string) => {
    if (s === "builtin") return 0;
    if (s === "bossmode") return 1;
    if (s.startsWith("extension:")) return 2;
    if (s === "mcp" || s.startsWith("mcp:")) return 3;
    return 4;
  };
  order.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return order.map((source) => ({ source, tools: map.get(source)! }));
}

function paramEntries(parameters: unknown): Array<{ name: string; type: string; required: boolean; description: string }> {
  if (!parameters || typeof parameters !== "object") return [];
  const schema = parameters as { properties?: Record<string, any>; required?: string[] };
  const props = schema.properties || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(props).map(([name, def]) => {
    const d = def && typeof def === "object" ? def : {};
    const type = typeof d.type === "string" ? d.type : Array.isArray(d.type) ? d.type.join("|") : "any";
    return {
      name,
      type,
      required: required.has(name),
      description: typeof d.description === "string" ? d.description : "",
    };
  });
}

export function ActiveToolsSection({ roomId, memberRef, status, reloadKey, dmScope }: {
  roomId: string;
  memberRef: string;
  status: string;
  reloadKey: number;
  dmScope?: { scopeId: string; memberId: string };
}) {
  const [loading, setLoading] = useState(true);
  const [sessionActive, setSessionActive] = useState(false);
  const [tools, setTools] = useState<MemberActiveTool[]>([]);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<ToolFilter>("all");
  const [query, setQuery] = useState("");
  const [openNames, setOpenNames] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      if (dmScope) {
        const data = await getConversationTools(dmScope.scopeId, dmScope.memberId);
        setSessionActive(!!data.live?.sessionActive);
        setTools(Array.isArray(data.live?.tools) ? data.live!.tools : []);
      } else {
        const data = await getMemberActiveTools(roomId, memberRef);
        setSessionActive(!!data.sessionActive);
        setTools(Array.isArray(data.tools) ? data.tools : []);
      }
    } catch {
      setError(true);
      setSessionActive(false);
      setTools([]);
    } finally {
      setLoading(false);
    }
  }, [roomId, memberRef, dmScope?.scopeId, dmScope?.memberId]);

  useEffect(() => { void load(); }, [load, reloadKey, status]);

  const filtered = tools.filter((t) => {
    if (filter !== "all" && toolSourceKind(t.source) !== filter) return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return t.name.toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q);
  });
  const groups = groupToolsBySource(filtered);
  const summary = activeToolsAccordionSummary(loading, error, sessionActive, tools);

  return (
    <SessionSectionAccordion
      title="Active tools"
      summary={summary}
      action={
        <button
          type="button"
          onClick={() => void load()}
          className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0 cursor-pointer"
        >
          Refresh
        </button>
      }
    >
      {loading ? (
        <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-3">Loading tools…</div>
      ) : error ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-xs text-blocked rounded border border-blocked/30 bg-blocked-dim/25 p-2">
          <span>Couldn’t load active tools.</span>
          <button type="button" onClick={() => void load()} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked/10 cursor-pointer">Retry</button>
        </div>
      ) : !sessionActive ? (
        <div className="rounded-lg border border-line-soft bg-surface-1 p-3 text-xs text-ink-4">No active session.</div>
      ) : tools.length === 0 ? (
        <div className="rounded-lg border border-line-soft bg-surface-1 p-3 text-xs text-ink-4">Session is active but no tools are enabled.</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {([
              ["all", "All"],
              ["builtin", "Builtin"],
              ["bossmode", "Bossmode"],
              ["extension", "Extensions"],
              ["mcp", "MCP"],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold cursor-pointer ${filter === key ? "border-accent bg-accent-dim text-accent-ink" : "border-line bg-surface-1 text-ink-3 hover:bg-surface-2"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools…"
            className="w-full rounded-lg border border-line bg-inset px-3 py-2 text-xs font-mono text-ink-1 outline-none focus:border-accent placeholder:text-ink-4 placeholder:font-sans"
          />
          {groups.length === 0 ? (
            <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">No tools match this filter.</div>
          ) : (
            <div className="space-y-3">
              {groups.map(({ source, tools: groupTools }) => (
                <div key={source}>
                  <div className="flex items-center gap-2 text-[10px] font-bold tracking-wide uppercase text-ink-4 mb-1.5">
                    <span>{toolSourceLabel(source)}</span>
                    <span className="font-semibold normal-case tracking-normal">· {groupTools.length}</span>
                    <span className="flex-1 h-px bg-line-soft" />
                  </div>
                  <div className="space-y-1.5">
                    {groupTools.map((tool) => {
                      const open = openNames.has(tool.name);
                      const params = paramEntries(tool.parameters);
                      return (
                        <div key={tool.name} className={`rounded-[10px] border bg-surface-1 overflow-hidden ${open ? "border-line-strong" : "border-line-soft"}`}>
                          <button
                            type="button"
                            onClick={() => setOpenNames((prev) => {
                              const next = new Set(prev);
                              if (next.has(tool.name)) next.delete(tool.name);
                              else next.add(tool.name);
                              return next;
                            })}
                            className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left cursor-pointer hover:bg-surface-2 border-0 bg-transparent text-inherit"
                          >
                            <span className={`text-[10px] text-ink-4 mt-1 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono text-[12.5px] font-bold text-ink-1">{tool.name}</span>
                                <span className={`text-[9px] font-bold uppercase tracking-wide border rounded-full px-1.5 py-px ${toolBadgeClass(tool.source)}`}>
                                  {toolSourceKind(tool.source)}
                                </span>
                              </div>
                              {tool.description && (
                                <div className="text-[11px] text-ink-3 mt-0.5 line-clamp-2 leading-snug">{tool.description}</div>
                              )}
                            </div>
                          </button>
                          {open && (
                            <div className="border-t border-line-soft px-3 py-2.5 bg-inset space-y-2">
                              {tool.description && (
                                <p className="text-[11.5px] text-ink-2 leading-relaxed m-0">{tool.description}</p>
                              )}
                              <div className="text-[9.5px] font-bold tracking-wide uppercase text-ink-4">Parameters</div>
                              {params.length === 0 ? (
                                <div className="text-[11px] text-ink-4">No parameters.</div>
                              ) : (
                                <div className="space-y-1.5">
                                  {params.map((p) => (
                                    <div key={p.name} className="rounded-lg border border-line-soft bg-surface-1 px-2.5 py-2">
                                      <div>
                                        <span className="font-mono text-[11.5px] font-bold text-ink-1">{p.name}</span>
                                        {p.required && <span className="text-blocked ml-1 text-[11px]">*</span>}
                                        <span className="font-mono text-[10px] text-ink-4 ml-1.5">{p.type}</span>
                                      </div>
                                      {p.description && <div className="text-[11px] text-ink-3 mt-0.5 leading-snug">{p.description}</div>}
                                    </div>
                                  ))}
                                </div>
                              )}
                              <div className="text-[10.5px] text-ink-4">source · {tool.source}</div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SessionSectionAccordion>
  );
}
