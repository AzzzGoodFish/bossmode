import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Square, ChevronDown } from "lucide-react";
import {
  abortAgent, getRoomMembers, getConfiguredModels, updateRoomMember, getAgentEventsPaginated, getToken,
  type MemberInfo, type AvailableModelOption, type ContextUsageData,
} from "../api/client";
import { formatEventTime, isStationActionEvent, summarizeAgentEvent, toolTarget, truncateText, type AgentEvent } from "./agent-event-utils";
import type { AgentStatusMap } from "../hooks/useRoom";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { useDialog } from "./dialogs";

interface StationPanelProps {
  members: string[];
  agentStatus: AgentStatusMap;
  contextUsage: Record<string, ContextUsageData>;
  roomId: string;
  onOpenLens?: (agentName: string) => void;
  unreadAgents?: Set<string> | null;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
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

export function thinkLevelTextClass(level?: string | null): string {
  switch (level || "default") {
    case "minimal": return "think-level-minimal";
    case "low": return "think-level-low";
    case "medium": return "think-level-medium";
    case "high": return "think-level-high";
    case "xhigh": return "think-level-xhigh";
    case "off":
    case "default":
    default:
      return "think-level-default";
  }
}

/** 工位墙 — 每个 agent 一张工位卡：工牌 + 状态 + 模型热切换 + context 油量 + 快捷操作 */
export function StationPanel({ members, agentStatus, contextUsage, roomId, onOpenLens, unreadAgents }: StationPanelProps) {
  const { toast } = useDialog();
  const [memberInfos, setMemberInfos] = useState<Record<string, MemberInfo>>({});
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [chipAnchor, setChipAnchor] = useState<DOMRect | null>(null);
  const [openThinkingChip, setOpenThinkingChip] = useState<string | null>(null);
  const [thinkingAnchor, setThinkingAnchor] = useState<DOMRect | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [recentEvents, setRecentEvents] = useState<Record<string, AgentEvent[]>>({});

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

  // 点击外部关闭模型弹层
  useEffect(() => {
    if (!openChip) return;
    const close = () => { setOpenChip(null); setChipAnchor(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openChip]);

  const handleSwitchModel = useCallback(
    async (member: MemberInfo, model: string, credentialId: string) => {
      setOpenChip(null);
      try {
        const updated = await updateRoomMember(roomId, member.name, { model, credentialId });
        setMemberInfos((prev) => ({ ...prev, [member.name]: updated }));
        toast(`${member.name} → ${model}（下一回合生效）`, "success");
      } catch (err: any) {
        toast(`切换失败: ${err.message}`, "error");
      }
    },
    [roomId, toast],
  );


  const loadRecentEvents = useCallback(async (name: string) => {
    try {
      const result = await getAgentEventsPaginated(roomId, name, 40);
      const stationEvents = (result.events as AgentEvent[]).filter(isStationDisplayEvent).slice(-8);
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
        setRecentEvents((prev) => ({ ...prev, [data.agent]: [...(prev[data.agent] || []), event].slice(-8) }));
      } catch {}
    };
    return () => ws.close();
  }, [roomId, members.join("\u0000")]);

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
          const modelLabel = info?.model || "agent default";

          return (
            <div key={name} className="border-b border-line-soft px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onOpenLens?.(name)}
                  className="cursor-pointer rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  title={`打开 ${name} 工位 · ${statusLabel(status)}`}
                >
                  <StaffBadge name={name} avatar={info ? undefined : undefined} status={statusFromAgent(status)} size="md" />
                </button>
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => onOpenLens?.(name)}
                    className="text-[12.5px] font-semibold text-ink-1 truncate flex items-center gap-1.5 cursor-pointer hover:text-accent-ink transition-colors max-w-full"
                    title={`打开 ${name} 工位`}
                  >
                    <span className="truncate">{name}</span>
                    {hasUnread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                  </button>
                  {/* 当前 room 的模型 + thinking 配置 chips */}
                  <div className="relative flex items-center gap-1 min-w-0 max-w-full">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!info) return;
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
                      title={`${modelLabel} · This room only`}
                      className="font-mono text-[10px] text-ink-4 hover:text-accent-ink hover:bg-accent-dim rounded px-1 -mx-1 py-px flex-1 cursor-pointer transition-colors min-w-0 truncate text-left"
                    >
                      {modelLabel}
                    </button>
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
                        onClose={() => { setOpenThinkingChip(null); setThinkingAnchor(null); }}
                        onSelect={(thinkingLevel) => {
                          setOpenThinkingChip(null);
                          setThinkingAnchor(null);
                          updateRoomMember(roomId, info.name, { thinkingLevel })
                            .then((updated) => {
                              setMemberInfos((prev) => ({ ...prev, [info.name]: updated }));
                              toast(`${info.name} thinking → ${thinkingLevel ?? "default"}`, "success");
                            })
                            .catch((err: any) => toast(`切换失败: ${err.message}`, "error"));
                        }}
                      />
                    )}
                  </div>
                </div>
                {isBusy && (
                  <button
                    onClick={() => abortAgent(roomId, name).catch(console.error)}
                    className="w-5 h-5 flex items-center justify-center rounded text-ink-4 hover:text-blocked transition-colors cursor-pointer shrink-0"
                    title={`Abort ${name}`}
                  >
                    <Square size={9} fill="currentColor" />
                  </button>
                )}
              </div>

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

