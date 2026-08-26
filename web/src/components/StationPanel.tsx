import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Activity, Square, ChevronDown, ChevronRight, Pencil, X } from "lucide-react";
import {
  abortAgent, getRoomMembers, getConfiguredModels, updateRoomMember, getAgentEventsPaginated, getConversationEvents, getToken, getMcpSettings, restartMember, resetAgentSession, steerAgent,
  getMemberStats, getMemberCorePrompt, getMemberActiveTools, getExtensions, getMemberProfile, getMemberSkills,
  getMemberScopedStats, getMemberCorePromptScoped, getConversationTools,
  type MemberInfo, type AvailableModelOption, type ContextUsageData, type McpServerSummary, type MemberProfileDoc, type MemberSkillEntry, type MemberStats, type ExtensionRecord, type MemberActiveTool,
} from "../api/client";
import { formatRelativeTime, formatSinceDate, budgetTone, promptAssetCount } from "../utils/member-panel-view";
import { formatTokens, compactModelId, memberModelAvailabilityLabel, statusLabel } from "./member-scope";

import { ToggleSwitch } from "./ToggleSwitch";
import { Markdown } from "./Markdown";
import { diffStatForTool, formatEventTime, isActivityStreamEvent, summarizeAgentEvent, type AgentEvent } from "./agent-event-utils";
import type { AgentStatusMap } from "../hooks/useRoom";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { ModelPicker, modelProfileLabel } from "./ModelPicker";
import { useDialog } from "./dialogs";
import { ActivityTab, ThinkingTrace, ToolCard, ReplyCard, UserPromptCard, CompactionCard, MemberDisc } from "./ActivityTab";

