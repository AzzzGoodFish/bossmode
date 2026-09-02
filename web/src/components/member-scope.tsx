/**
 * member-scope.tsx — the merged member page's building blocks (member-page
 * merge v1, fish 2026-08-26: settings page + room Sheet become ONE page).
 *
 * Everything here moved VERBATIM from StationPanel.tsx's MemberConfigPanel
 * family (fusion, not repaint — fish 2026-08-26: blend into the existing UI) plus four
 * extractions that turn panel JSX into reusable sections:
 *   ExtensionsAccordion / McpToolsAccordion / ContextSessionCard.
 * StationPanel imports the shared utils back from here; nothing here imports
 * StationPanel (no cycle).
 *
 * Batch 5b (config globally unified): ScopeModelCard retired — there is no
 * per-scope model override anymore, the member's model lives in the float's
 * Settings tab as the single global select.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  getMemberActiveTools, getConversationTools,
  type AvailableModelOption, type ContextUsageData, type ExtensionRecord,
  type McpServerSummary, type MemberActiveTool, type MemberInfo,
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

export function isAssignableMcpServer(server: McpServerSummary): boolean {
  return server.transport !== "invalid" && server.availability?.status !== "invalid-config";
}

export function memberMcpDisplayState(
  loadStatus: "loading" | "ready" | "error",
  enabled: boolean,
  serverCount: number,
): "loading" | "error" | "disabled" | "empty" | "items" {
  if (loadStatus !== "ready") return loadStatus;
  if (!enabled) return "disabled";
  return serverCount === 0 ? "empty" : "items";
}

export function memberMcpStatusLabel(status?: string): string {
  switch (status) {
    case "available": return "Available";
    case "auth-required": return "Sign-in required";
    case "unavailable":
    case "invalid-config":
    case "invalid": return "Needs attention";
    default: return "Not checked";
  }
}

function availabilityTone(status?: string): string {
  if (status === "available") return "text-onair border-onair/30 bg-onair/10";
  if (status === "auth-required") return "text-think border-think/30 bg-think/10";
  if (status === "unavailable" || status === "invalid-config") return "text-blocked border-blocked/30 bg-blocked-dim/40";
  return "text-ink-4 border-line bg-surface-2";
}

// ── card primitives (verbatim from StationPanel) ────────────────────────────

export function AssetTag({ children, tone }: { children: string; tone?: "room" | "dm" }) {
  return (
    <span className={`text-[9.5px] font-bold uppercase tracking-wide border rounded-full px-2 py-0.5 shrink-0 ${tone === "dm" ? "border-line-soft bg-think-dim text-think" : "border-line-soft bg-surface-2 text-ink-4"}`}>
      {children}
    </span>
  );
}

/** First non-empty content line of an asset — skips markdown headings and
 * separator lines so the collapsed preview shows real content. */
