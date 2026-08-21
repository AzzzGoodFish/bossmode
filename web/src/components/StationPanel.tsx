import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Activity, Square, ChevronRight, Pencil, X } from "lucide-react";
import {
  abortAgent, getRoomMembers, getConfiguredModels, updateRoomMember, getAgentEventsPaginated, getConversationEvents, getToken, getMcpSettings, restartMember, resetAgentSession, steerAgent, reloadMemberResources,
  getRoomPrinciples, getMemberPrinciples, getMemberMainline, getAgent, getMemberStats, getMemberCorePrompt, getMemberActiveTools, getExtensions,
  getMemberScopedStats, getMemberMemoryAsset, getMemberCorePromptScoped, getConversationTools,
  type MemberInfo, type AvailableModelOption, type ContextUsageData, type McpServerSummary, type Principles, type Mainline, type MainlineIndexEntry, type PromptAssetBudget, type AgentDetail, type MemberStats, type ExtensionRecord, type MemberActiveTool,
} from "../api/client";
import { formatRelativeTime, formatSinceDate, budgetTone, promptAssetCount } from "../utils/member-panel-view";
import { Sheet } from "./Sheet";
import { Markdown } from "./Markdown";
import { diffStatForTool, formatEventTime, isActivityStreamEvent, summarizeAgentEvent, toolDisplay, toolTarget, truncateText, type AgentEvent } from "./agent-event-utils";
import type { AgentStatusMap } from "../hooks/useRoom";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { ModelPicker, modelProfileLabel } from "./ModelPicker";
import { useDialog } from "./dialogs";
import { ActivityTab, ThinkingTrace, ToolCard, ToolGroupBlock, ReplyCard, UserPromptCard, CompactionCard, MemberDisc } from "./ActivityTab";

interface StationPanelProps {
  members: string[];
  agentStatus: AgentStatusMap;
  staleMembers?: Record<string, { mounts?: { since: number; fields: string[] }; contract?: boolean }>;
  contextUsage: Record<string, ContextUsageData>;
  roomId: string;
  /** Topic page: activity reads/watches this scope; member config still uses roomId. */
  activityScope?: string;
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
  onMembersChanged?: () => void;
  unreadAgents?: Set<string> | null;
  onJumpToMessage?: (messageId: string) => Promise<void>;
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

export function isAssignableMcpServer(server: McpServerSummary): boolean {
  return server.transport !== "invalid" && server.availability?.status !== "invalid-config";
}

/** Room member stations with status, model controls, context usage, and actions. */
export function StationPanel({ members, agentStatus, staleMembers, contextUsage, roomId, activityScope, onOpenMcpSettings, onOpenExtensionsSettings, onMembersChanged, unreadAgents, onJumpToMessage }: StationPanelProps) {
  const { toast, confirm } = useDialog();
  const [memberInfos, setMemberInfos] = useState<Record<string, MemberInfo>>({});
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [chipAnchor, setChipAnchor] = useState<DOMRect | null>(null);
  const [openThinkingChip, setOpenThinkingChip] = useState<string | null>(null);
  const [thinkingAnchor, setThinkingAnchor] = useState<DOMRect | null>(null);
  const [feedEvents, setFeedEvents] = useState<Record<string, AgentEvent[]>>({});
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedFilter, setFeedFilter] = useState<string | null>(null);
  const feedScrollRef = useRef<HTMLDivElement>(null);
  const feedPinnedRef = useRef(true);
  // Card-river live streams (fish 2026-08-21 ②): message_update deltas are on
  // the WS already (never persisted); accumulate per member, flush to state at
  // 60ms so delta bursts don't churn the rail. Stream cards are a live preview
  // — on reload only settled cards render (REST has finals only).
  const [liveStreams, setLiveStreams] = useState<Record<string, LiveStream>>({});
  const streamBufRef = useRef<Record<string, LiveStream>>({});
  const streamFlushRef = useRef<number | null>(null);
  const [showNewBtn, setShowNewBtn] = useState(false);
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpLoadStatus, setMcpLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [installedExtensions, setInstalledExtensions] = useState<ExtensionRecord[]>([]);
  const [extensionsLoadStatus, setExtensionsLoadStatus] = useState<"loading" | "ready" | "error">("loading");

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

  const refreshExtensions = useCallback(async () => {
    setExtensionsLoadStatus("loading");
    try {
      const data = await getExtensions();
      setInstalledExtensions(data.extensions || []);
      setExtensionsLoadStatus("ready");
    } catch (err) {
      console.error("Failed to load extensions:", err);
      setExtensionsLoadStatus("error");
    }
  }, []);

  useEffect(() => { void refreshExtensions(); }, [refreshExtensions]);

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
        const detail = err instanceof Error && err.message ? err.message : "Check the connection in Settings → Models, then try again.";
        toast(`Couldn’t update the model. ${detail}`, "error");
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

  const eventWatchId = activityScope || roomId;

  // A+ fusion feed (fish 2026-08-20): each member's raw activity stream, kept
  // per member and merged into turn blocks at render. Same visibility filter
  // as the member Activity tab (isActivityStreamEvent).
  const loadFeedEvents = useCallback(async (name: string) => {
    try {
      const result = activityScope
        ? await getConversationEvents(activityScope, name, FEED_PAGE_SIZE)
        : await getAgentEventsPaginated(roomId, name, FEED_PAGE_SIZE);
      setFeedEvents((prev) => ({ ...prev, [name]: (result.events as AgentEvent[]).filter(isActivityStreamEvent).slice(-FEED_PAGE_SIZE) }));
    } catch (err) {
      console.error("Failed to load agent activity:", err);
    }
  }, [roomId, activityScope]);

  useEffect(() => {
    if (!eventWatchId) return;
    setFeedLoading(true);
    void Promise.all(members.map((name) => loadFeedEvents(name))).finally(() => setFeedLoading(false));
  }, [eventWatchId, members.join("\u0000"), loadFeedEvents]);