interface StationPanelProps {
  members: string[];
  agentStatus: AgentStatusMap;
  contextUsage: Record<string, ContextUsageData>;
  roomId: string;
  /** Topic page: activity reads/watches this scope; member config still uses roomId. */
  activityScope?: string;
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
  onMembersChanged?: () => void;
  unreadAgents?: Set<string> | null;
  onJumpToMessage?: (messageId: string) => Promise<void>;
  /** Member-page merge v1: roster detail opens navigate to the member page
   * (scope = this room); the room-side Sheet is retired. */
  onOpenMember?: (member: MemberInfo) => void;
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

/** Room member stations with status, model controls, context usage, and actions. */
export function StationPanel({ members, agentStatus, contextUsage, roomId, activityScope, onOpenMcpSettings, onOpenExtensionsSettings, onMembersChanged, unreadAgents, onJumpToMessage, onOpenMember }: StationPanelProps) {
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
  const [filterPopOpen, setFilterPopOpen] = useState(false);
  const [filterAnchor, setFilterAnchor] = useState<DOMRect | null>(null);
  const feedScrollRef = useRef<HTMLDivElement>(null);
  const feedPinnedRef = useRef(true);
  // Card-river live streams (fish 2026-08-21 ②): message_update deltas are on
  // the WS already (never persisted); accumulate per member, flush to state at
  // 60ms so delta bursts don't churn the rail. Stream cards are a live preview
  // — on reload only settled cards render (REST has finals only).
  const [liveStreams, setLiveStreams] = useState<Record<string, LiveStream>>({});
  const streamBufRef = useRef<Record<string, LiveStream>>({});
  // Exact thinking durations measured at seal time (text delta #1) — the
  // river's settled THOUGHT card prefers these over any estimate.
  const sealedThinkRef = useRef<Record<string, { sec: number; at: number }>>({});
  const streamFlushRef = useRef<number | null>(null);
  const [showNewBtn, setShowNewBtn] = useState(false);
  // Roster height (fish 2026-08-21: roster/feed divider is draggable): null =
  // auto (content capped at 42%), px after first drag; persisted.
  const [rosterH, setRosterH] = useState<number | null>(() => {
    const v = Number(localStorage.getItem(ROSTER_H_KEY));
    return Number.isFinite(v) && v >= 64 && v <= 480 ? v : null;
  });
  const [rosterDragging, setRosterDragging] = useState(false);
  const rosterRef = useRef<HTMLDivElement>(null);
  const rosterDragRef = useRef({ y: 0, h: 160 });
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





  const eventWatchId = activityScope || roomId;

  // A+ fusion feed (fish 2026-08-20): each member's raw activity stream, kept
  // per member and merged into turn blocks at render. Same visibility filter
  // as the member Activity tab (isActivityStreamEvent).
  const loadFeedEvents = useCallback(async (name: string) => {
    try {
      const result = activityScope
        ? await getConversationEvents(activityScope, name, FEED_PAGE_SIZE)
        : await getAgentEventsPaginated(roomId, name, FEED_PAGE_SIZE);
      setFeedEvents((prev) => ({ ...prev, [name]: (result.events as AgentEvent[]).filter((e) => isActivityStreamEvent(e) || e.type === "message_start").slice(-FEED_PAGE_SIZE) }));
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
          // Also kept in the event buffer (never rendered) — settled thinking
          // cards derive their honest duration from message_end − message_start.
          const display = typeof event.ts === "number" ? event : { ...event, ts: Date.now() };
          setFeedEvents((prev) => ({ ...prev, [agent]: [...(prev[agent] || []), display].slice(-FEED_BUFFER_CAP) }));
          return;
        }
        if (event.type === "message_update") {
          const cur = streamBufRef.current[agent] || { thinking: "", text: "", t0: Date.now() };
          if (typeof event.thinking === "string") cur.thinking += event.thinking;
          if (typeof event.text === "string") {
            // First text delta seals thinking (fish 2026-08-21: thinking and
            // replying must never be live at once — the model emits thinking
            // blocks before text within a message).
            if (cur.thinking && cur.thinkingDoneAt === undefined) {
              cur.thinkingDoneAt = typeof event.ts === "number" ? event.ts : Date.now();
              sealedThinkRef.current[agent] = { sec: Math.max(1, Math.round((cur.thinkingDoneAt - cur.t0) / 1000)), at: cur.thinkingDoneAt };
            }
            cur.text += event.text;
          }
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

  useEffect(() => { if (rosterH !== null) localStorage.setItem(ROSTER_H_KEY, String(rosterH)); }, [rosterH]);
  useEffect(() => {
    if (!rosterDragging) return;
    document.body.style.userSelect = "none";
    return () => { document.body.style.userSelect = ""; };
  }, [rosterDragging]);

  const closePops = useCallback(() => {
    setOpenChip(null);
    setChipAnchor(null);
    setOpenThinkingChip(null);
    setThinkingAnchor(null);
  }, []);

  /** Card river (fish 2026-08-21): flat one-line cards, each self-tagged with
   * its member. No turn headers, no agent start/end rows, no tool grouping
   * (fish ruling: every tool call is its own single-line card). */
  const riverItems = useMemo<RiverItem[]>(() => {
    const names = feedFilter && members.includes(feedFilter) ? [feedFilter] : members;
    const items: RiverItem[] = [];
    for (const name of names) {
      const events = feedEvents[name] || [];
      const endMap: Record<string, AgentEvent> = {};
      for (const e of events) if (e.type === "tool_end" && e.toolCallId) endMap[e.toolCallId] = e;
      const paired = (e: AgentEvent) => !!e.toolCallId && events.some((s) => s.type === "tool_start" && s.toolCallId === e.toolCallId);
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.type === "agent_start" || e.type === "agent_end" || e.type === "message_start") continue;
        if (e.type === "tool_end" && paired(e)) continue; // rendered inside its tool_start card
        // Thinking-duration ladder (fish 2026-08-21: THOUGHT FOR Ns must show a
        // real number whenever one honestly exists — the gap estimate collapses
        // to 0 when thinking and text settle in a single message):
        // ① live seal measurement ② message_start→end ③ gap to the next event.
        let thinkSec: number | undefined;
        if (e.type === "message_end" && e.thinking && typeof e.ts === "number") {
          const sealed = sealedThinkRef.current[name];
          if (sealed && e.ts >= sealed.at - 2000 && e.ts - sealed.at < 120_000) thinkSec = sealed.sec;
          if (thinkSec === undefined) {
            for (let j = i - 1; j >= 0; j--) {
              const p = events[j];
              if (p.type === "message_start" && typeof p.ts === "number") {
                const d = Math.round((e.ts - (p.ts as number)) / 1000);
                if (d > 0) thinkSec = d;
                break;
              }
              if (p.type === "message_end" || p.type === "agent_end") break; // never cross a message boundary
            }
          }
          if (thinkSec === undefined) {
            const next = events.slice(i + 1).find((n) => typeof n.ts === "number");
            if (next) {
              const g = Math.round(((next.ts as number) - e.ts) / 1000);
              if (g > 0) thinkSec = g;
            }
          }
        }
        items.push({ kind: "event", member: name, event: e, toolEnd: e.type === "tool_end" ? e : e.toolCallId ? endMap[e.toolCallId] : undefined, thinkSec, firstTs: riverTs(e), key: `${name}:e:${e.ts ?? "x"}:${i}` });
      }
    }
    items.sort((a, b) => a.firstTs - b.firstTs);
    return items.slice(-RIVER_MAX_ITEMS);
  }, [feedEvents, members, feedFilter]);

  /** Live stream cards ride at the river's tail (the forming edge). */
  /** Live stream cards ride at the river's tail (the forming edge). Thinking
   * seals into a quiet "Thought for Ns" the moment reply text starts. */
  const streamCards = useMemo(() => {
    const names = feedFilter && members.includes(feedFilter) ? [feedFilter] : members;
    return names.flatMap((name) => {
      const s = liveStreams[name];
      if (!s || (!s.thinking && !s.text)) return [];
      const cards: Array<{ name: string; s: LiveStream; kind: "think" | "reply" }> = [];
      if (s.thinking && s.thinkingDoneAt === undefined) cards.push({ name, s, kind: "think" });
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



  const workingCount = members.filter((m) => agentStatus[m] === "working").length;

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <div className="h-10 px-3.5 border-b border-line-soft flex items-center justify-between shrink-0">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-4">WORKSTATIONS</span>
        <span className="font-mono text-[10.5px] text-ink-4">
          <span className="text-onair">{workingCount}</span> / {members.length} on duty
        </span>
      </div>

      {/* Roster — compact two-line strips (fish 2026-08-21): line 1 = name +
       * model/think/⋯ config, line 2 = state summary (Thinking…/Replying…/bash/
       * idle, no arg details). Row click = feed filter; avatar & name = detail. */}
      <div
        ref={rosterRef}
        className={`shrink-0 overflow-y-auto ${rosterH === null ? "max-h-[42%]" : ""}`}
        style={rosterH !== null ? { height: rosterH } : undefined}
        onScroll={closePops}
      >
        {members.map((name) => {
          const status = agentStatus[name] || "inactive";
          const info = memberInfos[name];
          const isBusy = status === "working";
          const hasUnread = unreadAgents?.has(name);
          const activity = currentActivityLine(feedEvents[name] || [], status, liveStreams[name]);
          const usage = contextUsage?.[name];
          const cardTitle = info?.title || null;
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
            <div key={name} className="relative border-b border-line-soft last:border-b-0 transition-colors">
              <div
                role="button"
                tabIndex={0}
                onClick={() => { if (info) onOpenMember?.(info); }}
                onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && info) { e.preventDefault(); onOpenMember?.(info); } }}
                title={`${name} detail — memory, session & tools`}
                className="flex items-center gap-2 px-3 py-[6px] cursor-pointer select-none hover:bg-surface-2 transition-colors"
              >
                {/* fish 2026-08-21: the avatar ring carries CONTEXT USAGE
                 * (fill = %, tone heats at 70/90); numbers live in a hover
                 * bubble ("10% · 100k / 1000k"). Live status → 5-o'clock dot —
                 * two rings on one badge read as mud. */}
                <RosterAvatar
                  name={name}
                  status={status}
                  usage={usage}
                  onOpen={() => { if (info) onOpenMember?.(info); }}
                />
                <div className="flex-1 min-w-0">
                  {/* line 1: name + model/think/⋯ — usage numbers live in the
                   * avatar's hover bubble (fish 2026-08-21: inline % crowded the row). */}
                  <div className="flex items-center gap-0.5 min-w-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); if (info) onOpenMember?.(info); }}
                      className="text-[12.5px] leading-none font-semibold text-ink-1 truncate flex items-center gap-1.5 cursor-pointer hover:text-accent-ink transition-colors shrink-0 max-w-[40%]"
                      title={cardTitle ? `Configure ${name} · ${cardTitle}` : `Configure ${name}`}
                    >
                      <span className="truncate">{name}</span>
                      {hasUnread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                    </button>
                    {info && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenThinkingChip(null);
                            setThinkingAnchor(null);
                            if (openChip === name) { setOpenChip(null); setChipAnchor(null); }
                            else { setOpenChip(name); setChipAnchor(e.currentTarget.getBoundingClientRect()); }
                          }}
                          title={modelChipTitle}
                          className={`font-mono text-[10px] leading-none rounded px-1 py-px cursor-pointer transition-colors truncate min-w-0 max-w-[104px] hover:bg-accent-dim ${
                            !isConfigured || !modelAvailable ? "text-think" : "text-ink-4 hover:text-accent-ink"
                          }`}
                        >
                          {modelChipLabel} ▾
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenChip(null);
                            setChipAnchor(null);
                            if (openThinkingChip === name) { setOpenThinkingChip(null); setThinkingAnchor(null); }
                            else { setOpenThinkingChip(name); setThinkingAnchor(e.currentTarget.getBoundingClientRect()); }
                          }}
                          title={`think · ${info.thinkingLevel || "off"} · This room only`}
                          className="font-mono text-[10px] leading-none rounded px-1 py-px cursor-pointer transition-colors shrink-0 text-ink-4 hover:text-accent-ink hover:bg-accent-dim"
                        >
                          think <span className={`font-semibold ${thinkLevelTextClass(info.thinkingLevel || "default")}`}>{info.thinkingLevel || "default"}</span> ▾
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); if (info) onOpenMember?.(info); }}
                          title={`${name} detail — memory, session & tools`}
                          className="font-mono text-[10px] leading-none rounded px-1 py-px cursor-pointer transition-colors shrink-0 text-ink-4 hover:text-ink-1 hover:bg-surface-2"
                        >
                          ⋯
                        </button>
                      </>
                    )}
                  </div>
                  {/* line 2: state summary */}
                  <div className={`mt-[3px] font-mono text-[10.5px] leading-none truncate ${activityTone(activity.kind)}`}>
                    {activity.text}{activity.liveSince !== undefined && <> · <LiveSeconds since={activity.liveSince} /></>}
                  </div>
                </div>
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
          );
        })}
      </div>

      {/* Roster/feed divider — draggable (fish 2026-08-21). The small centered
       * pill is the persistent affordance that marks this divider as draggable
       * (static borders carry no mark). */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize member list"
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
          rosterDragRef.current = { y: e.clientY, h: rosterRef.current?.getBoundingClientRect().height ?? 160 };
          setRosterDragging(true);
        }}
        onPointerMove={(e) => {
          if (!rosterDragging) return;
          const parent = rosterRef.current?.parentElement;
          const max = parent ? Math.round(parent.getBoundingClientRect().height * 0.6) : 480;
          const next = Math.max(64, Math.min(max, Math.round(rosterDragRef.current.h + (e.clientY - rosterDragRef.current.y))));
          setRosterH(next);
        }}
        onPointerUp={() => setRosterDragging(false)}
        onDoubleClick={() => setRosterH(null)}
        className={`relative h-[7px] -mt-[3px] shrink-0 cursor-row-resize z-10 border-b border-line group ${rosterDragging ? "bg-accent/20" : ""}`}
      >
        {/* Pill hugs the line's top face (roster side) — same rule as the rail
         * divider: the handle belongs to the pane it resizes (fish 2026-08-21). */}
        <span className={`absolute bottom-[1px] left-1/2 -translate-x-1/2 w-6 h-[3px] rounded-full transition-colors ${rosterDragging ? "bg-accent" : "bg-ink-4/40 group-hover:bg-accent/60"}`} />
      </div>

      {/* Merged activity feed — every member's turns interleaved by time; the
       * rail itself is the progress console (no separate Activity chrome). */}
      <div className="h-8 px-3 flex items-center gap-1.5 shrink-0">
        <Activity size={10} className="text-ink-4 shrink-0" aria-hidden />
        <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-4 uppercase shrink-0">Activity ·</span>
        {/* The filter lives on the content it filters (fish 2026-08-21): the
         * roster-strip click coupling had zero affordance — you found it by
         * misclicking. Strip click now opens the member detail instead. */}
        <button
          onClick={(e) => {
            if (filterPopOpen) { setFilterPopOpen(false); setFilterAnchor(null); }
            else { setFilterAnchor(e.currentTarget.getBoundingClientRect()); setFilterPopOpen(true); }
          }}
          title="Filter the activity feed by member"
          className={`flex items-center gap-[3px] text-[10px] font-semibold tracking-[0.06em] uppercase truncate rounded px-1 py-0.5 -my-0.5 cursor-pointer transition-colors ${feedFilter && members.includes(feedFilter) ? "text-accent-ink hover:bg-accent-dim" : "text-ink-4 hover:text-ink-1 hover:bg-surface-2"}`}
        >
          {feedFilter && members.includes(feedFilter) ? feedFilter : "all members"}
          <ChevronDown size={9} aria-hidden />
        </button>
        {feedFilter && members.includes(feedFilter) && (
          <button onClick={() => setFeedFilter(null)} className="text-[10px] font-semibold text-accent-ink hover:underline cursor-pointer shrink-0">× clear</button>
        )}
      </div>
      {filterPopOpen && (
        <FilterPop
          members={members}
          current={feedFilter}
          anchorRect={filterAnchor}
          onSelect={(m) => { setFeedFilter(m); setFilterPopOpen(false); setFilterAnchor(null); }}
          onClose={() => { setFilterPopOpen(false); setFilterAnchor(null); }}
        />
      )}
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
            {riverItems.map((item) => <RiverEventCard key={item.key} item={item} />)}
            {/* Sealed thinking (fish: thinking settles when reply starts) rides
             * above the live reply card, already in its final quiet form. */}
            {(feedFilter && members.includes(feedFilter) ? [feedFilter] : members).flatMap((name) => {
              const s = liveStreams[name];
              if (!s || !s.thinking || s.thinkingDoneAt === undefined || !s.text) return [];
              const sec = Math.max(1, Math.round((s.thinkingDoneAt - s.t0) / 1000));
              return [<ThinkingTrace key={`sealed:${name}`} text={s.thinking} elapsedSec={sec} time={formatEventTime(s.thinkingDoneAt)} member={name} />];
            })}
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
  return <span className="font-mono text-[9.5px] leading-none text-think shrink-0 tabular-nums">{s}s</span>;
}

