import { useState, useEffect, useRef, useCallback } from "react";
import { Square, ChevronDown } from "lucide-react";
import {
  abortAgent, getMembers, getConfiguredModels, updateMember,
  type MemberInfo, type AvailableModelOption, type ContextUsageData,
} from "../api/client";
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

function statusTag(status: string): { label: string; cls: string } {
  switch (status) {
    case "working":
      return { label: "WORKING", cls: "text-onair bg-onair-dim" };
    case "thinking":
      return { label: "THINKING", cls: "text-think bg-think-dim" };
    case "idle":
      return { label: "IDLE", cls: "text-ink-3 bg-surface-2" };
    default:
      return { label: "OFF", cls: "text-ink-4 bg-surface-2" };
  }
}

/** 工位墙 — 每个 agent 一张工位卡：工牌 + 状态 + 模型热切换 + context 油量 + 快捷操作 */
export function StationPanel({ members, agentStatus, contextUsage, roomId, onOpenLens, unreadAgents }: StationPanelProps) {
  const { toast } = useDialog();
  const [memberInfos, setMemberInfos] = useState<Record<string, MemberInfo>>({});
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [openChip, setOpenChip] = useState<string | null>(null);

  useEffect(() => {
    getMembers()
      .then((all) => {
        const map: Record<string, MemberInfo> = {};
        for (const m of all) map[m.name] = m;
        setMemberInfos(map);
      })
      .catch(console.error);
  }, [members]);

  useEffect(() => {
    getConfiguredModels().then(setModels).catch(console.error);
  }, []);

  // 点击外部关闭模型弹层
  useEffect(() => {
    if (!openChip) return;
    const close = () => setOpenChip(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openChip]);

  const handleSwitchModel = useCallback(
    async (member: MemberInfo, model: string, credentialId: string) => {
      setOpenChip(null);
      try {
        const updated = await updateMember(member.id, { model, credentialId });
        setMemberInfos((prev) => ({ ...prev, [member.name]: updated }));
        toast(`${member.name} → ${model}（下一回合生效）`, "success");
      } catch (err: any) {
        toast(`切换失败: ${err.message}`, "error");
      }
    },
    [toast],
  );

  const workingCount = members.filter((m) => agentStatus[m] === "working").length;

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <div className="h-10 px-3.5 border-b border-line-soft flex items-center justify-between shrink-0">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-4">WORKSTATIONS</span>
        <span className="font-mono text-[10.5px] text-ink-4">
          <span className="text-onair">{workingCount}</span> / {members.length} on duty
        </span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {members.map((name) => {
          const status = agentStatus[name] || "inactive";
          const info = memberInfos[name];
          const usage = contextUsage[name];
          const hasUsage = usage?.supported && usage.percentage !== undefined;
          const pct = hasUsage ? Math.round(usage.percentage!) : 0;
          const tag = statusTag(status);
          const isBusy = status === "working";
          const hasUnread = unreadAgents?.has(name);
          const modelLabel = info?.model || "agent default";

          return (
            <div key={name} className="border-b border-line-soft px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <button onClick={() => onOpenLens?.(name)} className="cursor-pointer" title={`打开 ${name} 的工位`}>
                  <StaffBadge name={name} avatar={info ? undefined : undefined} status={statusFromAgent(status)} size="md" />
                </button>
                <div className="flex-1 min-w-0">
                  <button
                    onClick={() => onOpenLens?.(name)}
                    className="text-[12.5px] font-semibold text-ink-1 truncate cursor-pointer hover:text-accent-ink transition-colors flex items-center gap-1.5"
                  >
                    {name}
                    {hasUnread && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                  </button>
                  {/* 模型热切换 chip */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!info) return;
                        setOpenChip(openChip === name ? null : name);
                      }}
                      title="热切换模型 · 下一回合生效"
                      className="font-mono text-[10px] text-ink-4 hover:text-accent-ink hover:bg-accent-dim rounded px-1 -mx-1 py-px flex items-center gap-1 cursor-pointer transition-colors max-w-full"
                    >
                      <span className="truncate">{modelLabel}</span>
                      <ChevronDown size={9} className="shrink-0 opacity-70" />
                    </button>
                    {openChip === name && info && (
                      <ModelPop
                        align="right"
                        models={models}
                        current={{ model: info.model ?? null, credentialId: info.credentialId ?? null }}
                        onSelect={(model, credentialId) => handleSwitchModel(info, model, credentialId)}
                      />
                    )}
                  </div>
                </div>
                <span className={`text-[9.5px] font-semibold tracking-[0.05em] px-2 py-0.5 rounded-full shrink-0 ${tag.cls}`}>
                  {tag.label}
                </span>
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

              {/* context 油量表 */}
              <div className="flex items-center gap-2 mt-2.5">
                <div className="flex-1 h-[3px] rounded-full bg-surface-3 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      pct >= 85 ? "bg-think" : pct >= 95 ? "bg-blocked" : "bg-ink-3"
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

export function ModelPop({
  models,
  current,
  onSelect,
  align = "left",
}: {
  models: AvailableModelOption[];
  current: { model: string | null; credentialId: string | null };
  onSelect: (model: string, credentialId: string) => void;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const grouped = models.reduce<Record<string, AvailableModelOption[]>>((acc, m) => {
    const key = m.profileName || m.providerSlug;
    (acc[key] ||= []).push(m);
    return acc;
  }, {});

  return (
    <div
      ref={ref}
      onClick={(e) => e.stopPropagation()}
      className={`absolute top-full mt-1.5 z-30 bg-surface-3 border border-line-strong rounded-lg p-1.5 max-h-72 overflow-y-auto ${align === "right" ? "right-0 w-[204px]" : "left-0 w-[248px]"}`}
      style={{ boxShadow: "var(--shadow-pop)" }}
    >
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group}>
          <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold tracking-[0.05em] text-ink-4">{group}</div>
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
                <span className="truncate flex-1">{m.displayName || m.modelId}</span>
                {isCurrent && <span className="text-[9px] text-ink-4 shrink-0">当前</span>}
              </button>
            );
          })}
        </div>
      ))}
      {models.length === 0 && <p className="text-[11px] text-ink-4 px-2 py-2">无可用模型 — 先在 System → Models 配置凭证。</p>}
      <p className="text-[10px] text-ink-4 px-2 pt-1.5 pb-1 border-t border-line-soft mt-1 leading-relaxed">
        热切换：不中断当前回合，下一 turn 生效；可跨凭证/provider。
      </p>
    </div>
  );
}
