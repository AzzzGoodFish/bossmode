import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Square, ChevronDown } from "lucide-react";
import {
  abortAgent, getRoomMembers, getConfiguredModels, updateRoomMember, getAgentEventsPaginated, getToken, getMcpSettings, restartMember, resetAgentSession, steerAgent, reloadMemberResources,
  getRoomPromptSupplement, getMemberPromptSupplement,
  type MemberInfo, type AvailableModelOption, type ContextUsageData, type McpServerSummary, type PromptSupplement,
} from "../api/client";
import { Sheet } from "./Sheet";
import { Markdown } from "./Markdown";
import { compactionEndDetail, compactionReasonLabel, formatEventTime, isStationActionEvent, summarizeAgentEvent, toolDisplay, toolTarget, truncateText, type AgentEvent } from "./agent-event-utils";
import type { AgentStatusMap } from "../hooks/useRoom";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { ModelPicker, modelProfileLabel } from "./ModelPicker";
import { useDialog } from "./dialogs";

interface StationPanelProps {
  members: string[];
  agentStatus: AgentStatusMap;
  contextUsage: Record<string, ContextUsageData>;
  roomId: string;
  onOpenLens?: (agentName: string) => void;
  onOpenMcpSettings?: () => void;
  onMembersChanged?: () => void;
  unreadAgents?: Set<string> | null;
}

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

function statusLabel(status: string): string {
  switch (status) {
    case "working": return "WORKING";
    case "thinking": return "THINKING";
    case "idle": return "IDLE";
    case "off": return "OFF";
    default: return "OFFLINE";
  }
}