// ── Card river feed (fish 2026-08-21 four points; prototype agent-visibility-v1 → v2 tab) ──

const FEED_PAGE_SIZE = 80;
const FEED_BUFFER_CAP = 160;
const RIVER_MAX_ITEMS = 40;
const ROSTER_H_KEY = "bossmode.roster.height";

interface LiveStream { thinking: string; text: string; t0: number; thinkingDoneAt?: number }

type RiverItem = { kind: "event"; member: string; event: AgentEvent; toolEnd?: AgentEvent; thinkSec?: number; firstTs: number; key: string };

function riverTs(e: AgentEvent): number {
  return typeof e.ts === "number" ? e.ts : 0;
}

/** One-line "what is this member doing right now" for the roster strip
 * (fish 2026-08-21: summary only — Thinking…/Replying…/tool name, never args).
 * A live stream outranks the settled event scan; idle members show "idle". */
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
      const toolName = String(e.toolName || "tool");
      if (!end) return { kind: "running", text: toolName, liveSince: typeof e.ts === "number" ? e.ts : undefined };
      if (end.isError) return { kind: "error", text: `${toolName} failed` };
      return { kind: "done", text: toolName };
    }
    if (e.type === "compaction_start") return { kind: "running", text: "Compacting", liveSince: typeof e.ts === "number" ? e.ts : undefined };
    if (e.type === "message_end" && e.text) return { kind: "reply", text: "Replied" };
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
  // Fish 2026-08-21 ④: a streaming body follows its own tail while the user
  // stays near the bottom of it (same pin rule as the feed).
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  // Uniform chevron slot — a live card collapses to its header like any other.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className={`rounded-[10px] border bg-surface-1 ${isThink ? "border-think/40" : "border-onair/30"}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-center px-3 py-[8px] text-left cursor-pointer">
        <ChevronRight size={11} className={`text-ink-4 shrink-0 transition-transform mr-[4px] ${open ? "rotate-90" : ""}`} />
        <span className="flex items-center gap-[5px] shrink-0 min-w-0">
          <MemberDisc name={member} />
          <span className="text-[11px] font-bold leading-none text-ink-1 truncate max-w-[90px]">{member}</span>
        </span>
        <span className={`text-[9.5px] leading-none font-extrabold tracking-[0.08em] uppercase ml-[7px] mr-[4px] ${isThink ? "text-think" : "text-onair"}`}>{isThink ? "Thinking" : "Replying"}</span>
        <span className={`w-1.5 h-1.5 rounded-full animate-pulse shrink-0 mr-[4px] ${isThink ? "bg-think" : "bg-onair"}`} />
        <LiveSeconds since={t0} />
        <span className="font-mono text-[10px] leading-none text-ink-4 ml-auto pl-[6px] shrink-0">{formatEventTime(t0)}</span>
      </button>
      {open && (
        <div
          ref={bodyRef}
          onScroll={() => {
            const el = bodyRef.current;
            if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className={`border-t border-line-soft px-3 py-2.5 text-[12.5px] whitespace-pre-wrap break-words max-h-40 overflow-y-auto ${isThink ? "text-ink-3 italic" : "text-ink-2"}`}
        >
          {text}
          <span className={`inline-block w-[7px] h-[11px] align-[-1px] animate-pulse ${isThink ? "bg-think" : "bg-onair"}`} />
        </div>
      )}
    </div>
  );
}