  useEffect(() => {
    const token = getToken();
    if (!token || !eventWatchId || members.length === 0) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}?token=${token}`);
    ws.onopen = () => {
      for (const name of members) ws.send(JSON.stringify({ type: "subscribe:agent", roomId: eventWatchId, agent: name }));
    };
    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== "agent:event" || data.roomId !== eventWatchId || !members.includes(data.agent)) return;
        const event = data.event as AgentEvent;
        const agent = data.agent as string;
        // Streaming deltas feed the live-preview cards, not the event buffer.
        if (event.type === "message_start") {
          streamBufRef.current[agent] = { thinking: "", text: "", t0: typeof event.ts === "number" ? event.ts : Date.now() };
          scheduleStreamFlush();
          return;
        }
        if (event.type === "message_update") {
          const cur = streamBufRef.current[agent] || { thinking: "", text: "", t0: Date.now() };
          if (typeof event.thinking === "string") cur.thinking += event.thinking;
          if (typeof event.text === "string") cur.text += event.text;
          streamBufRef.current[agent] = cur;
          scheduleStreamFlush();
          return;
        }
        if (event.type === "message_end") {
          delete streamBufRef.current[agent];
          scheduleStreamFlush();
          // falls through: a message_end carrying text/thinking also enters the buffer
        }
        if (!isActivityStreamEvent(event)) return;
        // Display-only tolerance: live events missing a server ts (e.g. the
        // user_prompt path, which broadcasts the pre-stamp original) get the
        // client arrival time so the river keeps arrival order; the disk ts
        // remains authoritative and replaces it on reload.
        const display = typeof event.ts === "number" ? event : { ...event, ts: Date.now() };
        setFeedEvents((prev) => ({ ...prev, [agent]: [...(prev[agent] || []), display].slice(-FEED_BUFFER_CAP) }));
      } catch {}
    };
    return () => ws.close();
  }, [eventWatchId, members.join("\u0000")]);

  /** 60ms-batched mirror of streamBufRef → React state. */
  const scheduleStreamFlush = useCallback(() => {
    if (streamFlushRef.current !== null) return;
    streamFlushRef.current = window.setTimeout(() => {
      streamFlushRef.current = null;
      setLiveStreams({ ...streamBufRef.current });
    }, 60);
  }, []);
  useEffect(() => () => { if (streamFlushRef.current !== null) window.clearTimeout(streamFlushRef.current); }, []);

  const closePops = useCallback(() => {
    setOpenChip(null);
    setChipAnchor(null);
    setOpenThinkingChip(null);
    setThinkingAnchor(null);
  }, []);

  /** Card river (fish 2026-08-21): flat cards, each self-tagged with its member.
   * No turn headers. agent_start/agent_end stay out (turn chrome); consecutive
   * same-member tool calls still collapse into a group (boundary-safe: a turn
   * edge flushes the run). */
  const riverItems = useMemo<RiverItem[]>(() => {
    const names = feedFilter && members.includes(feedFilter) ? [feedFilter] : members;
    const items: RiverItem[] = [];
    for (const name of names) {
      const events = feedEvents[name] || [];
      const endMap: Record<string, AgentEvent> = {};
      for (const e of events) if (e.type === "tool_end" && e.toolCallId) endMap[e.toolCallId] = e;
      const paired = (e: AgentEvent) => !!e.toolCallId && events.some((s) => s.type === "tool_start" && s.toolCallId === e.toolCallId);
      let run: AgentEvent[] = [];
      const flush = () => {
        if (run.length >= 2) {
          items.push({ kind: "group", member: name, events: run, toolEndMap: endMap, firstTs: riverTs(run[0]), key: `${name}:g:${run[0].ts ?? "x"}:${items.length}` });
        } else {
          for (const e of run) items.push({ kind: "event", member: name, event: e, toolEnd: e.toolCallId ? endMap[e.toolCallId] : undefined, firstTs: riverTs(e), key: `${name}:e:${e.ts ?? "x"}:${items.length}` });
        }
        run = [];
      };
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === "agent_start" || e.type === "agent_end") { flush(); continue; }
        if (e.type === "tool_end" && paired(e)) continue; // rendered inside its tool_start card
        if (e.type === "tool_start") { run.push(e); continue; }
        flush();
        // thinking duration = gap to the next timestamped event (same honest estimate as the Activity tab)
        let thinkSec: number | undefined;
        if (e.type === "message_end" && e.thinking && typeof e.ts === "number") {
          const next = events.slice(i + 1).find((n) => typeof n.ts === "number");
          if (next) thinkSec = Math.max(0, Math.round(((next.ts as number) - e.ts) / 1000));
        }
        items.push({ kind: "event", member: name, event: e, toolEnd: e.type === "tool_end" ? e : undefined, thinkSec, firstTs: riverTs(e), key: `${name}:e:${e.ts ?? "x"}:${i}` });
      }
      flush();
    }
    items.sort((a, b) => a.firstTs - b.firstTs);
    return items.slice(-RIVER_MAX_ITEMS);
  }, [feedEvents, members, feedFilter]);

  /** Live stream cards ride at the river's tail (the forming edge). */
  const streamCards = useMemo(() => {
    const names = feedFilter && members.includes(feedFilter) ? [feedFilter] : members;
    return names.flatMap((name) => {
      const s = liveStreams[name];
      if (!s || (!s.thinking && !s.text)) return [];
      const cards: Array<{ name: string; s: LiveStream; kind: "think" | "reply" }> = [];
      if (s.thinking) cards.push({ name, s, kind: "think" });
      if (s.text) cards.push({ name, s, kind: "reply" });
      return cards;
    });
  }, [liveStreams, members, feedFilter]);

  // Follow the live tail unless the user scrolled up; then float "↓ New activity".
  useEffect(() => {
    const el = feedScrollRef.current;
    if (!el) return;
    if (feedPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowNewBtn(false);
    } else {
      setShowNewBtn(true);
    }
  }, [riverItems, streamCards]);

  const jumpToLatest = useCallback(() => {
    feedPinnedRef.current = true;
    const el = feedScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowNewBtn(false);
  }, []);

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

  const toggleMemberExtension = useCallback(async (member: MemberInfo, extId: string) => {
    const current = new Set(member.extensions || []);
    // Match by name or id variants
    const keys = [extId];
    const hit = [...current].find((c) => c === extId || c === `npm:${extId}` || extId.endsWith(c) || c.endsWith(extId));
    if (hit) current.delete(hit);
    else current.add(extId);
    const next = Array.from(current);
    try {
      const updated = await updateRoomMember(roomId, member.id, { extensions: next });
      setMemberInfos((prev) => ({ ...prev, [member.name]: updated }));
      toast(`Saved. Reload ${member.name} to apply extension tools.`, "success");
    } catch (err) {
      console.error("Failed to save member extensions", err);
      toast("Couldn’t save extension access. Try again.", "error");
    }
  }, [roomId, toast]);

  const workingCount = members.filter((m) => agentStatus[m] === "working").length;

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <div className="h-10 px-3.5 border-b border-line-soft flex items-center justify-between shrink-0">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-4">WORKSTATIONS</span>
        <span className="font-mono text-[10.5px] text-ink-4">
          <span className="text-onair">{workingCount}</span> / {members.length} on duty
        </span>
      </div>

      {/* Roster — compact member strips (A+ fusion, fish 2026-08-20). Row
       * click = filter the feed to that member (click again / ×clear = all);
       * avatar & name open member detail as before; chips tune model/thinking. */}
      <div className="shrink-0 max-h-[42%] overflow-y-auto border-b border-line" onScroll={closePops}>
        {members.map((name) => {
          const status = agentStatus[name] || "inactive";
          const info = memberInfos[name];
          const isBusy = status === "working";
          const hasUnread = unreadAgents?.has(name);
          const selected = feedFilter === name;
          const activity = currentActivityLine(feedEvents[name] || [], status, liveStreams[name]);
          const agentLabel = displayAgentLabel(info?.agent || info?.sourceAgent || name);
          const modelRef = info?.model || "";
          const modelLabel = compactModelId(modelRef, models);
          const isConfigured = !!info?.model && !!info?.credentialId;
          const modelWarning = isConfigured ? memberModelAvailabilityLabel(info?.model, info?.credentialId, models) : null;
          const modelAvailable = isConfigured && modelWarning === null;
          const modelChipLabel = !isConfigured ? (models.length === 0 ? "No model" : "Select model") : modelAvailable ? modelLabel : modelWarning!;
          const modelChipTitle = !isConfigured
            ? "Choose a model and credential for this member"
            : modelAvailable
              ? `${modelRef} · This room only`
              : (models.length === 0 ? "Connect a provider in Settings → Models" : `${modelRef} is unavailable`);

          return (
            <div key={name} className={`border-b border-line-soft last:border-b-0 transition-colors ${selected ? "bg-accent-dim/40" : ""}`}>
              <div
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                onClick={() => setFeedFilter(selected ? null : name)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFeedFilter(selected ? null : name); } }}
                title={selected ? `${name} filtered — click to show all members` : `Filter the activity feed to ${name}`}
                className="flex items-center gap-2 px-3 py-[7px] cursor-pointer select-none hover:bg-surface-2 transition-colors"
              >
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); setSelectedMember(name); }}
                  className="cursor-pointer rounded-full shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  title={`Configure ${name} · ${statusLabel(status)}`}
                >
                  <StaffBadge name={name} status={statusFromAgent(status)} size="xs" stale={!!staleMembers?.[name]} staleTitle={staleMembers?.[name] ? [staleMembers[name].contract && "App updated", staleMembers[name].mounts && "Configuration changed"].filter(Boolean).join(" · ") + " — Reload to apply" : ""} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedMember(name); }}
                  className="text-[12.5px] font-semibold text-ink-1 truncate flex items-center gap-1.5 cursor-pointer hover:text-accent-ink transition-colors shrink-0 max-w-[38%]"
                  title={`Configure ${name} · Agent: ${agentLabel}`}
                >
                  <span className="truncate">{name}</span>
                  {hasUnread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                </button>
                <span className={`flex-1 min-w-0 truncate font-mono text-[10.5px] ${activityTone(activity.kind)}`}>
                  {activity.text}{activity.liveSince !== undefined && <> · <LiveSeconds since={activity.liveSince} /></>}
                </span>
                {isBusy && (
                  <button
                    onClick={(e) => { e.stopPropagation(); abortAgent(roomId, name).catch(console.error); }}
                    className="w-4 h-4 flex items-center justify-center rounded text-ink-4 hover:text-blocked hover:bg-surface-3 transition-colors cursor-pointer shrink-0"
                    title={`Abort ${name}`}
                  >
                    <Square size={9} fill="currentColor" />
                  </button>
                )}
              </div>
              {/* Config chips — model / thinking (same pops as before) + ⋯ detail. */}
              <div className="relative flex items-center gap-1 px-3 pb-2 pl-[40px]">
                {info && (
                  <>
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
                      className={`font-mono text-[10px] rounded-md border border-line-soft bg-surface-1 px-1.5 py-0.5 cursor-pointer transition-colors max-w-[132px] truncate text-left hover:border-line-strong ${
                        !isConfigured || !modelAvailable ? "text-think" : "text-ink-3 hover:text-ink-1"
                      }`}
                    >
                      {modelChipLabel} ▾
                    </button>
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
                      className="font-mono text-[10px] rounded-md border border-line-soft bg-surface-1 px-1.5 py-0.5 cursor-pointer transition-colors shrink-0 text-ink-3 hover:text-ink-1 hover:border-line-strong"
                    >
                      think <span className={`font-semibold ${thinkLevelTextClass(info.thinkingLevel || "default")}`}>{info.thinkingLevel || "default"}</span> ▾
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedMember(name); }}
                      title={`${name} detail — memory, session & tools`}
                      className="font-mono text-[10px] rounded-md border border-dashed border-line-soft bg-surface-1 px-1.5 py-0.5 cursor-pointer transition-colors shrink-0 text-ink-4 hover:text-ink-1 hover:border-line-strong"
                    >
                      ⋯
                    </button>
                  </>
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
          );
        })}
      </div>

      {/* Merged activity feed — every member's turns interleaved by time; the
       * rail itself is the progress console (no separate Activity chrome). */}
      <div className="h-8 px-3 flex items-center gap-1.5 shrink-0">
        <Activity size={10} className="text-ink-4 shrink-0" aria-hidden />
        <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-4 uppercase truncate">Activity · {feedFilter && members.includes(feedFilter) ? feedFilter : "all members"}</span>
        {feedFilter && members.includes(feedFilter) && (
          <button onClick={() => setFeedFilter(null)} className="text-[10px] font-semibold text-accent-ink hover:underline cursor-pointer shrink-0">× clear</button>
        )}
      </div>
      <div className="relative flex-1 min-h-0">
        <div
          ref={feedScrollRef}
          onScroll={() => {
            const el = feedScrollRef.current;
            if (!el) return;
            const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            feedPinnedRef.current = pinned;
            if (pinned) setShowNewBtn(false);
            closePops();
          }}
          className="h-full overflow-y-auto px-2.5 py-2.5"
        >
          {feedLoading && <div className="text-center text-[11px] text-ink-4 py-8">Loading activity…</div>}
          {!feedLoading && riverItems.length === 0 && streamCards.length === 0 && (
            <div className="text-center text-[11px] text-ink-4 py-8">{feedFilter ? `No recent activity for ${feedFilter}.` : "No member activity yet."}</div>
          )}
          <div className="space-y-[6px]">
            {riverItems.map((item) =>
              item.kind === "group" ? (
                <ToolGroupBlock key={item.key} events={item.events} toolEndMap={item.toolEndMap} query="" member={item.member} />
              ) : (
                <RiverEventCard key={item.key} item={item} />
              ),
            )}
            {streamCards.map((sc) => (
              <StreamCard key={`stream:${sc.name}:${sc.kind}`} member={sc.name} kind={sc.kind} text={sc.kind === "think" ? sc.s.thinking : sc.s.text} t0={sc.s.t0} />
            ))}
          </div>
        </div>
        {showNewBtn && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10">
            <button
              onClick={jumpToLatest}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-surface-3 border border-line-strong text-ink-1 rounded-full shadow-lg hover:bg-surface-2 transition-colors cursor-pointer"
              title="Back to the latest activity"
            >
              ↓ New activity
            </button>
          </div>
        )}
      </div>
      <Sheet open={!!selectedMember} onClose={() => setSelectedMember(null)} size="xl" dock="right">
        {selectedMember && memberInfos[selectedMember] && (
          <MemberConfigPanel
            roomId={roomId}
            activityScope={activityScope}
            member={memberInfos[selectedMember]}
            status={agentStatus[selectedMember] || "inactive"}
            stale={staleMembers?.[selectedMember]}
            contextUsage={contextUsage[selectedMember]}
            existingMemberNames={members}
            models={models}
            mcpEnabled={mcpEnabled}
            mcpServers={mcpServers}
            mcpLoadStatus={mcpLoadStatus}
            onRetryMcp={refreshMcpSettings}
            onOpenMcpSettings={() => { onOpenMcpSettings?.(); setSelectedMember(null); }}
            onClose={() => setSelectedMember(null)}
            onRename={(name) => handleRenameMember(memberInfos[selectedMember], name)}
            onSwitchModel={(model, credentialId) => handleSwitchModel(memberInfos[selectedMember], model, credentialId)}
            onSwitchThinking={(thinkingLevel) => handleSwitchThinking(memberInfos[selectedMember], thinkingLevel)}
            onCompact={() => handleCompactMember(memberInfos[selectedMember])}
            onReload={() => handleReloadMember(memberInfos[selectedMember])}
            onRestart={() => handleRestartMember(memberInfos[selectedMember])}
            onResetSession={() => handleResetSession(memberInfos[selectedMember])}
            onToggleMcp={(server) => toggleMemberMcpServer(memberInfos[selectedMember], server)}
            installedExtensions={installedExtensions}
            extensionsLoadStatus={extensionsLoadStatus}
            onRetryExtensions={refreshExtensions}
            onToggleExtension={(extId) => toggleMemberExtension(memberInfos[selectedMember], extId)}
            onOpenExtensionsSettings={() => { onOpenExtensionsSettings?.(); setSelectedMember(null); }}
            onJumpToMessage={onJumpToMessage}
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

type PanelTab = "overview" | "assets" | "activity" | "session";

function BudgetMeter({ budget }: { budget?: PromptAssetBudget }) {
  if (!budget) return null;
  const tone = budgetTone(budget);
  const numCls = tone === "over" ? "text-blocked" : tone === "warn" ? "text-think" : "text-ink-2";
  const barCls = tone === "over" ? "bg-blocked" : tone === "warn" ? "bg-think" : "bg-accent";
  return (
    <span className="ml-auto flex items-center gap-2 shrink-0" title={budget.overLimit ? "Over budget — pending curation" : "Prompt asset capacity"}>
      <span className="text-[10.5px] text-ink-4 whitespace-nowrap">
        <span className={`font-semibold ${numCls}`}>{budget.pct}%</span> — {budget.usage.toLocaleString("en-US")} / {budget.limit.toLocaleString("en-US")}
      </span>
      <span className="w-[74px] h-[5px] rounded-full bg-surface-3 overflow-hidden">
        <span className={`block h-full rounded-full ${barCls}`} style={{ width: `${Math.max(2, Math.min(100, budget.pct))}%` }} />
      </span>
    </span>
  );
}

function AssetRevLine({ left, right }: { left: string; right?: string }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3 text-[10.5px] text-ink-4">
      <span>{left}</span>
      {right ? <span className="text-right">{right}</span> : null}
    </div>
  );
}

function AssetTag({ children, tone }: { children: string; tone?: "room" | "dm" }) {
  return (
    <span className={`text-[9.5px] font-bold uppercase tracking-wide border rounded-full px-2 py-0.5 shrink-0 ${tone === "dm" ? "border-line-soft bg-think-dim text-think" : "border-line-soft bg-surface-2 text-ink-4"}`}>
      {children}
    </span>
  );
}

/** First non-empty line of an asset, trimmed — the collapsed one-line preview. */
/** First non-empty content line of an asset — skips markdown headings and
 * separator lines so the collapsed preview shows real content (Mainline shows
 * its first Focus sentence, not "## Focus"). */
function firstContentLine(content: string): string {
  const line = content.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^#{1,6}\s/.test(l) && !/^[-=]{3,}$/.test(l));
  return line ?? "";
}

type PromptView = "markdown" | "raw";

/** Prompt-assets unified accordion card (fish-approved prototype
 * prompt-assets-accordion-v1): header row clickable (chevron rotates 90°,
 * title, scope tag, right budget mini meter); default collapsed = one-line
 * preview; expanded = hint line merged with [Markdown | Raw] toggle in one
 * row (hint left truncated with title tooltip, toggle right) + content area
 * 320px max-height inner scroll. */
function AccordionCard({ title, tag, hint, budget, preview, defaultView, empty, renderContent }: {
  title: string;
  tag?: React.ReactNode;
  hint?: React.ReactNode;
  budget?: PromptAssetBudget;
  preview: string;
  defaultView?: PromptView;
  empty?: React.ReactNode;
  renderContent: (view: PromptView) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PromptView>(defaultView ?? "markdown");
  return (
    <section className="rounded-xl border border-line-soft bg-surface-1 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full block px-4 py-2.5 text-left cursor-pointer hover:bg-surface-2 transition-colors"
      >
        <span className="flex items-center gap-2 min-w-0">
          <ChevronRight size={13} className={`shrink-0 text-ink-4 transition-transform ${open ? "rotate-90" : ""}`} />
          <h3 className="text-[13.5px] font-bold text-ink-1 truncate">{title}</h3>
          {tag}
          <span className="ml-auto shrink-0">{budget && <BudgetMeter budget={budget} />}</span>
        </span>
        {!open && preview && (
          <span className="mt-1 flex items-center gap-2 min-w-0 pl-[36px]">
            <span className="text-[11.5px] text-ink-4 truncate min-w-0">{preview}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-line-soft px-4 py-3">
          <div className="flex items-center gap-2 mb-2 min-w-0">
            {hint ? (
              <span className="text-[11.5px] text-ink-4 leading-relaxed truncate min-w-0" title={typeof hint === "string" ? hint : undefined}>{hint}</span>
            ) : null}
            <span className="ml-auto shrink-0 flex items-center gap-0.5 rounded-md border border-line-soft bg-surface-2 p-0.5 text-[11px] font-medium">
              <button type="button" onClick={() => setView("markdown")} className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${view === "markdown" ? "bg-surface-3 text-ink-1" : "text-ink-4 hover:text-ink-2"}`}>Markdown</button>
              <button type="button" onClick={() => setView("raw")} className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${view === "raw" ? "bg-surface-3 text-ink-1" : "text-ink-4 hover:text-ink-2"}`}>Raw</button>
            </span>
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            {empty ?? renderContent(view)}
          </div>
        </div>
      )}
    </section>
  );
}

function PanelCard({ title, tag, aside, hint, children }: {
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

const INDEX_KIND_CLS: Record<string, string> = {
  doc: "bg-accent-dim text-accent-ink",
  task: "bg-think/10 text-think",
  msg: "bg-surface-3 text-ink-3",
};

function MainlineIndexList({ index, onJumpToMessage }: { index: MainlineIndexEntry[]; onJumpToMessage?: (messageId: string) => Promise<void> }) {
  if (index.length === 0) return null;
  const jumpMsg = (entry: MainlineIndexEntry) => {
    if (!entry.msgId || entry.stale || !onJumpToMessage) return;
    void onJumpToMessage(entry.msgId);
  };
  return (
    <ul className="mt-2.5 flex flex-col gap-1.5">
      {index.map((entry, i) => {
        const clickableMsg = entry.kind === "msg" && !!entry.msgId && !entry.stale && !!onJumpToMessage;
        const display = entry.kind === "msg" && entry.summary
          ? (entry.note ? entry.note : entry.summary)
          : entry.note;
        return (
          <li key={`${entry.raw}:${i}`}>
            <button
              type="button"
              disabled={!clickableMsg}
              onClick={() => jumpMsg(entry)}
              title={entry.kind === "msg" && entry.stale ? "Message no longer available" : entry.kind === "msg" && clickableMsg ? "Jump to message" : undefined}
              className={`w-full flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors ${entry.stale ? "border-dashed border-line opacity-60 cursor-default" : "border-line-soft bg-surface-1"} ${clickableMsg ? "hover:bg-surface-2 hover:border-line-strong cursor-pointer" : "cursor-default"}`}
            >
              {entry.kind !== "other" && (
                <span className={`text-[9.5px] font-extrabold uppercase tracking-wide rounded px-1.5 py-0.5 shrink-0 ${INDEX_KIND_CLS[entry.kind]}`}>{entry.kind}</span>
              )}
              <span className={`font-mono text-[11.5px] text-ink-1 truncate ${entry.stale ? "line-through" : ""}`}>{entry.kind === "other" ? entry.note : entry.ref}</span>
              {entry.stale && <span className="text-[9.5px] font-bold uppercase text-blocked shrink-0">stale</span>}
              {entry.kind !== "other" && display && (
                <span className="ml-auto text-[11px] text-ink-4 truncate max-w-[40%] text-right shrink-0">{display}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function revisionLine(asset: Principles | Mainline): string {
  return `revision ${asset.revision} · updated ${formatRelativeTime(asset.updatedAt)}`;
}

function PrinciplesCard({ title, hint, principles, full, emptyTitle, emptyHint }: {
  title: string;
  hint: string;
  principles: Principles | null;
  full?: boolean;
  emptyTitle: string;
  emptyHint: string;
}) {
  void full; // accordion caps content height uniformly (320px) — the old full/non-full split is gone
  return (
    <AccordionCard
      title={title}
      budget={principles?.budget}
      hint={hint}
      preview={principles ? firstContentLine(principles.content) : "Loading…"}
      empty={principles === null ? <div className="text-xs text-ink-4 py-1">Loading…</div> : principles.content.trim() ? undefined : <EmptyAsset title={emptyTitle} hint={emptyHint} />}
      renderContent={(view) => (
        <>
          <div className={`text-[13px] text-ink-2 leading-relaxed ${view === "raw" ? "whitespace-pre-wrap font-mono text-[12px]" : "preview-markdown"}`}>
            {view === "markdown" ? <Markdown content={principles!.content} /> : principles!.content}
          </div>
          <AssetRevLine left={revisionLine(principles!)} right="member-curated" />
        </>
      )}
    />
  );
}

function MainlineCard({ member, mainline, full, onJumpToMessage }: { member: MemberInfo; mainline: Mainline | null; full?: boolean; onJumpToMessage?: (messageId: string) => Promise<void> }) {
  void full;
  return (
    <AccordionCard
      title="Mainline"
      tag={<AssetTag>focus · index</AssetTag>}
      budget={mainline?.budget}
      hint="What this member is working on — durable focus plus live pointers into docs, tasks and messages."
      preview={mainline ? firstContentLine(mainline.content) : "Loading…"}
      empty={mainline === null ? <div className="text-xs text-ink-4 py-1">Loading…</div> : mainline.content.trim() ? undefined : <EmptyAsset title="No mainline yet" hint={`Once @${member.name} settles into work, it pins its focus and key references here.`} />}
      renderContent={(view) => (
        <>
          {mainline!.parsed.focus && (
            <div className="mb-2.5">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-4 mb-1">Focus</div>
              <div className={`text-[12.5px] text-ink-2 leading-relaxed ${view === "raw" ? "whitespace-pre-wrap font-mono text-[12px]" : "preview-markdown"}`}>
                {view === "markdown" ? <Markdown content={mainline!.parsed.focus} /> : mainline!.parsed.focus}
              </div>
            </div>
          )}
          {mainline!.parsed.index.length > 0 && (
            <div className="mb-2.5">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-4 mb-1">Index</div>
              <MainlineIndexList index={mainline!.parsed.index} onJumpToMessage={onJumpToMessage} />
            </div>
          )}
          <AssetRevLine
            left={revisionLine(mainline!)}
            right={mainline!.parsed.index.length > 0
              ? `${mainline!.parsed.index.length} pinned references${mainline!.parsed.index.some((i) => i.stale) ? " · stale shown honestly" : ""}`
              : undefined}
          />
        </>
      )}
    />
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0h";
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  if (hours < 100) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function StatSlot({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-line-soft bg-inset px-3 py-2.5">
      <div className="text-[10px] font-semibold tracking-[0.06em] text-ink-4">{label}</div>
      <div className="mt-1 text-[20px] font-semibold text-ink-1 leading-tight tabular-nums">{value}</div>
      {detail ? <div className="mt-0.5 text-[11px] text-ink-4 leading-tight">{detail}</div> : null}
    </div>
  );
}

/** Overview status block: six real, data-backed cells. Every value is sourced
 * from live state or the persistent per-member stats accumulator (never
 * fabricated) — a member with no recorded activity shows real zeros. */
function StatusGrid({ status, member, contextUsage, stats, models, dm }: {
  status: string;
  member: MemberInfo;
  contextUsage?: ContextUsageData;
  stats: MemberStats | null;
  models: AvailableModelOption[];
  dm?: boolean;
}) {
  const hasUsage = contextUsage?.supported && contextUsage.percentage !== undefined;
  const pct = hasUsage ? Math.round(contextUsage.percentage!) : null;
  const totalTokens = stats ? stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite : 0;
  return (
    <PanelCard title="Status" tag={<AssetTag tone={dm ? "dm" : "room"}>{dm ? "this DM" : "this room"}</AssetTag>} hint={dm ? "Live state and cumulative activity for this member, in this DM." : "Live state and cumulative activity for this member, in this room."}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
        <StatSlot label="STATUS" value={statusLabel(status)} />
        <StatSlot label="MODEL" value={member.model ? compactModelId(member.model, models) : "—"} />
        <StatSlot label="CONTEXT" value={pct !== null ? `${pct}%` : "—"} detail={contextUsage?.totalTokens ? `${formatTokens(contextUsage.totalTokens)} tok` : undefined} />
        <StatSlot label="TOKENS · TOTAL" value={stats ? formatTokens(totalTokens) : "—"} detail="cumulative" />
        <StatSlot label="ACTIVE TIME" value={stats ? formatDuration(stats.activeMs) : "—"} detail="cumulative" />
        <StatSlot label="ACTIVITY" value={stats ? String(stats.turns) : "—"} detail={stats ? `turns · ${stats.toolCalls} tool calls` : undefined} />
      </div>
    </PanelCard>
  );
}

/** Overview memory block: budget usage only, no content (content lives in
 * Prompt assets). */
function MemoryBudgets({ principlesBudget, mainlineBudget }: { principlesBudget?: PromptAssetBudget; mainlineBudget?: PromptAssetBudget }) {
  return (
    <PanelCard title="Memory" tag={<AssetTag>principles · mainline</AssetTag>} hint="How full this member's persistent memory is. See Prompt assets for content.">
      <div className="space-y-2.5 mt-3">
        <div>
          <div className="flex items-center justify-between text-[11px] text-ink-4 mb-1"><span>Principles</span><span>{principlesBudget ? formatBudgetShort(principlesBudget) : "—"}</span></div>
          <BudgetBar budget={principlesBudget} />
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px] text-ink-4 mb-1"><span>Mainline</span><span>{mainlineBudget ? formatBudgetShort(mainlineBudget) : "—"}</span></div>
          <BudgetBar budget={mainlineBudget} />
        </div>
      </div>
    </PanelCard>
  );
}

function formatBudgetShort(budget: PromptAssetBudget): string {
  return `${formatTokens(budget.usage)}/${formatTokens(budget.limit)}`;
}

function BudgetBar({ budget }: { budget?: PromptAssetBudget }) {
  const pct = budget ? Math.max(2, Math.min(100, budget.pct)) : 0;
  const tone = !budget ? "bg-surface-3" : budget.overLimit ? "bg-blocked" : budget.pct >= 80 ? "bg-think" : "bg-accent";
  return (
    <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
      <div className={`h-full rounded-full transition-all ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function IdentityCard({ member }: { member: MemberInfo }) {
  const agentName = member.agent || member.sourceAgent || member.name;
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setAgent(null);
    setLoadFailed(false);
    getAgent(agentName)
      .then((detail) => { if (!cancelled) setAgent(detail); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [agentName]);
  // Agents without skills metadata legitimately have none (built-in templates ship without it).
  const skills = agent?.skills ?? [];
  const description = agent?.description ?? "";
  const rawText = [displayAgentLabel(agent?.name || agentName), description, skills.length ? `Skills: ${skills.join(", ")}` : ""].filter(Boolean).join("\n\n");
  return (
    <AccordionCard
      title="Identity"
      tag={<AssetTag>from Agent · stable</AssetTag>}
      hint={<>Who this member is. Defined by the <b className="text-ink-2">{displayAgentLabel(agentName)}</b> Agent template; identical across rooms that use it.</>}
      preview={description ? firstContentLine(description) : displayAgentLabel(agentName)}
      empty={loadFailed ? <EmptyAsset title="Agent template unavailable" hint="The Agent definition could not be loaded; this member still runs on its saved configuration." /> : !agent ? <div className="text-xs text-ink-4 py-1">Loading…</div> : undefined}
      renderContent={(view) => (
        <>
          <div className={`text-[12.5px] text-ink-2 leading-relaxed ${view === "raw" ? "whitespace-pre-wrap font-mono text-[12px]" : "preview-markdown"}`}>
            {view === "markdown" ? (
              <>
                <b className="text-ink-1">{displayAgentLabel(agent!.name)}</b>
                {description ? ` — ${description}` : ""}
              </>
            ) : rawText}
          </div>
          {skills.length > 0 && (
            <div className="mt-1.5 text-[11.5px] text-ink-4">
              Skills: {skills.map((skill) => <code key={skill} className="bg-surface-3 rounded px-1 py-0.5 text-[11px] mr-1">{skill}</code>)}
            </div>
          )}
        </>
      )}
    />
  );
}

/** Real, compiled Bossmode Core prompt — the platform-shared second block of
 * the prompt (Environment/Communication/Memory guidance). Sourced from the
 * same compiler the runtime uses; never a static/hardcoded preview. */
function CoreCard({ corePrompt }: { corePrompt: { content: string; charCount: number } | null }) {
  return (
    <AccordionCard
      title="Core"
      tag={<AssetTag>platform · shared</AssetTag>}
      hint="Bossmode Core — environment, communication and Memory guidance shared by every member. Same structure for all; only values (room/member names) differ."
      preview={corePrompt ? firstContentLine(corePrompt.content) : "Loading…"}
      defaultView="raw"
      empty={corePrompt === null ? <div className="text-xs text-ink-4 py-1">Loading…</div> : corePrompt.content.trim() ? undefined : <EmptyAsset title="Unavailable" hint="Could not load the compiled Core prompt for this member." />}
      renderContent={(view) => (
        <div className={`text-[13px] text-ink-2 leading-relaxed ${view === "raw" ? "whitespace-pre-wrap font-mono text-[12px]" : "preview-markdown"}`}>
          {view === "markdown" ? <Markdown content={corePrompt!.content} /> : corePrompt!.content}
        </div>
      )}
    />
  );
}

export function MemberConfigPanel({
  roomId,
  dmScope,
  activityScope,
  member,
  onJumpToMessage,
  status,
  contextUsage,
  existingMemberNames,
  models,
  mcpEnabled,
  mcpServers,
  mcpLoadStatus,
  onRetryMcp,
  onOpenMcpSettings,
  onClose,
  onRename,
  onSwitchModel,
  onSwitchThinking,
  onCompact,
  onReload,
  onRestart,
  onResetSession,
  onToggleMcp,
  stale,
  installedExtensions,
  extensionsLoadStatus,
  onRetryExtensions,
  onToggleExtension,
  onOpenExtensionsSettings,
}: {
  roomId: string;
  /** 0.20 flagship ②: when set the panel reads/writes the dm scope — data via
   * the members-shaped scope-addressed APIs, tags read "this DM", and the
   * room-principles layer (which does not exist for a DM) is hidden. */
  dmScope?: { scopeId: string; memberId: string };
  /** Topic page: Activity tab reads/watches this scope; config still uses roomId. */
  activityScope?: string;
  member: MemberInfo;
  status: string;
  contextUsage?: ContextUsageData;
  existingMemberNames: string[];
  models: AvailableModelOption[];
  mcpEnabled: boolean;
  mcpServers: McpServerSummary[];
  mcpLoadStatus: "loading" | "ready" | "error";
  onRetryMcp: () => void;
  onOpenMcpSettings: () => void;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
  onSwitchModel: (model: string | null, credentialId: string | null) => void;
  onSwitchThinking: (thinkingLevel: string | null) => void;
  onCompact: () => void;
  onReload: () => void | Promise<void>;
  onRestart: () => void;
  onResetSession: () => void;
  onToggleMcp: (server: string) => void;
  stale?: { mounts?: { since: number; fields: string[] }; contract?: boolean };
  installedExtensions: ExtensionRecord[];
  extensionsLoadStatus: "loading" | "ready" | "error";
  onRetryExtensions: () => void;
  onToggleExtension: (extId: string) => void;
  onOpenExtensionsSettings?: () => void;
  onJumpToMessage?: (messageId: string) => Promise<void>;
}) {
  const hasUsage = contextUsage?.supported && contextUsage.percentage !== undefined;
  const pct = hasUsage ? Math.round(contextUsage.percentage!) : 0;
  const statusText = statusLabel(status).toLowerCase();
  const mcpDisplayState = memberMcpDisplayState(mcpLoadStatus, mcpEnabled, mcpServers.length);
  const [tab, setTab] = useState<PanelTab>("overview");
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(member.name);
  const [savingName, setSavingName] = useState(false);
  const [roomPrinciples, setRoomPrinciples] = useState<Principles | null>(null);
  const [memberPrinciples, setMemberPrinciples] = useState<Principles | null>(null);
  const [mainline, setMainline] = useState<Mainline | null>(null);
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [corePrompt, setCorePrompt] = useState<{ content: string; charCount: number } | null>(null);
  const [activeToolsReloadKey, setActiveToolsReloadKey] = useState(0);

  useEffect(() => { setDraftName(member.name); setEditingName(false); setTab("overview"); setActiveToolsReloadKey((k) => k + 1); }, [member.id, member.name]);

  useEffect(() => {
    let cancelled = false;
    setRoomPrinciples(null);
    setMemberPrinciples(null);
    setMainline(null);
    if (dmScope) {
      // DM scope: member assets come from the members-shaped memory API; the
      // room-principles layer does not exist here (card hidden below).
      Promise.all([
        getMemberMemoryAsset(dmScope.memberId, "principles", dmScope.scopeId),
        getMemberMemoryAsset(dmScope.memberId, "mainline", dmScope.scopeId),
      ]).then(([principlesAsset, mainlineAsset]) => {
        if (cancelled) return;
        setMemberPrinciples(principlesAsset);
        setMainline(mainlineAsset as Mainline);
      }).catch(() => {
        if (cancelled) return;
        setMemberPrinciples({ content: "", revision: 0, contentHash: "", contentLength: 0 });
        setMainline({ content: "", revision: 0, contentHash: "", contentLength: 0, parsed: { focus: "", index: [] } });
      });
      return () => { cancelled = true; };
    }
    Promise.all([
      getRoomPrinciples(roomId),
      getMemberPrinciples(roomId, member.id || member.name),
      getMemberMainline(roomId, member.id || member.name),
    ]).then(([roomAsset, memberAsset, mainlineAsset]) => {
      if (cancelled) return;
      setRoomPrinciples(roomAsset);
      setMemberPrinciples(memberAsset);
      setMainline(mainlineAsset);
    }).catch(() => {
      if (cancelled) return;
      setRoomPrinciples({ content: "", revision: 0, contentHash: "", contentLength: 0 });
      setMemberPrinciples({ content: "", revision: 0, contentHash: "", contentLength: 0 });
      setMainline({ content: "", revision: 0, contentHash: "", contentLength: 0, parsed: { focus: "", index: [] } });
    });
    return () => { cancelled = true; };
  }, [roomId, member.id, member.name, dmScope?.scopeId, dmScope?.memberId]);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    const empty = { turns: 0, toolCalls: 0, activeMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
    const fetchStats = dmScope
      ? getMemberScopedStats(dmScope.memberId, dmScope.scopeId)
      : getMemberStats(member.id || member.name, roomId);
    fetchStats
      .then((result) => { if (!cancelled) setStats(result); })
      .catch(() => { if (!cancelled) setStats(empty); });
    return () => { cancelled = true; };
  }, [roomId, member.id, member.name, dmScope?.scopeId, dmScope?.memberId]);

  useEffect(() => {
    let cancelled = false;
    setCorePrompt(null);
    const fetchPrompt = dmScope
      ? getMemberCorePromptScoped(dmScope.memberId, dmScope.scopeId)
      : getMemberCorePrompt(roomId, member.id || member.name);
    fetchPrompt
      .then((result) => { if (!cancelled) setCorePrompt(result); })
      .catch(() => { if (!cancelled) setCorePrompt({ content: "", charCount: 0 }); });
    return () => { cancelled = true; };
  }, [roomId, member.id, member.name, dmScope?.scopeId, dmScope?.memberId]);

  const draftNameTrimmed = draftName.trim();
  const nameConflict = !!draftNameTrimmed && draftNameTrimmed.toLowerCase() !== member.name.toLowerCase() && existingMemberNames.some((name) => name.toLowerCase() === draftNameTrimmed.toLowerCase());
  const canSaveName = draftNameTrimmed && draftNameTrimmed !== member.name && !nameConflict && !savingName;
  const saveName = async () => {
    if (!canSaveName) return;
    setSavingName(true);
    try {
      await onRename(draftName.trim());
      setEditingName(false);
    } finally {
      setSavingName(false);
    }
  };

  // Tab badge and footer count the member's own assets (room principles are shared context,
  // not member assets): principles = 1, mainline = 2 (focus + index) per the approved prototype.
  const memberAssetCount = promptAssetCount([memberPrinciples, mainline]);
  const badgeCount = memberAssetCount === null
    ? null
    : (memberPrinciples!.content.trim() ? 1 : 0) + (mainline!.content.trim() ? 2 : 0);

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-5 flex flex-col gap-4 shrink-0">
        <header className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <StaffBadge name={member.name} status={statusFromAgent(status)} size="lg" stale={!!stale} staleTitle={stale ? [stale.contract && "App updated", stale.mounts && "Configuration changed"].filter(Boolean).join(" · ") + " — Reload to apply" : ""} />
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                {editingName ? (
                  <span className="flex items-center gap-1.5">
                    <input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void saveName(); if (e.key === "Escape") { setDraftName(member.name); setEditingName(false); } }}
                      className="w-40 bg-surface-3 border border-line rounded px-2 py-1 font-mono text-sm text-ink-1 focus:outline-none focus:border-line-strong"
                      placeholder="member-name"
                      autoFocus
                      disabled={savingName}
                    />
                    <button type="button" onClick={() => void saveName()} disabled={!canSaveName} className="px-2 py-1 rounded border border-line text-[11px] text-ink-2 hover:bg-surface-2 disabled:opacity-50 cursor-pointer">{savingName ? "Saving…" : "Save"}</button>
                    <button type="button" onClick={() => { setDraftName(member.name); setEditingName(false); }} className="px-2 py-1 rounded text-[11px] text-ink-4 hover:text-ink-1 cursor-pointer">Cancel</button>
                  </span>
                ) : (
                  <>
                    <div className="text-lg font-semibold text-ink-1 truncate">{member.name}</div>
                    <button
                      type="button"
                      title={status === "working" ? "Rename disabled while working" : "Rename member"}
                      onClick={() => setEditingName(true)}
                      disabled={status === "working"}
                      className="text-ink-4 hover:text-ink-1 disabled:opacity-40 transition-colors cursor-pointer shrink-0"
                    >
                      <Pencil size={12} />
                    </button>
                  </>
                )}
                <span className={`text-[10px] border rounded-full px-2 py-0.5 uppercase shrink-0 ${status === "working" ? "text-onair border-onair/30 bg-onair/10" : "text-ink-4 border-line bg-surface-2"}`}>{statusText}</span>
              </div>
              {editingName && nameConflict ? (
                <div className="text-[11px] text-blocked mt-1">This room already has a member named {draftNameTrimmed}. Pick another name.</div>
              ) : null}
              <div className="text-xs text-ink-4 mt-1 truncate">
                {displayAgentLabel(member.agent || member.sourceAgent || member.name)} · <span className="font-mono">@{member.name}</span>
                {member.createdAt ? ` · ${dmScope ? "member" : "in this room"} since ${formatSinceDate(member.createdAt)}` : ""}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} title="Close" className="p-1.5 rounded-lg text-ink-4 hover:text-ink-1 hover:bg-surface-2 transition-colors cursor-pointer"><X size={16} /></button>
          </div>
        </header>

        <div className="flex gap-1 rounded-xl border border-line-soft bg-inset p-1">
          {([["overview", "Overview"], ["assets", "Prompt assets"], ["activity", "Activity"], ["session", "Session & tools"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-[12.5px] font-semibold whitespace-nowrap transition-colors cursor-pointer ${tab === key ? "bg-surface-1 text-ink-1 border border-line-soft shadow-sm" : "text-ink-3 hover:text-ink-1 border border-transparent"}`}
            >
              {label}
              {key === "assets" && badgeCount !== null ? <span className="ml-1 text-[11px] font-normal text-ink-4">{badgeCount}</span> : null}
              {key === "session" && stale ? <span className="inline-block ml-1 w-1.5 h-1.5 rounded-full bg-blocked align-middle" title="Reload needed" /> : null}
            </button>
          ))}
        </div>
      </div>

      {tab === "activity" ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <ActivityTab
            roomId={roomId}
            agentName={member.name}
            dmScope={dmScope}
            activityScope={activityScope && member.id ? { scopeId: activityScope, memberId: member.id } : undefined}
          />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4">
        {tab === "overview" && (
          <div className="space-y-4 pb-6">
            <StatusGrid status={status} member={member} contextUsage={contextUsage} stats={stats} models={models} dm={!!dmScope} />
            <MemoryBudgets principlesBudget={memberPrinciples?.budget} mainlineBudget={mainline?.budget} />
            <PanelCard title="Model" tag={<AssetTag tone={dmScope ? "dm" : "room"}>{dmScope ? "this DM" : "this room"}</AssetTag>} hint={dmScope ? "Model and thinking level for this member in this DM. Applies on the next turn." : "Model and thinking level for this member in this room. Applies on the next turn."}>
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_170px] gap-2.5 items-start mt-3">
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
            </PanelCard>
          </div>
        )}

        {tab === "assets" && (
          <div className="space-y-4 pb-6">
            <IdentityCard member={member} />
            <CoreCard corePrompt={corePrompt} />
            <PrinciplesCard
              title="Principles"
              hint="Member-level principles. Injected into every prompt compile; takes effect on Reload / next activation."
              principles={memberPrinciples}
              full
              emptyTitle="Empty"
              emptyHint="Nothing curated yet."
            />
            <MainlineCard member={member} mainline={mainline} full onJumpToMessage={onJumpToMessage} />
            {!dmScope && (
              <AccordionCard
                title="Room principles"
                tag={<AssetTag>shared · leader-written</AssetTag>}
                budget={roomPrinciples?.budget}
                hint="Room-wide working rules, shared by all members."
                preview={roomPrinciples ? firstContentLine(roomPrinciples.content) : "Loading…"}
                empty={roomPrinciples === null ? <div className="text-xs text-ink-4 py-1">Loading…</div> : roomPrinciples.content.trim() ? undefined : <EmptyAsset title="Empty" hint="No room principles yet — the Room leader can write them in chat." />}
                renderContent={(view) => (
                  <div className={`text-[13px] text-ink-2 leading-relaxed ${view === "raw" ? "whitespace-pre-wrap font-mono text-[12px]" : "preview-markdown"}`}>
                    {view === "markdown" ? <Markdown content={roomPrinciples!.content} /> : roomPrinciples!.content}
                  </div>
                )}
              />
            )}
            <div className="flex items-start gap-2 rounded-lg border border-line-soft bg-surface-2 px-3 py-2 text-[11px] text-ink-3 leading-relaxed">
              <span className="font-extrabold text-accent-ink shrink-0">i</span>
              <span>Assets are written by the member through its own tools (<span className="font-mono">read/edit/write_memory</span>), with a recorded reason per change. To change them, just tell @{member.name} in chat — e.g. “remember to always run serial tests”.</span>
            </div>
          </div>
        )}

        {tab === "session" && (
          <div className="space-y-4 pb-6">
            {/* 1. Context & Session — always first, always expanded */}
            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-ink-1">Context &amp; Session</div>
                  <div className="text-xs text-ink-4 mt-0.5">Manage this member’s conversation context and apply recent changes.</div>
                </div>
              </div>
              {hasUsage ? (
                <div className="rounded-lg border border-line-soft bg-surface-1 p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs text-ink-4"><span>Context used</span><span>{pct}% · {formatTokens(contextUsage!.totalTokens || 0)}</span></div>
                  <div className="h-2 rounded-full bg-surface-3 overflow-hidden"><div className="h-full rounded-full bg-accent transition-all" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} /></div>
                  <div className="text-[11px] text-ink-4">Compact shortens conversation history. Reload applies recent prompt, principles, mainline, and tool changes.</div>
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
                    <div className="text-[11px] text-ink-3 leading-relaxed">Apply the latest prompts, principles, mainline and tools without clearing the conversation.</div>
                    {stale && <div className="mt-1">
                      {stale.contract && <div className="flex items-center gap-1.5 text-[11px] text-blocked leading-snug"><span className="w-1.5 h-1.5 rounded-full bg-blocked shrink-0" />App updated — Reload to apply; Reset if the update reworked the conversation contract.</div>}
                      {stale.mounts && <div className="flex items-center gap-1.5 text-[11px] text-blocked leading-snug"><span className="w-1.5 h-1.5 rounded-full bg-blocked shrink-0" />{(stale.mounts.fields || []).map(f => f === "mcpServers" ? "MCP servers" : "Extensions").join(" · ")} changed — Reload to apply.</div>}
                    </div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => { void Promise.resolve(onReload()).finally(() => setActiveToolsReloadKey((k) => k + 1)); }}
                    className="relative shrink-0 min-w-20 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-contrast shadow-sm cursor-pointer transition-opacity hover:opacity-90 active:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                  >
                    Reload
                    {stale && <span className="stale-dot" style={{ top: -3, right: -3 }} />}
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

              {!dmScope && (
              <details className="rounded-lg border border-line-soft bg-surface-1 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-ink-3 hover:text-ink-1">Troubleshooting</summary>
                <div className="mt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-line-soft pt-2">
                  <div className="text-[11px] text-ink-4 leading-relaxed">
                    If Reload does not resolve a stuck member, restart it.
                  </div>
                  <button onClick={onRestart} className="px-3 py-1.5 border border-line rounded-lg text-xs text-ink-2 hover:bg-surface-2 shrink-0 cursor-pointer">Restart member</button>
                </div>
              </details>
              )}
            </section>

            {/* 2–4. Tool sections — accordion, collapsed by default */}
            <ActiveToolsSection roomId={roomId} memberRef={member.id || member.name} status={status} reloadKey={activeToolsReloadKey} dmScope={dmScope} />

            <SessionSectionAccordion
              title="Extensions"
              summary={extensionsAccordionSummary(extensionsLoadStatus, installedExtensions, member.extensions || [])}
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
                    const enabledIds = member.extensions || [];
                    const checked = enabledIds.some((id) => id === ext.name || id === ext.id || id === `npm:${ext.name}` || ext.id.endsWith(id));
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
                        <button
                          type="button"
                          onClick={() => onToggleExtension(ext.name)}
                          className={`relative w-10 h-5 rounded-full transition-colors shrink-0 cursor-pointer ${checked ? "bg-accent" : "bg-surface-3"}`}
                          title={checked ? "Disable for this member" : "Enable for this member"}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </SessionSectionAccordion>

            <SessionSectionAccordion
              title="Tools"
              summary={mcpAccordionSummary(mcpDisplayState, mcpServers, member.mcpServers || [])}
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
                        className={`relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 cursor-pointer ${checked ? "bg-accent" : "bg-surface-3"}`}
                        title={invalid ? "This server needs attention in Settings" : unavailable ? "This server is not currently available" : checked ? "Disable for this member" : "Enable for this member"}
                      >
                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>
                  );
                })}
              </div>}
            </SessionSectionAccordion>
          </div>
        )}
      </div>
      )}
    </div>
  );
}


/** 1s-ticking "Ns" badge for running rows (mounted only while running). */
function LiveSeconds({ since }: { since: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((v) => v + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className="font-mono text-[9.5px] text-think shrink-0 tabular-nums">{s}s</span>;
}

// ── Card river feed (fish 2026-08-21 four points; prototype agent-visibility-v1 → v2 tab) ──

const FEED_PAGE_SIZE = 80;
const FEED_BUFFER_CAP = 160;
const RIVER_MAX_ITEMS = 40;

interface LiveStream { thinking: string; text: string; t0: number }

type RiverItem =
  | { kind: "group"; member: string; events: AgentEvent[]; toolEndMap: Record<string, AgentEvent>; firstTs: number; key: string }
  | { kind: "event"; member: string; event: AgentEvent; toolEnd?: AgentEvent; thinkSec?: number; firstTs: number; key: string };

function riverTs(e: AgentEvent): number {
  return typeof e.ts === "number" ? e.ts : 0;
}

/** One-line "what is this member doing right now" for the roster strip. A live
 * stream (thinking/reply deltas in flight) outranks the settled event scan;
 * idle members show "idle" regardless of history. */
function currentActivityLine(events: AgentEvent[], status: string, stream?: LiveStream): { kind: string; text: string; liveSince?: number } {
  if (stream && (stream.thinking || stream.text)) {
    return stream.text
      ? { kind: "running", text: "Replying…", liveSince: stream.t0 }
      : { kind: "thinking", text: "Thinking…", liveSince: stream.t0 };
  }
  if (status !== "working" && status !== "thinking") return { kind: "idle", text: "idle" };
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "agent_end") break;
    if (e.type === "tool_start") {
      const end = e.toolCallId ? events.slice(i + 1).find((x) => x.type === "tool_end" && x.toolCallId === e.toolCallId) : undefined;
      const tool = toolDisplay(e.toolName, e.args);
      const target = tool.detail || toolTarget(e.args) || "";
      if (!end) return { kind: "running", text: `${tool.label}${target ? ` · ${target}` : ""}`, liveSince: typeof e.ts === "number" ? e.ts : undefined };
      if (end.isError) return { kind: "error", text: `${tool.label} failed` };
      return { kind: "done", text: `${tool.label}${target ? ` · ${target}` : ""}` };
    }
    if (e.type === "compaction_start") return { kind: "running", text: "Compacting context", liveSince: typeof e.ts === "number" ? e.ts : undefined };
    if (e.type === "message_end" && e.text) return { kind: "reply", text: `Replied · ${truncateText(e.text, 48)}` };
    if (e.type === "message_end" && e.thinking) {
      const next = events.slice(i + 1).find((x) => typeof x.ts === "number");
      const elapsed = next && typeof e.ts === "number" ? Math.max(0, Math.round(((next.ts as number) - (e.ts as number)) / 1000)) : 0;
      return { kind: "thinking", text: elapsed > 0 ? `Thought for ${elapsed}s` : "Thought" };
    }
  }
  return { kind: "working", text: "Working…" };
}

function activityTone(kind: string): string {
  switch (kind) {
    case "running": return "text-accent-ink";
    case "thinking": return "text-think";
    case "error": return "text-blocked";
    case "working": return "text-onair";
    case "done":
    case "reply": return "text-ink-3";
    default: return "text-ink-4";
  }
}

/** Live streaming card (fish 2026-08-21 ②): thinking/reply deltas grow in
 * place; the block cursor pulses until message_end swaps in the settled cards. */
function StreamCard({ member, kind, text, t0 }: { member: string; kind: "think" | "reply"; text: string; t0: number }) {
  const isThink = kind === "think";
  return (
    <div className={`rounded-[10px] border bg-surface-1 ${isThink ? "border-think/40" : "border-onair/30"}`}>
      <div className="flex items-center gap-1.5 px-3 py-[8px]">
        <MemberDisc name={member} />
        <span className="text-[11px] font-bold text-ink-1 truncate max-w-[90px]">{member}</span>
        <span className={`text-[9.5px] font-extrabold tracking-[0.08em] uppercase ${isThink ? "text-think" : "text-onair"}`}>{isThink ? "Thinking" : "Replying"}</span>
        <span className={`text-[10px] font-bold animate-pulse ${isThink ? "text-think" : "text-onair"}`}>●</span>
        <LiveSeconds since={t0} />
        <span className="font-mono text-[10px] text-ink-4 ml-auto shrink-0">{formatEventTime(t0)}</span>
      </div>
      <div className={`border-t border-line-soft px-3 py-2.5 text-[12.5px] whitespace-pre-wrap break-words max-h-40 overflow-y-auto ${isThink ? "text-ink-3 italic" : "text-ink-2"}`}>
        {text}
        <span className={`inline-block w-[7px] h-[11px] align-[-1px] animate-pulse ${isThink ? "bg-think" : "bg-onair"}`} />
      </div>
    </div>
  );
}

/** One river card — the shared card language from the member Activity tab with
 * the member tag (fish ①). agent_start/end never reach the river (turn chrome). */
function RiverEventCard({ item }: { item: Extract<RiverItem, { kind: "event" }> }) {
  const { event, member, toolEnd } = item;
  const time = formatEventTime(typeof event.ts === "number" ? event.ts : undefined);
  if (event.type === "user_prompt") return <UserPromptCard event={event} time={time} query="" label="USER PROMPT" member={member} />;
  if (event.type === "user_steer") return <UserPromptCard event={event} time={time} query="" label="STEER" member={member} />;
  if (event.type === "tool_start" || event.type === "tool_end") {
    return <ToolCard event={event} toolEnd={toolEnd} diff={diffStatForTool(event)} time={time} query="" member={member} />;
  }
  if (event.type === "compaction_start" || event.type === "compaction_end") return <CompactionCard event={event} time={time} member={member} />;
  if (event.type === "message_end" && (event.thinking || event.text)) {
    return (
      <>
        {event.thinking ? <ThinkingTrace text={String(event.thinking)} elapsedSec={item.thinkSec} time={time} member={member} /> : null}
        {event.text ? <ReplyCard text={String(event.text)} time={time} member={member} clamp /> : null}
      </>
    );
  }
  const summary = summarizeAgentEvent(event);
  return (
    <div className="text-[11px] text-ink-4 px-1 py-0.5 flex items-center gap-1.5">
      <MemberDisc name={member} />
      <span className="truncate">{summary.label} {summary.detail}</span>
      <span className="font-mono text-ink-4 ml-auto shrink-0">{time}</span>
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

// ── Session & tools accordion helpers ───────────────────────────────────────

/** Collapsed-by-default section shell. Action buttons stay reachable when closed. */
function SessionSectionAccordion({
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

// ── Active tools (Session & tools) ──────────────────────────────────────────

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
  // Prefer builtin → bossmode → extension* → mcp*
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

function ActiveToolsSection({ roomId, memberRef, status, reloadKey, dmScope }: {
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