function firstContentLine(content: string): string {
  const line = content.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^#{1,6}\s/.test(l) && !/^[-=]{3,}$/.test(l));
  return line ?? "";
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

function EmptyAsset({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mt-2.5 rounded-lg border border-dashed border-line px-4 py-4 text-center">
      <div className="text-[12.5px] font-semibold text-ink-3">{title}</div>
      <div className="text-xs text-ink-4 mt-0.5 leading-relaxed">{hint}</div>
    </div>
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

/** Real, compiled Bossmode Core prompt — sourced from the same compiler the
 * runtime uses; never a static/hardcoded preview. Compiled per scope, so this
 * card lives in scope views (a Global-defaults view has no session). */
// ── scope model card (extracted; adds the merge payoff: unified⇄scope link) ─

/** Model card for one scope. When the member's global config has Unified model
 * ON, the pickers lock and a banner says so — the relationship used to span
 * two pages and stayed invisible (member-page merge v1). */

// ── context & session (extracted verbatim layout from MemberConfigPanel) ────

export function ContextSessionCard({ contextUsage, onCompact, onResetSession, onRestart, dm }: {
  contextUsage?: ContextUsageData;
  onCompact: () => void;
  onResetSession: () => void;
  onRestart: () => void;
  dm: boolean;
}) {
  const hasUsage = contextUsage?.supported && contextUsage.percentage !== undefined;
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
        <details className="rounded-lg border border-line-soft bg-surface-1 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-3 hover:text-ink-1">Troubleshooting</summary>
          <div className="mt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-line-soft pt-2">
            <div className="text-[11px] text-ink-4 leading-relaxed">
              If the member is stuck, restart it.
            </div>
            <button onClick={onRestart} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0 cursor-pointer">Restart member</button>
          </div>
        </details>
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

function isExtensionEnabledForMember(ext: ExtensionRecord, enabledIds: string[]): boolean {
  return enabledIds.some((id) => id === ext.name || id === ext.id || id === `npm:${ext.name}` || ext.id.endsWith(id));
}

function extensionsAccordionSummary(
  status: "loading" | "ready" | "error",
  installed: ExtensionRecord[],
  enabledIds: string[],
): string {
  if (status === "loading") return "Loading…";
  if (status === "error") return "Couldn’t load";
  if (installed.length === 0) return "None installed";
  const enabled = installed.filter((ext) => isExtensionEnabledForMember(ext, enabledIds));
  const names = enabled.map((e) => e.name).slice(0, 3).join(", ");
  const base = `${enabled.length} of ${installed.length} enabled`;
  return names ? `${base} · ${names}` : base;
}

function mcpAccordionSummary(
  displayState: ReturnType<typeof memberMcpDisplayState>,
  servers: McpServerSummary[],
  enabledNames: string[],
): string {
  if (displayState === "loading") return "Loading…";
  if (displayState === "error") return "Couldn’t load";
  if (displayState === "disabled") return "MCP turned off";
  if (displayState === "empty") return "None configured";
  const on = servers.filter((s) => enabledNames.includes(s.name));
  const names = on.map((s) => s.name).slice(0, 3).join(", ");
  const base = `${on.length} of ${servers.length} MCP servers on`;
  return names ? `${base} · ${names}` : base;
}

/** Extensions accordion (per-scope enablement) — content verbatim from the
 * old MemberConfigPanel. */
export function ExtensionsAccordion({ installedExtensions, extensionsLoadStatus, onRetryExtensions, memberExtensions, onToggleExtension, onOpenExtensionsSettings }: {
  installedExtensions: ExtensionRecord[];
  extensionsLoadStatus: "loading" | "ready" | "error";
  onRetryExtensions: () => void;
  memberExtensions: string[];
  onToggleExtension: (extName: string) => void;
  onOpenExtensionsSettings?: () => void;
}) {
  return (
    <SessionSectionAccordion
      title="Extensions"
      summary={extensionsAccordionSummary(extensionsLoadStatus, installedExtensions, memberExtensions)}
      action={
        <button type="button" onClick={() => onOpenExtensionsSettings?.()} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0 cursor-pointer">Install…</button>
      }
    >
      {extensionsLoadStatus === "loading" ? (
        <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">Loading extensions…</div>
      ) : extensionsLoadStatus === "error" ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-xs text-blocked rounded border border-blocked/30 bg-blocked-dim/25 p-2">
          <span>Couldn’t load extensions.</span>
          <button type="button" onClick={onRetryExtensions} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked/10 cursor-pointer">Retry</button>
        </div>
      ) : installedExtensions.length === 0 ? (
        <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">
          No extensions installed yet. Install one in Settings → Extensions, then enable it here.
        </div>
      ) : (
        <div className="space-y-2">
          {installedExtensions.map((ext) => {
            const checked = isExtensionEnabledForMember(ext, memberExtensions);
            return (
              <div key={ext.id} className={`rounded-lg border p-3 flex items-center gap-3 ${checked ? "border-accent/40 bg-accent-dim/40" : "border-line-soft bg-surface-1"}`}>
                <div className="w-9 h-9 rounded-lg bg-surface-2 flex items-center justify-center text-xs font-bold text-accent-ink shrink-0">⧉</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-ink-1 truncate font-mono">{ext.name}</span>
                    <span className={`text-[10px] border rounded px-1.5 py-0.5 ${checked ? "border-accent/40 text-accent-ink bg-accent-dim" : "border-line-soft text-ink-4"}`}>
                      {checked ? "ENABLED" : "OFF"}
                    </span>
                    {ext.version && <span className="text-[10px] text-ink-4 font-mono">{ext.version}</span>}
                  </div>
                  <div className="text-[11px] text-ink-4 mt-1 truncate">
                    {ext.description || `${ext.extensionPaths.length} tools entry · ${ext.skillPaths.length} skills`}
                    {checked ? " · enabled for this member" : " · off for this member"}
                  </div>
                  {ext.error && <div className="text-[11px] text-blocked mt-1">{ext.error}</div>}
                </div>
                <ToggleSwitch
                  on={checked}
                  onToggle={() => onToggleExtension(ext.name)}
                  label={`${ext.name} for this member`}
                  title={checked ? "Disable for this member" : "Enable for this member"}
                />
              </div>
            );
          })}
        </div>
      )}
    </SessionSectionAccordion>
  );
}

/** MCP tools accordion (per-scope server access) — content verbatim from the
 * old MemberConfigPanel. */
export function McpToolsAccordion({ mcpEnabled, mcpServers, mcpLoadStatus, onRetryMcp, memberMcpServers, onToggleMcp, onOpenMcpSettings }: {
  mcpEnabled: boolean;
  mcpServers: McpServerSummary[];
  mcpLoadStatus: "loading" | "ready" | "error";
  onRetryMcp: () => void;
  memberMcpServers: string[];
  onToggleMcp: (serverName: string) => void;
  onOpenMcpSettings: () => void;
}) {
  const mcpDisplayState = memberMcpDisplayState(mcpLoadStatus, mcpEnabled, mcpServers.length);
  return (
    <SessionSectionAccordion
      title="MCP Servers"
      summary={mcpAccordionSummary(mcpDisplayState, mcpServers, memberMcpServers)}
      action={
        <button type="button" onClick={onOpenMcpSettings} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0 cursor-pointer">Manage servers</button>
      }
    >
      {mcpDisplayState === "loading" ? (
        <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">Loading MCP servers…</div>
      ) : mcpDisplayState === "error" ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-xs text-blocked rounded border border-blocked/30 bg-blocked-dim/25 p-2">
          <span>Couldn’t load MCP servers.</span>
          <button type="button" onClick={onRetryMcp} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked/10 cursor-pointer">Retry</button>
        </div>
      ) : mcpDisplayState === "disabled" ? (
        <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">MCP servers are turned off. Turn them on in Settings → Integrations.</div>
      ) : mcpDisplayState === "empty" ? (
        <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">No MCP servers configured. Add one in Settings → Integrations.</div>
      ) : <div className="space-y-2">
        {mcpServers.map((server) => {
          const checked = memberMcpServers.includes(server.name);
          const availability = server.availability;
          const statusValue = availability?.status || "unchecked";
          const invalid = server.transport === "invalid" || statusValue === "invalid-config";
          const unavailable = statusValue === "unavailable" || statusValue === "auth-required";
          const disabled = !mcpEnabled || (!checked && (invalid || unavailable));
          return (
            <div key={server.name} className={`rounded-lg border p-3 flex items-center gap-3 ${checked ? "border-accent/40 bg-accent-dim/40" : "border-line-soft bg-surface-1"}`}>
              <div className="w-9 h-9 rounded-lg bg-surface-2 flex items-center justify-center text-xs font-bold text-accent-ink uppercase shrink-0">{server.name.slice(0, 2)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-ink-1 truncate">{server.name}</span>
                  <span className={`text-[10px] border rounded px-1.5 py-0.5 ${availabilityTone(statusValue)}`}>{memberMcpStatusLabel(statusValue)}</span>
                </div>
                <div className="text-[11px] text-ink-4 mt-1 truncate">
                  {availability?.toolCount !== undefined ? `${availability.toolCount} tools` : "Tool count unknown"}{checked ? " · enabled for this member" : " · off for this member"}
                </div>
                {availability?.error && <div className="text-[11px] text-blocked mt-1">Connection unavailable. Check this server in Settings → Integrations.</div>}
              </div>
              <ToggleSwitch
                on={checked}
                onToggle={() => onToggleMcp(server.name)}
                label={`${server.name} for this member`}
                disabled={disabled}
                title={invalid ? "This server needs attention in Settings" : unavailable ? "This server is not currently available" : checked ? "Disable for this member" : "Enable for this member"}
              />
            </div>
          );
        })}
      </div>}
    </SessionSectionAccordion>
  );
}

// ── Active tools (verbatim from StationPanel) ───────────────────────────────

function activeToolsAccordionSummary(
  loading: boolean,
  error: boolean,
  sessionActive: boolean,
  tools: MemberActiveTool[],
  message?: string,
): string {
  if (loading) return "Loading…";
  if (error) return "Couldn’t load";
  if (!sessionActive) return message || "No active session";
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
  const [message, setMessage] = useState<string | undefined>();
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
        setMessage(data.live?.message);
      } else {
        const data = await getMemberActiveTools(roomId, memberRef);
        setSessionActive(!!data.sessionActive);
        setTools(Array.isArray(data.tools) ? data.tools : []);
        setMessage(data.message);
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
  const summary = activeToolsAccordionSummary(loading, error, sessionActive, tools, message);

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
        <div className="rounded-lg border border-line-soft bg-surface-1 p-3 text-xs text-ink-4 leading-relaxed space-y-1">
          <div className="font-semibold text-ink-2">No active session.</div>
          <div>{message || "Start or Reload this member to see active tools."}</div>
          <div className="text-ink-4">Tools are read from the running session — we don’t guess from config.</div>
        </div>
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