/** One river card — the shared card language from the member Activity tab with
 * the member tag (fish ①). agent_start/end never reach the river (turn chrome). */
function RiverEventCard({ item }: { item: Extract<RiverItem, { kind: "event" }> }) {
  const { event, member, toolEnd } = item;
  const time = formatEventTime(typeof event.ts === "number" ? event.ts : undefined);
  if (event.type === "user_prompt") return <UserPromptCard event={event} time={time} query="" label="USER PROMPT" member={member} compact />;
  if (event.type === "user_steer") return <UserPromptCard event={event} time={time} query="" label="STEER" member={member} compact />;
  if (event.type === "tool_start" || event.type === "tool_end") {
    return <ToolCard event={event} toolEnd={toolEnd} diff={diffStatForTool(event)} time={time} query="" member={member} compact />;
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


/** Roster avatar = badge button + hover usage bubble (fish 2026-08-21:
 * "10% · 100k / 1000k" on hover, not inline). Bubble replaces the native
 * title when usage data exists (no double tooltips). */
function RosterAvatar({ name, status, usage, onOpen }: {
  name: string;
  status: string;
  usage?: ContextUsageData;
  onOpen: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [bubble, setBubble] = useState<DOMRect | null>(null);
  const enterTimer = useRef<number | null>(null);
  const usagePct = usage && usage.supported && !usage.unavailable && typeof usage.percentage === "number" ? Math.max(0, Math.round(usage.percentage)) : null;
  const usageTone: "ok" | "warn" | "over" | null = usagePct === null ? null : usagePct >= 90 ? "over" : usagePct >= 70 ? "warn" : "ok";
  const open = () => {
    if (usagePct === null || !btnRef.current) return;
    enterTimer.current = window.setTimeout(() => setBubble(btnRef.current!.getBoundingClientRect()), 150);
  };
  const close = () => {
    if (enterTimer.current !== null) { window.clearTimeout(enterTimer.current); enterTimer.current = null; }
    setBubble(null);
  };
  useEffect(() => () => { if (enterTimer.current !== null) window.clearTimeout(enterTimer.current); }, []);
  return (
    <>
      <button
        ref={btnRef}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => { e.stopPropagation(); onOpen(); }}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        className="cursor-pointer rounded-full shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        title={usagePct === null ? `Configure ${name} · ${statusLabel(status)}` : undefined}
        aria-label={`Configure ${name} · ${statusLabel(status)}${usagePct !== null ? ` · context ${usagePct}%` : ""}`}
      >
        <RosterBadge name={name} status={status} usagePct={usagePct} usageTone={usageTone} />
      </button>
      {bubble && usagePct !== null && usage && createPortal(
        <div
          className="fixed z-50 flex items-center gap-1 bg-surface-3 border border-line-strong rounded-lg px-2 py-1.5 font-mono text-[10.5px] leading-none whitespace-nowrap pointer-events-none"
          style={{ left: Math.min(bubble.left, window.innerWidth - 168), top: bubble.bottom + 6, boxShadow: "var(--shadow-pop)" }}
        >
          <span className={`font-semibold ${usageTone === "over" ? "text-blocked" : usageTone === "warn" ? "text-think" : "text-accent-ink"}`}>{usagePct}%</span>
          <span className="text-ink-3">
            · {typeof usage.totalTokens === "number" ? formatTokens(usage.totalTokens) : "?"} / {typeof usage.rawMaxTokens === "number" ? formatTokens(usage.rawMaxTokens) : "?"}
          </span>
          {usage.compacted && <span className="text-ink-4">· compacted</span>}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Roster avatar cell (fish 2026-08-21): the ring carries CONTEXT USAGE
 * (fill = percentage, tone heats amber ≥70 / red ≥90); the member's live
 * status becomes a 5-o'clock presence dot — two stacked rings read as mud.
 * No usage data (provider silent) → plain disc, no fake track. */
function RosterBadge({ name, status, usagePct, usageTone }: {
  name: string;
  status: string;
  usagePct: number | null;
  usageTone: "ok" | "warn" | "over" | null;
}) {
  const R = 11.5;
  const C = 2 * Math.PI * R;
  const stroke = usageTone === "over" ? "var(--blocked)" : usageTone === "warn" ? "var(--thinking)" : "var(--accent)";
  const dim = status !== "working" && status !== "idle";
  return (
    <span className="relative block w-[26px] h-[26px] shrink-0">
      {usagePct !== null && (
        <svg width="26" height="26" viewBox="0 0 26 26" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="13" cy="13" r={R} fill="none" stroke="var(--line)" strokeWidth="1.5" opacity="0.5" />
          <circle cx="13" cy="13" r={R} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(100, usagePct)) / 100)} />
        </svg>
      )}
      <span className={`absolute inset-[3px] rounded-full flex items-center justify-center font-semibold select-none text-[9px] ${dim ? "bg-surface-2 text-ink-4 opacity-70" : "bg-surface-3 text-ink-2"}`}>
        {name.charAt(0).toUpperCase()}
      </span>
      {status === "working" && <span className="absolute bottom-[1px] right-[1px] w-1.5 h-1.5 rounded-full bg-onair animate-pulse ring-1 ring-surface-1" />}
    </span>
  );
}

/** Activity-feed member filter pop (fish 2026-08-21): opened from the
 * "all members ▾" control in the feed header. Same pop family as ModelPop. */
function FilterPop({ members, current, anchorRect, onSelect, onClose }: {
  members: string[];
  current: string | null;
  anchorRect: DOMRect | null;
  onSelect: (member: string | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = 172;
  const gap = 6;
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const onResize = () => onClose();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const row = (label: string, value: string | null) => (
    <button
      key={label}
      onClick={() => onSelect(value)}
      className={`w-full flex items-center gap-2 text-left text-[11.5px] px-2 py-1.5 rounded cursor-pointer transition-colors ${current === value ? "bg-accent-dim text-accent-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1"}`}
    >
      {value ? <MemberDisc name={value} /> : <Activity size={10} className="text-ink-4 shrink-0" aria-hidden />}
      <span className="truncate flex-1">{label}</span>
      {current === value && <span className="text-[10px] shrink-0">✓</span>}
    </button>
  );

  const content = (
    <>
      <div className="px-2 pt-1.5 pb-1 text-[9px] font-semibold tracking-[0.05em] text-ink-4">FILTER ACTIVITY</div>
      <div className="flex flex-col gap-px px-1 pb-1">
        {row("All members", null)}
        {members.map((m) => row(m, m))}
      </div>
    </>
  );

  if (!anchorRect) {
    return <div ref={ref} onClick={(e) => e.stopPropagation()} className="absolute top-full mt-1.5 z-30 bg-surface-3 border border-line-strong rounded-lg p-1.5" style={{ width, boxShadow: "var(--shadow-pop)" }}>{content}</div>;
  }
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.left));
  const opensUp = window.innerHeight - anchorRect.bottom < 220 && anchorRect.top > 220;
  const vertical = opensUp ? { bottom: window.innerHeight - anchorRect.top + gap } : { top: anchorRect.bottom + gap };
  return createPortal(
    <div ref={ref} onClick={(e) => e.stopPropagation()} className="fixed z-50 bg-surface-3 border border-line-strong rounded-lg p-1.5" style={{ left, width, ...vertical, boxShadow: "var(--shadow-pop)" }}>
      {content}
    </div>,
    document.body,
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