function displayAgentLabel(agentName: string): string {
  if (!agentName) return "Agent";
  const normalized = agentName.trim();
  const upper = normalized.toUpperCase();
  if (["QA", "PM"].includes(upper)) return upper;
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const acronym = part.toUpperCase();
      if (["QA", "PM"].includes(acronym)) return acronym;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function thinkLevelTextClass(level?: string | null): string {
  switch (level || "default") {
    case "minimal": return "think-level-minimal";
    case "low": return "think-level-low";
    case "medium": return "think-level-medium";
    case "high": return "think-level-high";
    case "xhigh": return "think-level-xhigh";
    case "max": return "think-level-max";
    case "off":
    case "default":
    default:
      return "think-level-default";
  }
}

function isAssignableMcpServer(server: McpServerSummary): boolean {
  return server.transport !== "invalid" && server.availability?.status !== "invalid-config";
}

/** Room member stations with status, model controls, context usage, and actions. */
export function StationPanel({ members, agentStatus, contextUsage, roomId, onOpenLens, onOpenMcpSettings, onMembersChanged, unreadAgents }: StationPanelProps) {
  const { toast, confirm } = useDialog();
  const [memberInfos, setMemberInfos] = useState<Record<string, MemberInfo>>({});
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [chipAnchor, setChipAnchor] = useState<DOMRect | null>(null);
  const [openThinkingChip, setOpenThinkingChip] = useState<string | null>(null);
  const [thinkingAnchor, setThinkingAnchor] = useState<DOMRect | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [recentEvents, setRecentEvents] = useState<Record<string, AgentEvent[]>>({});
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpLoadStatus, setMcpLoadStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    getRoomMembers(roomId)
      .then((all) => {
        const map: Record<string, MemberInfo> = {};
        for (const m of all) map[m.name] = m;
        setMemberInfos(map);
      })
      .catch(console.error);
  }, [members, roomId]);

  useEffect(() => {
    getConfiguredModels().then(setModels).catch(console.error);
  }, []);

  const refreshMcpSettings = useCallback(async () => {
    setMcpLoadStatus("loading");
    try {
      const settings = await getMcpSettings();
      setMcpEnabled(settings.enabled);
      setMcpServers(settings.servers || []);
      setMcpLoadStatus("ready");
    } catch (err) {
      console.error("Failed to load MCP settings:", err);
      setMcpLoadStatus("error");
    }
  }, []);

  useEffect(() => { void refreshMcpSettings(); }, [refreshMcpSettings]);

  // Close the model picker when clicking outside it.
  useEffect(() => {
    if (!openChip) return;
    const close = () => { setOpenChip(null); setChipAnchor(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openChip]);

  const handleSwitchModel = useCallback(
    async (member: MemberInfo, model: string | null, credentialId: string | null) => {
      setOpenChip(null);
      try {
        const updated = await updateRoomMember(roomId, member.id, { model, credentialId });
        setMemberInfos((prev) => ({ ...prev, [member.name]: updated }));
        toast(`${member.name} model updated. It applies on the next turn.`, "success");
      } catch (err) {
        console.error("Failed to update member model", err);
        toast("Couldn’t update the model. Check the connection in Settings → Models, then try again.", "error");
      }
    },
    [roomId, toast],
  );

  const handleSwitchThinking = useCallback(async (member: MemberInfo, thinkingLevel: string | null) => {
    try {
      const updated = await updateRoomMember(roomId, member.id, { thinkingLevel });
      setMemberInfos((prev) => ({ ...prev, [member.name]: updated }));
      toast(`${member.name} thinking → ${thinkingLevel ?? "default"}`, "success");
    } catch (err) {
      console.error("Failed to update thinking level", err);
      toast("Couldn’t update the thinking level. Try again.", "error");
    }
  }, [roomId, toast]);

  const handleRestartMember = useCallback(async (member: MemberInfo) => {
    try {
      await restartMember(member.id || member.name, roomId);
      toast(`${member.name} restarted`, "success");
    } catch (err) {
      console.error("Failed to restart member", err);
      toast("Couldn’t restart this member. Try again, or check Runtime settings.", "error");
    }
  }, [roomId, toast]);

  const handleCompactMember = useCallback(async (member: MemberInfo) => {
    try {
      await steerAgent(roomId, member.id || member.name, "/compact");
      toast(`Compact started for ${member.name}`, "success");
    } catch (err) {
      console.error("Failed to compact member context", err);
      toast("Couldn’t compact this conversation. Try again.", "error");
    }
  }, [roomId, toast]);

  const handleReloadMember = useCallback(async (member: MemberInfo) => {
    try {
      const result = await reloadMemberResources(roomId, member.id || member.name);
      toast(result.message || `${member.name} reloaded`, result.reloaded ? "success" : "info");
    } catch (err) {
      console.error("Failed to reload member", err);
      toast("Couldn’t apply the latest changes. Try again; restart the member if the problem continues.", "error");
    }
  }, [roomId, toast]);

  const handleResetSession = useCallback(async (member: MemberInfo) => {
    const ok = await confirm(`Reset session for @${member.name}?

This clears the member's working session memory and starts fresh. Room messages and activity history stay visible.`);
    if (!ok) return;
    try {
      await resetAgentSession(roomId, member.id);
      toast(`${member.name} session reset`, "success");
    } catch (err) {
      console.error("Failed to reset member session", err);
      toast("Couldn’t reset this session. Try again.", "error");
    }
  }, [confirm, roomId, toast]);

  const handleRenameMember = useCallback(async (member: MemberInfo, name: string) => {
    try {
      const updated = await updateRoomMember(roomId, member.id, { name });
      setMemberInfos((prev) => {
        const next = { ...prev };
        delete next[member.name];
        next[updated.name] = updated;
        return next;
      });
      setSelectedMember(updated.name);
      await onMembersChanged?.();
      toast(`Member renamed: ${member.name} → ${updated.name}`, "success");
    } catch (err) {
      console.error("Failed to rename member", err);
      toast("Couldn’t rename this member. Check that the name is unique, then try again.", "error");
      throw err;
    }
  }, [onMembersChanged, roomId, toast]);

  const loadRecentEvents = useCallback(async (name: string) => {
    try {
      const result = await getAgentEventsPaginated(roomId, name, 40);
      const stationEvents = coalesceStationActivity(result.events as AgentEvent[]).slice(-8);
      setRecentEvents((prev) => ({ ...prev, [name]: stationEvents }));
    } catch (err) {
      console.error("Failed to load recent agent events:", err);
    }
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    for (const name of members) void loadRecentEvents(name);
  }, [roomId, members.join("\u0000"), loadRecentEvents]);

  useEffect(() => {
    const token = getToken();
    if (!token || !roomId || members.length === 0) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}?token=${token}`);
    ws.onopen = () => {
      for (const name of members) ws.send(JSON.stringify({ type: "subscribe:agent", roomId, agent: name }));
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== "agent:event" || data.roomId !== roomId || !members.includes(data.agent)) return;
        const event = data.event as AgentEvent;
        if (!isStationDisplayEvent(event)) return;
        setRecentEvents((prev) => ({ ...prev, [data.agent]: coalesceStationActivity([...(prev[data.agent] || []), event]).slice(-8) }));
      } catch {}
    };
    return () => ws.close();
  }, [roomId, members.join("\u0000")]);

  const toggleMemberMcpServer = useCallback(async (member: MemberInfo, server: string) => {
    const current = new Set(member.mcpServers || []);
    if (current.has(server)) current.delete(server); else current.add(server);
    const assignableNames = new Set(mcpServers.filter(isAssignableMcpServer).map((s) => s.name));
    const nextServers = mcpServers.map((s) => s.name).filter((name) => current.has(name) && assignableNames.has(name));
    try {
      const updated = await updateRoomMember(roomId, member.id, { mcpServers: nextServers });
      setMemberInfos((prev) => ({ ...prev, [member.name]: updated }));
      await refreshMcpSettings();
      toast(`${member.name} tool access saved. Restart the member to apply it.`, "success");
    } catch (err) {
      console.error("Failed to save member MCP access", err);
      toast("Couldn’t save tool access. Check the server in Settings → Integrations, then try again.", "error");
    }
  }, [mcpServers, refreshMcpSettings, roomId, toast]);

  const workingCount = members.filter((m) => agentStatus[m] === "working").length;

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <div className="h-10 px-3.5 border-b border-line-soft flex items-center justify-between shrink-0">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-4">WORKSTATIONS</span>
        <span className="font-mono text-[10.5px] text-ink-4">
          <span className="text-onair">{workingCount}</span> / {members.length} on duty
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0" onScroll={() => { setOpenChip(null); setChipAnchor(null); setOpenThinkingChip(null); setThinkingAnchor(null); }}>
        {members.map((name) => {
          const status = agentStatus[name] || "inactive";
          const info = memberInfos[name];
          const usage = contextUsage[name];
          const hasUsage = usage?.supported && usage.percentage !== undefined;
          const pct = hasUsage ? Math.round(usage.percentage!) : 0;
          const isBusy = status === "working";
          const hasUnread = unreadAgents?.has(name);
          const agentLabel = displayAgentLabel(info?.agent || info?.sourceAgent || name);
          const modelRef = info?.model || "";
          const modelLabel = compactModelId(modelRef, models);
          const isConfigured = !!info?.model && !!info?.credentialId;
          const modelWarning = isConfigured ? memberModelAvailabilityLabel(info?.model, info?.credentialId, models) : null;
          const modelAvailable = isConfigured && modelWarning === null;
          const modelChipLabel = !isConfigured ? (models.length === 0 ? "No model connected" : "Select model") : modelAvailable ? modelLabel : modelWarning!;
          const modelChipTitle = !isConfigured
            ? "Choose a model and credential for this member"
            : modelAvailable
              ? `${modelRef} · This room only`
              : (models.length === 0 ? "Connect a provider in Settings → Models" : `${modelRef} is unavailable`);

          return (
            <div key={name} className="relative border-b border-line-soft px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setSelectedMember(name)}
                  className="cursor-pointer rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  title={`Configure ${name} · ${statusLabel(status)}`}
                >
                  <StaffBadge name={name} avatar={info ? undefined : undefined} status={statusFromAgent(status)} size="md" />
                </button>
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => setSelectedMember(name)}
                    className="text-[12.5px] font-semibold text-ink-1 truncate flex items-center gap-1.5 cursor-pointer hover:text-accent-ink transition-colors max-w-full"
                    title={`Configure ${name}`}
                  >
                    <span className="truncate">{name}</span>
                    {hasUnread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                  </button>
                  {/* member name is primary; Agent identity is a weak hint, then room-local runtime chips */}
                  <div className="relative flex items-center gap-1 min-w-0 max-w-full">
                    <span className="text-[10px] text-ink-4 truncate shrink-0 max-w-[92px]" title={`Agent: ${agentLabel}`}>{agentLabel}</span>
                    {info && <span className="font-mono text-[10px] text-ink-4 shrink-0">·</span>}
                    {info && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenThinkingChip(null);
                          setThinkingAnchor(null);
                          if (openChip === name) {
                            setOpenChip(null);
                            setChipAnchor(null);
                          } else {
                            setOpenChip(name);
                            setChipAnchor(e.currentTarget.getBoundingClientRect());
                          }
                        }}
                        title={modelChipTitle}
                        className={`font-mono text-[10px] rounded px-1 py-px flex-1 cursor-pointer transition-colors min-w-0 truncate text-left hover:bg-accent-dim ${
                          !isConfigured || !modelAvailable ? "text-think" : "text-ink-4 hover:text-accent-ink"
                        }`}
                      >
                        {modelChipLabel}
                      </button>
                    )}
                    {info && <span className="font-mono text-[10px] text-ink-4 shrink-0">·</span>}
                    {info && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenChip(null);
                          setChipAnchor(null);
                          if (openThinkingChip === name) {
                            setOpenThinkingChip(null);
                            setThinkingAnchor(null);
                          } else {
                            setOpenThinkingChip(name);
                            setThinkingAnchor(e.currentTarget.getBoundingClientRect());
                          }
                        }}
                        title={`think · ${info.thinkingLevel || "off"} · This room only`}
                        className={`font-mono text-[10px] hover:text-accent-ink hover:bg-accent-dim rounded px-1 py-px cursor-pointer transition-colors shrink-0 ${info.thinkingLevel ? "text-ink-3" : "text-ink-4"}`}
                      >
                        think <span className={`font-semibold ${thinkLevelTextClass(info.thinkingLevel || "default")}`}>{info.thinkingLevel || "default"}</span>
                      </button>
                    )}
                    {openChip === name && info && (
                      <ModelPop
                        anchorRect={chipAnchor}
                        models={models}
                        current={{ model: info.model ?? null, credentialId: info.credentialId ?? null }}
                        onClose={() => { setOpenChip(null); setChipAnchor(null); }}
                        onSelect={(model, credentialId) => {
                          setOpenChip(null);
                          setChipAnchor(null);
                          handleSwitchModel(info, model, credentialId);
                        }}
                      />
                    )}
                    {openThinkingChip === name && info && (
                      <ThinkingPop
                        anchorRect={thinkingAnchor}
                        currentThinking={info.thinkingLevel || "off"}
                        models={models}
                        modelRef={info.model ?? null}
                        credentialId={info.credentialId ?? null}
                        onClose={() => { setOpenThinkingChip(null); setThinkingAnchor(null); }}
                        onSelect={(thinkingLevel) => {
                          setOpenThinkingChip(null);
                          setThinkingAnchor(null);
                          void handleSwitchThinking(info, thinkingLevel);
                        }}
                      />
                    )}
                  </div>
                </div>
              </div>
              {isBusy && (
                <button
                  onClick={() => abortAgent(roomId, name).catch(console.error)}
                  className="absolute right-3.5 top-3.5 w-5 h-5 flex items-center justify-center rounded text-ink-4 hover:text-blocked hover:bg-surface-2 transition-colors cursor-pointer"
                  title={`Abort ${name}`}
                >
                  <Square size={9} fill="currentColor" />
                </button>
              )}

              <ActionLine
                name={name}
                status={status}
                events={recentEvents[name] || []}
                expanded={expandedAgent === name}
                onToggle={() => setExpandedAgent(expandedAgent === name ? null : name)}
              />
              {expandedAgent === name && (
                <div className="mt-2.5 border-l-2 border-accent bg-surface-1 rounded-r-lg p-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[9px] font-semibold tracking-[0.08em] text-ink-4">RECENT ACTIVITY</span>
                  </div>
                  {(recentEvents[name] || []).slice(-5).reverse().map((event, idx) => <MiniEvent key={`${event.ts || idx}:${event.type}:${idx}`} event={event} events={recentEvents[name] || []} />)}
                  {(recentEvents[name] || []).length === 0 && <div className="text-[11px] text-ink-4 py-1">No recent activity</div>}
                </div>
              )}

              {/* Context usage gauge */}
              <div className="flex items-center gap-2 mt-2.5">
                <div className="flex-1 h-[3px] rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      pct >= 95 ? "bg-blocked" : pct >= 85 ? "bg-think" : "bg-ink-3"
                    } ${isBusy ? "animate-pulse motion-reduce:animate-none" : ""}`}
                    style={{ width: `${Math.max(pct, hasUsage ? 2 : 0)}%` }}
                    role="progressbar"
                    aria-valuenow={pct}
                    aria-valuemax={100}
                    aria-label={`${name} context usage ${pct}%`}
                  />
                </div>
                <span className="font-mono text-[10px] text-ink-4 whitespace-nowrap shrink-0">
                  {hasUsage ? `${pct}% · ${formatTokens(usage.totalTokens!)}` : "—"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <Sheet open={!!selectedMember} onClose={() => setSelectedMember(null)} size="2xl">
        {selectedMember && memberInfos[selectedMember] && (
          <MemberConfigPanel
            roomId={roomId}
            member={memberInfos[selectedMember]}
            status={agentStatus[selectedMember] || "inactive"}
            contextUsage={contextUsage[selectedMember]}
            existingMemberNames={members}
            models={models}
            mcpEnabled={mcpEnabled}
            mcpServers={mcpServers}
            mcpLoadStatus={mcpLoadStatus}
            onRetryMcp={refreshMcpSettings}
            onOpenWorkstation={() => { onOpenLens?.(selectedMember); setSelectedMember(null); }}
            onOpenMcpSettings={() => { onOpenMcpSettings?.(); setSelectedMember(null); }}
            onRename={(name) => handleRenameMember(memberInfos[selectedMember], name)}
            onSwitchModel={(model, credentialId) => handleSwitchModel(memberInfos[selectedMember], model, credentialId)}
            onSwitchThinking={(thinkingLevel) => handleSwitchThinking(memberInfos[selectedMember], thinkingLevel)}
            onCompact={() => handleCompactMember(memberInfos[selectedMember])}
            onReload={() => handleReloadMember(memberInfos[selectedMember])}
            onRestart={() => handleRestartMember(memberInfos[selectedMember])}
            onResetSession={() => handleResetSession(memberInfos[selectedMember])}
            onToggleMcp={(server) => toggleMemberMcpServer(memberInfos[selectedMember], server)}
          />
        )}
      </Sheet>
    </div>
  );
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

function PromptSupplementPreview({ title, supplement, empty }: { title: string; supplement: PromptSupplement | null; empty: string }) {
  const content = supplement?.content?.trim() || "";
  return (
    <div>
      <div className="text-[11px] text-ink-4 uppercase tracking-wide mb-1.5">{title}</div>
      <div className="rounded-lg border border-line-soft bg-surface-1 p-3 min-h-24 max-h-[38vh] overflow-auto">
        {supplement === null ? (
          <div className="text-xs text-ink-4">Loading…</div>
        ) : content ? (
          <div className="text-[13px] text-ink-1 leading-relaxed preview-markdown"><Markdown content={content} /></div>
        ) : (
          <div className="text-xs text-ink-4 leading-relaxed">{empty}</div>
        )}
      </div>
    </div>
  );
}

function MemberConfigPanel({
  roomId,
  member,
  status,
  contextUsage,
  existingMemberNames,
  models,
  mcpEnabled,
  mcpServers,
  mcpLoadStatus,
  onRetryMcp,
  onOpenWorkstation,
  onOpenMcpSettings,
  onRename,
  onSwitchModel,
  onSwitchThinking,
  onCompact,
  onReload,
  onRestart,
  onResetSession,
  onToggleMcp,
}: {
  roomId: string;
  member: MemberInfo;
  status: string;
  contextUsage?: ContextUsageData;
  existingMemberNames: string[];
  models: AvailableModelOption[];
  mcpEnabled: boolean;
  mcpServers: McpServerSummary[];
  mcpLoadStatus: "loading" | "ready" | "error";
  onRetryMcp: () => void;
  onOpenWorkstation: () => void;
  onOpenMcpSettings: () => void;
  onRename: (name: string) => Promise<void>;
  onSwitchModel: (model: string | null, credentialId: string | null) => void;
  onSwitchThinking: (thinkingLevel: string | null) => void;
  onCompact: () => void;
  onReload: () => void;
  onRestart: () => void;
  onResetSession: () => void;
  onToggleMcp: (server: string) => void;
}) {
  const hasUsage = contextUsage?.supported && contextUsage.percentage !== undefined;
  const pct = hasUsage ? Math.round(contextUsage.percentage!) : 0;
  const statusText = statusLabel(status).toLowerCase();
  const mcpDisplayState = memberMcpDisplayState(mcpLoadStatus, mcpEnabled, mcpServers.length);
  const [draftName, setDraftName] = useState(member.name);
  const [savingName, setSavingName] = useState(false);
  const [roomSupplement, setRoomSupplement] = useState<PromptSupplement | null>(null);
  const [memberSupplement, setMemberSupplement] = useState<PromptSupplement | null>(null);

  useEffect(() => { setDraftName(member.name); }, [member.id, member.name]);

  useEffect(() => {
    let cancelled = false;
    setRoomSupplement(null);
    setMemberSupplement(null);
    Promise.all([
      getRoomPromptSupplement(roomId),
      getMemberPromptSupplement(roomId, member.id || member.name),
    ]).then(([roomPrompt, memberPrompt]) => {
      if (cancelled) return;
      setRoomSupplement(roomPrompt);
      setMemberSupplement(memberPrompt);
    }).catch(() => {
      if (cancelled) return;
      setRoomSupplement({ content: "", revision: 0, contentHash: "", contentLength: 0 });
      setMemberSupplement({ content: "", revision: 0, contentHash: "", contentLength: 0 });
    });
    return () => { cancelled = true; };
  }, [roomId, member.id, member.name]);

  const draftNameTrimmed = draftName.trim();
  const nameConflict = !!draftNameTrimmed && draftNameTrimmed.toLowerCase() !== member.name.toLowerCase() && existingMemberNames.some((name) => name.toLowerCase() === draftNameTrimmed.toLowerCase());
  const canSaveName = draftNameTrimmed && draftNameTrimmed !== member.name && !nameConflict && !savingName;
  const saveName = async () => {
    if (!canSaveName) return;
    setSavingName(true);
    try {
      await onRename(draftName.trim());
    } finally {
      setSavingName(false);
    }
  };

  return (
    <div className="p-5 space-y-4">
      <header className="flex items-start justify-between gap-4 pb-1">
        <div className="flex items-center gap-3 min-w-0">
          <StaffBadge name={member.name} status={statusFromAgent(status)} size="lg" />
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="text-lg font-semibold text-ink-1 truncate">{member.name}</div>
              <span className={`text-[10px] border rounded-full px-2 py-0.5 uppercase ${status === "working" ? "text-onair border-onair/30 bg-onair/10" : "text-ink-4 border-line bg-surface-2"}`}>{statusText}</span>
            </div>
            <div className="text-xs text-ink-4 font-mono mt-1">@{member.name} · {displayAgentLabel(member.agent || member.sourceAgent || member.name)}</div>
          </div>
        </div>
        <button onClick={onOpenWorkstation} className="px-3 py-1.5 border border-line rounded-lg text-sm text-ink-2 hover:bg-surface-2 shrink-0">View session detail</button>
      </header>

      <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
        <div>
          <div className="text-sm font-semibold text-ink-1">Profile</div>
          <div className="text-xs text-ink-4 mt-0.5">Member name is used for @ mentions in this Room.</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="rounded-lg border border-line-soft bg-surface-1 p-3 space-y-2">
            <div className="text-[11px] text-ink-4 uppercase tracking-wide">Member name</div>
            <div className="flex gap-2">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void saveName(); }}
                className="min-w-0 flex-1 bg-surface-3 border border-line rounded px-2 py-1.5 font-mono text-sm text-ink-1 focus:outline-none focus:border-line-strong"
                placeholder="member-name"
                disabled={status === "working" || savingName}
              />
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={!canSaveName || status === "working"}
                className="px-3 py-1.5 rounded border border-line text-xs text-ink-2 hover:bg-surface-2 disabled:opacity-50"
              >
                {savingName ? "Saving…" : "Save"}
              </button>
            </div>
            {nameConflict ? (
              <div className="text-[11px] text-blocked">This room already has a member named {draftNameTrimmed}. Pick another name.</div>
            ) : (
              <div className="text-[11px] text-ink-4">Mention as <span className="font-mono">@{member.name}</span>{status === "working" ? " · rename disabled while working" : ""}</div>
            )}
          </label>
          <div className="rounded-lg border border-line-soft bg-surface-1 p-3">
            <div className="text-[11px] text-ink-4 uppercase tracking-wide">Agent</div>
            <div className="font-mono text-sm text-ink-1 mt-1">{displayAgentLabel(member.agent || member.sourceAgent || member.name)}</div>

          </div>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-inset/50 p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ink-1">Model config</div>
            <div className="text-xs text-ink-4 mt-0.5">Choose this member’s model and thinking level for this Room. Changes apply on the next turn.</div>
          </div>
          <span className="text-[10px] text-ink-4 border border-line-soft rounded-full px-2 py-0.5 shrink-0">room only</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_170px] gap-2.5 items-start">
          <label className="block space-y-1.5 min-w-0">
            <span className="text-[11px] font-medium text-ink-3">Model / credential</span>
            <ModelPicker
              value={{ model: member.model ?? null, credentialId: member.credentialId ?? null }}
              models={models}
              onChange={(value) => onSwitchModel(value.model, value.credentialId)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[11px] font-medium text-ink-3">Think level</span>
            <select
              value={member.thinkingLevel || "off"}
              onChange={(e) => onSwitchThinking(e.target.value === "off" ? null : e.target.value)}
              className="w-full bg-surface-3 border border-line rounded px-2.5 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
            >
              {(() => {
                const boundModel = findModelOptionForBinding(member.model, member.credentialId, models);
                const options = availableThinkingLevels(boundModel).filter((l) => l.value !== null).map((l) => l.value as string);
                const current = member.thinkingLevel || "off";
                const all = options.includes(current) ? options : [current, ...options];
                return all.map((level) => <option key={level} value={level}>{level}</option>);
              })()}
            </select>
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ink-1">Tools</div>
            <div className="text-xs text-ink-4 mt-0.5">Assign MCP servers to this member in this room. Use Reload after changing tools.</div>
          </div>
          <button onClick={onOpenMcpSettings} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0">Manage servers</button>
        </div>
        {mcpDisplayState === "loading" ? (
          <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">Loading MCP servers…</div>
        ) : mcpDisplayState === "error" ? (
          <div role="alert" className="flex items-center justify-between gap-3 text-xs text-blocked rounded border border-blocked/30 bg-blocked-dim/25 p-2">
            <span>Couldn’t load MCP servers.</span>
            <button type="button" onClick={onRetryMcp} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked/10">Retry</button>
          </div>
        ) : mcpDisplayState === "disabled" ? (
          <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">MCP servers are turned off. Turn them on in Settings → Integrations.</div>
        ) : mcpDisplayState === "empty" ? (
          <div className="text-xs text-ink-4 rounded border border-line-soft bg-surface-1 p-2">No MCP servers configured. Add one in Settings → Integrations.</div>
        ) : <div className="space-y-2">
          {mcpServers.map((server) => {
            const checked = (member.mcpServers || []).includes(server.name);
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
                <button
                  type="button"
                  onClick={() => onToggleMcp(server.name)}
                  disabled={disabled}
                  className={`relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${checked ? "bg-accent" : "bg-surface-3"}`}
                  title={invalid ? "This server needs attention in Settings" : unavailable ? "This server is not currently available" : checked ? "Disable for this member" : "Enable for this member"}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
            );
          })}
        </div>}
      </section>

      <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ink-1">Context & Session</div>
            <div className="text-xs text-ink-4 mt-0.5">Manage this member’s conversation context and apply recent changes.</div>
          </div>
          <button onClick={onOpenWorkstation} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0">View session detail</button>
        </div>
        {hasUsage ? (
          <div className="rounded-lg border border-line-soft bg-surface-1 p-3 space-y-2">
            <div className="flex items-center justify-between text-xs text-ink-4"><span>Context used</span><span>{pct}% · {formatTokens(contextUsage!.totalTokens || 0)}</span></div>
            <div className="h-2 rounded-full bg-surface-3 overflow-hidden"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
            <div className="text-[11px] text-ink-4">Compact shortens conversation history. Reload applies recent prompt, skill, and tool changes.</div>
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
          <div className="rounded-xl border border-accent/30 bg-accent-dim/25 px-3 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-accent-ink leading-5">Reload</div>
              <div className="text-[11px] text-ink-3 leading-relaxed">Apply the latest prompts, skills, and tools without clearing the conversation.</div>
            </div>
            <button
              type="button"
              onClick={onReload}
              className="shrink-0 min-w-20 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-contrast shadow-sm cursor-pointer transition-opacity hover:opacity-90 active:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              Reload
            </button>
          </div>
          <div className="rounded-xl border border-blocked/30 bg-blocked-dim/25 px-3 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-blocked leading-5">Reset session</div>
              <div className="text-[11px] text-ink-3 leading-relaxed">Start fresh and clear working memory. Room messages stay visible. Requires confirm.</div>
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

        <details className="rounded-lg border border-line-soft bg-surface-1 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-3 hover:text-ink-1">Troubleshooting</summary>
          <div className="mt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-line-soft pt-2">
            <div className="text-[11px] text-ink-4 leading-relaxed">
              If Reload does not resolve a stuck member, restart it.
            </div>
            <button onClick={onRestart} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0">Restart member</button>
          </div>
        </details>
      </section>

      <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
        <div>
          <div className="text-sm font-semibold text-ink-1">Prompt supplements</div>
          <div className="text-xs text-ink-4 mt-0.5">Preview only. Ask the Room leader or this member to update these in chat.</div>
        </div>
        <div className="space-y-3">
          <PromptSupplementPreview title="Current Room Supplemental Prompt" supplement={roomSupplement} empty="Room supplement is empty." />
          <PromptSupplementPreview title={`${member.name} Member Supplemental Prompt`} supplement={memberSupplement} empty="Member supplement is empty." />
        </div>
      </section>
    </div>
  );
}


function isStationDisplayEvent(event: AgentEvent): boolean {
  if (event.type === "message_end" || event.type === "message_update" || event.type === "message_start" || event.type === "tool_update") return false;
  return isStationActionEvent(event) || event.type === "tool_end";
}

function toolLifecycleKey(event: AgentEvent): string | null {
  if (event.type !== "tool_start" && event.type !== "tool_end" && event.type !== "compaction_start" && event.type !== "compaction_end") return null;
  if (event.type === "compaction_start" || event.type === "compaction_end") return `compaction:${event.reason || "context"}`;
  return event.toolCallId ? `id:${event.toolCallId}` : `name:${event.toolName || "tool"}`;
}

function coalesceStationActivity(events: AgentEvent[]): AgentEvent[] {
  const rows: AgentEvent[] = [];
  const toolRowIndex = new Map<string, number>();
  for (const event of events) {
    if (!isStationDisplayEvent(event)) continue;
    const key = toolLifecycleKey(event);
    if (!key) {
      rows.push(event);
      continue;
    }
    const existingIndex = toolRowIndex.get(key);
    if (existingIndex === undefined) {
      rows.push(event);
      toolRowIndex.set(key, rows.length - 1);
      continue;
    }
    const previous = rows[existingIndex];
    rows[existingIndex] = {
      ...previous,
      ...event,
      args: event.args ?? previous.args,
      ts: event.ts ?? previous.ts,
      lifecycleStartedAt: previous.lifecycleStartedAt ?? previous.ts,
    };
  }
  return rows;
}

function safeEventDetail(value: unknown): string {
  if (typeof value === "string") return truncateText(value, 64);
  if (!value || typeof value !== "object") return truncateText(value ?? "", 64);
  const obj = value as Record<string, unknown>;
  return truncateText(obj.error ?? obj.message ?? obj.summary ?? obj.text ?? "", 64);
}

function findMatchingToolStart(events: AgentEvent[], endEvent: AgentEvent): AgentEvent | undefined {
  const reversed = [...events].reverse();
  return reversed.find((event) => {
    if (event.type !== "tool_start") return false;
    if (endEvent.toolCallId) return event.toolCallId === endEvent.toolCallId;
    if (endEvent.toolName && event.toolName === endEvent.toolName) return true;
    return false;
  });
}

function toolEndDetail(event: AgentEvent, events: AgentEvent[] = []): string {
  const matchingStart = findMatchingToolStart(events, event);
  return toolTarget(matchingStart?.args) || toolTarget(event.args) || (event.isError ? safeEventDetail(event.result ?? event.text) : safeEventDetail(event.result ?? event.text)) || String(event.toolName || "tool");
}

function stationSummary(event?: AgentEvent, events: AgentEvent[] = []): { kind: string; label: string; detail: string; ts?: number; pulse?: boolean } {
  if (!event) return { kind: "idle", label: "IDLE", detail: "No recent activity" };
  const ts = typeof event.ts === "number" ? event.ts : undefined;
  if (event.type === "tool_start") {
    const tool = toolDisplay(event.toolName, event.args);
    return { kind: "running", label: tool.label, detail: tool.detail || "running", ts, pulse: true };
  }
  if (event.type === "tool_end") {
    const tool = toolDisplay(event.toolName, event.args);
    return {
      kind: event.isError ? "error" : "done",
      label: tool.label,
      detail: toolEndDetail(event, events),
      ts,
    };
  }
  if (event.type === "compaction_start") {
    return { kind: "running", label: "COMPACTING · context", detail: compactionReasonLabel(event.reason), ts, pulse: true };
  }
  if (event.type === "compaction_end") {
    return {
      kind: event.errorMessage ? "error" : event.aborted ? "system" : "done",
      label: event.errorMessage ? "COMPACT FAILED" : event.aborted ? "COMPACT CANCELLED" : "COMPACTED · context",
      detail: compactionEndDetail(event),
      ts,
    };
  }
  const summary = summarizeAgentEvent(event);
  return summary;
}

function latestStationSummary(events: AgentEvent[]) {
  return stationSummary([...events].reverse().find(isStationDisplayEvent), events);
}

function actionTone(kind: string): string {
  if (kind === "running") return "text-accent-ink";
  if (kind === "done") return "text-onair";
  if (kind === "error") return "text-blocked";
  if (kind === "working") return "text-onair";
  if (kind === "tool") return "text-accent-ink";
  if (kind === "thinking") return "text-think";
  if (kind === "reply") return "text-ink-2";
  return "text-ink-4";
}

function actionShell(kind: string): string {
  if (kind === "running") return "border-accent/30 ring-1 ring-accent/10";
  if (kind === "done") return "border-onair/20";
  if (kind === "error") return "border-blocked/35 bg-blocked-dim/40";
  if (kind === "working") return "border-onair/15";
  return "border-line-soft";
}

function actionDot(kind: string): string {
  if (kind === "running") return "bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_16%,transparent)] animate-pulse";
  if (kind === "done") return "bg-onair opacity-80";
  if (kind === "error") return "bg-blocked";
  if (kind === "working") return "bg-onair shadow-[0_0_0_3px_color-mix(in_srgb,var(--on-air)_16%,transparent)] animate-pulse";
  if (kind === "thinking") return "bg-think";
  if (kind === "reply") return "bg-ink-3";
  return "bg-ink-4";
}

function ActionLine({ name, status, events, expanded, onToggle }: { name: string; status: string; events: AgentEvent[]; expanded: boolean; onToggle: () => void }) {
  const summary = latestStationSummary(events);
  const isWorkingWithoutEvent = status === "working" && summary.kind === "idle";
  const isWorkingTurnStart = status === "working" && summary.kind === "system" && summary.label === "TURN" && summary.detail === "Agent started";
  const label = isWorkingWithoutEvent ? "WORKING" : status === "working" && summary.label === "REPLY" ? "DRAFT" : summary.label;
  const time = summary.ts ? formatEventTime(summary.ts) : "";
  const detail = isWorkingWithoutEvent ? "Waiting for activity" : status === "working" && label === "DRAFT" ? summary.detail : summary.kind === "reply" && time ? `${summary.detail} · ${time}` : summary.detail;
  const visualKind = isWorkingWithoutEvent || isWorkingTurnStart ? "working" : summary.kind;
  const tone = actionTone(visualKind);
  return (
    <button
      onClick={onToggle}
      className={`w-full mt-2.5 flex items-center gap-2 rounded-md border bg-inset px-2 py-1.5 text-left hover:border-line transition-colors cursor-pointer ${actionShell(visualKind)}`}
      title={`${name}: ${label} ${detail}`}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${actionDot(visualKind)}`} />
      <span className={`text-[9px] font-bold tracking-[0.12em] uppercase shrink-0 ${tone}`}>{label}</span>
      <span className="font-mono text-[10.5px] text-ink-3 truncate flex-1">{detail}</span>
      <ChevronDown size={11} className={`text-ink-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
  );
}

function MiniEvent({ event, events = [] }: { event: AgentEvent; events?: AgentEvent[] }) {
  const summary = stationSummary(event, events);
  const time = formatEventTime(typeof event.ts === "number" ? event.ts : undefined);
  return (
    <div className={`rounded-md bg-inset border px-2 py-1.5 ${actionShell(summary.kind)}`}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${actionDot(summary.kind)}`} />
        <span className={`text-[9px] font-bold tracking-[0.1em] uppercase shrink-0 ${actionTone(summary.kind)}`}>{summary.label}</span>
        <span className="font-mono text-[10.5px] text-ink-3 truncate flex-1">{summary.detail}</span>
        {time && <span className="font-mono text-[9.5px] text-ink-4 shrink-0">{time}</span>}
      </div>
    </div>
  );
}

export function ModelPop({
  models,
  current,
  anchorRect = null,
  onSelect,
  onClose,
}: {
  models: AvailableModelOption[];
  current: { model: string | null; credentialId: string | null };
  anchorRect?: DOMRect | null;
  onSelect: (model: string, credentialId: string) => void;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = 260;
  const gap = 6;
  const maxHeight = 288;
  const grouped = models.reduce<Record<string, AvailableModelOption[]>>((acc, m) => {
    const key = modelProfileLabel(m);
    (acc[key] ||= []).push(m);
    return acc;
  }, {});

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose?.();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose?.();
    };
    const onResize = () => onClose?.();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const content = (
    <>
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group}>
          <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold tracking-[0.05em] text-ink-4 truncate" title={group}>{group}</div>
          {items.map((m) => {
            const isCurrent = current.model === m.ref && (!current.credentialId || current.credentialId === m.profileId);
            return (
              <button
                key={`${m.profileId}::${m.ref}`}
                onClick={() => onSelect(m.ref, m.profileId)}
                className={`w-full text-left font-mono text-[11px] px-2 py-1.5 rounded-md flex items-center gap-2 cursor-pointer transition-colors ${
                  isCurrent ? "text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1"
                }`}
              >
                <span className="truncate flex-1" title={m.displayName || m.modelId}>{m.displayName || m.modelId}</span>
                {isCurrent && <span className="text-[9px] text-ink-4 shrink-0">Current</span>}
              </button>
            );
          })}
        </div>
      ))}
      {models.length === 0 && <p className="text-[11px] text-think px-2 py-2">No models available. Connect a provider in Settings → Models.</p>}
      <p className="text-[10px] text-ink-4 px-2 pt-1.5 pb-1 border-t border-line-soft mt-1 leading-relaxed">
        Model changes apply to this member in this Room on the next turn.
      </p>
    </>
  );

  if (!anchorRect) {
    return (
      <div ref={ref} onClick={(e) => e.stopPropagation()} className="absolute top-full mt-1.5 z-30 bg-surface-3 border border-line-strong rounded-lg p-1.5 max-h-72 overflow-y-auto w-[260px]" style={{ boxShadow: "var(--shadow-pop)" }}>
        {content}
      </div>
    );
  }

  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.right - width));
  const opensUp = window.innerHeight - anchorRect.bottom < maxHeight + gap && anchorRect.top > maxHeight + gap;
  const vertical = opensUp ? { bottom: window.innerHeight - anchorRect.top + gap } : { top: anchorRect.bottom + gap };

  return createPortal(
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 bg-surface-3 border border-line-strong rounded-lg p-1.5 max-h-72 overflow-y-auto w-[260px]"
      style={{ left, ...vertical, boxShadow: "var(--shadow-pop)" }}
    >
      {content}
    </div>,
    document.body,
  );
}

import { availableThinkingLevels, findModelOptionForBinding } from "./thinking-levels";

export function ThinkingPop({
  currentThinking,
  anchorRect = null,
  onSelect,
  onClose,
  models,
  modelRef,
  credentialId,
}: {
  currentThinking: string;
  anchorRect?: DOMRect | null;
  onSelect: (thinkingLevel: string | null) => void;
  onClose?: () => void;
  models?: AvailableModelOption[];
  modelRef?: string | null;
  credentialId?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = 200;
  const gap = 6;
  const boundModel = models ? findModelOptionForBinding(modelRef, credentialId, models) : undefined;
  const levels = availableThinkingLevels(boundModel);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose?.();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose?.();
    };
    const onResize = () => onClose?.();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const content = (
    <>
      <div className="px-2 pt-1.5 pb-1 text-[9px] font-semibold tracking-[0.05em] text-ink-4">THINKING EFFORT</div>
      <div className="grid grid-cols-2 gap-1 px-1">
        {levels.map((level) => (
          <button
            key={level.label}
            onClick={() => onSelect(level.value)}
            className={`text-left font-mono text-[10.5px] px-2 py-1.5 rounded cursor-pointer transition-colors ${level.value !== null && currentThinking === level.value ? "bg-accent-dim" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1"}`}
          >
            <span className={`font-semibold ${thinkLevelTextClass(level.label)}`}>{level.label}</span>
          </button>
        ))}
      </div>
      <p className="text-[10px] text-ink-4 px-2 pt-1.5 pb-1 border-t border-line-soft mt-1 leading-relaxed">Applies to this member in this Room.</p>
    </>
  );

  if (!anchorRect) {
    return <div ref={ref} onClick={(e) => e.stopPropagation()} className="absolute top-full mt-1.5 z-30 bg-surface-3 border border-line-strong rounded-lg p-1.5 w-[200px]" style={{ boxShadow: "var(--shadow-pop)" }}>{content}</div>;
  }

  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.right - width));
  const opensUp = window.innerHeight - anchorRect.bottom < 210 && anchorRect.top > 210;
  const vertical = opensUp ? { bottom: window.innerHeight - anchorRect.top + gap } : { top: anchorRect.bottom + gap };

  return createPortal(
    <div ref={ref} onClick={(e) => e.stopPropagation()} className="fixed z-50 bg-surface-3 border border-line-strong rounded-lg p-1.5 w-[200px]" style={{ left, ...vertical, boxShadow: "var(--shadow-pop)" }}>
      {content}
    </div>,
    document.body,
  );
}