              {/* context 油量表 */}
              <div className="flex items-center gap-2 mt-2.5">
                <div className="flex-1 h-[3px] rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      pct >= 95 ? "bg-blocked" : pct >= 85 ? "bg-think" : "bg-ink-3"
                    }`}
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
    </div>
  );
}


function isStationDisplayEvent(event: AgentEvent): boolean {
  return isStationActionEvent(event) || event.type === "tool_end";
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
    if (endEvent.toolCallId && event.toolCallId === endEvent.toolCallId) return true;
    if (endEvent.toolName && event.toolName === endEvent.toolName) return true;
    return false;
  });
}

function toolEndDetail(event: AgentEvent, events: AgentEvent[] = []): string {
  const matchingStart = findMatchingToolStart(events, event);
  return toolTarget(matchingStart?.args) || toolTarget(event.args) || (event.isError ? safeEventDetail(event.result ?? event.text) : safeEventDetail(event.result ?? event.text)) || String(event.toolName || "tool");
}

function stationSummary(event?: AgentEvent, events: AgentEvent[] = []): { kind: string; label: string; detail: string; ts?: number; pulse?: boolean; tag?: string } {
  if (!event) return { kind: "idle", label: "IDLE", detail: "No recent activity" };
  const ts = typeof event.ts === "number" ? event.ts : undefined;
  if (event.type === "tool_start") {
    return { kind: "running", label: String(event.toolName || "tool"), detail: toolTarget(event.args) || "running", ts, pulse: true };
  }
  if (event.type === "tool_end") {
    return {
      kind: event.isError ? "error" : "done",
      label: String(event.toolName || "tool"),
      detail: toolEndDetail(event, events),
      ts,
      tag: event.isError ? "ERROR" : undefined,
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
  if (kind === "working") return "bg-onair opacity-80";
  if (kind === "thinking") return "bg-think";
  if (kind === "reply") return "bg-ink-3";
  return "bg-ink-4";
}

function ActionLine({ name, status, events, expanded, onToggle }: { name: string; status: string; events: AgentEvent[]; expanded: boolean; onToggle: () => void }) {
  const summary = latestStationSummary(events);
  const isWorkingWithoutEvent = status === "working" && summary.kind === "idle";
  const label = isWorkingWithoutEvent ? "WORKING" : status === "working" && summary.label === "REPLY" ? "DRAFT" : summary.label;
  const time = summary.ts ? formatEventTime(summary.ts) : "";
  const detail = isWorkingWithoutEvent ? "Waiting for activity" : status === "working" && label === "DRAFT" ? summary.detail : summary.kind === "reply" && time ? `${summary.detail} · ${time}` : summary.detail;
  const visualKind = isWorkingWithoutEvent ? "working" : summary.kind;
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
      {summary.tag && <span className="text-[8.5px] font-bold tracking-[0.08em] text-blocked border border-blocked/25 rounded-full px-1.5 py-px shrink-0">{summary.tag}</span>}
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
        {summary.tag && <span className="text-[8.5px] font-bold tracking-[0.08em] text-blocked border border-blocked/25 rounded-full px-1.5 py-px shrink-0">{summary.tag}</span>}
        {!summary.tag && time && <span className="font-mono text-[9.5px] text-ink-4 shrink-0">{time}</span>}
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
    const key = m.profileName || m.providerSlug;
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
                {isCurrent && <span className="text-[9px] text-ink-4 shrink-0">当前</span>}
              </button>
            );
          })}
        </div>
      ))}
      {models.length === 0 && <p className="text-[11px] text-ink-4 px-2 py-2">无可用模型 — 先在 System → Models 配置凭证。</p>}
      <p className="text-[10px] text-ink-4 px-2 pt-1.5 pb-1 border-t border-line-soft mt-1 leading-relaxed">
        模型配置仅作用于当前房间工位；不中断当前回合，下一 turn 生效。
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

export function ThinkingPop({
  currentThinking,
  anchorRect = null,
  onSelect,
  onClose,
}: {
  currentThinking: string;
  anchorRect?: DOMRect | null;
  onSelect: (thinkingLevel: string | null) => void;
  onClose?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = 200;
  const gap = 6;
  const levels: Array<{ label: string; value: string | null }> = [
    { label: "default", value: null },
    { label: "off", value: "off" },
    { label: "minimal", value: "minimal" },
    { label: "low", value: "low" },
    { label: "medium", value: "medium" },
    { label: "high", value: "high" },
    { label: "xhigh", value: "xhigh" },
  ];

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
      <p className="text-[10px] text-ink-4 px-2 pt-1.5 pb-1 border-t border-line-soft mt-1 leading-relaxed">仅当前房间工位生效。</p>
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
