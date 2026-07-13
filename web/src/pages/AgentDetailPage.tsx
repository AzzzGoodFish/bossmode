import { useState, useEffect, useCallback } from "react";
import { ArrowLeft, Save, X, ChevronDown } from "lucide-react";
import { MobileTopBar } from "../components/MobileTopBar";
import {
  getAgent, updateAgent, deleteAgent, createAgent,
  getMembers, getRooms, getConfiguredModels, getRoomMembers, updateRoomMember,
  getAgentContextUsage, getMemberTokenUsage,
  type MemberInfo, type Room, type AvailableModelOption, type ContextUsageData,
} from "../api/client";
import { Markdown } from "../components/Markdown";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { ModelPop, ThinkingPop, thinkLevelTextClass } from "../components/StationPanel";
import { formatTokens } from "../components/StationPanel";
import { useDialog } from "../components/dialogs";

interface AgentDetailPageProps {
  name: string;
  onBack: () => void;
  isCreate?: boolean;
  onCreated?: (name: string) => void;
  onOpenMobileSidebar?: () => void;
  /** 跳转到房间；lensAgent 用于落地后直接打开该成员的工位镜头 */
  onOpenRoom?: (roomId: string, lensAgent?: string) => void;
}

interface DutyRow {
  member: MemberInfo;
  room: Room;
  status: string;
  usage?: ContextUsageData;
}

const btnCls =
  "px-3.5 py-1.5 text-xs font-medium border border-line rounded-md text-ink-2 hover:text-ink-1 hover:border-line-strong cursor-pointer transition-colors";

/** Team 页 — 员工档案：profile + meta strip + 跨房间在岗（含模型热切换）+ skills + prompt */
export function AgentDetailPage({ name, onBack, isCreate, onCreated, onOpenMobileSidebar, onOpenRoom }: AgentDetailPageProps) {
  const { toast, confirm } = useDialog();
  const [agentName, setAgentName] = useState(name);
  const [agentData, setAgentData] = useState<any>(null);
  const [content, setContent] = useState(isCreate ? "---\nname: \"\"\ndescription: \"\"\nmodel: \"sonnet\"\nskills: []\n---\n\n" : "");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(!isCreate);
  const [editing, setEditing] = useState(!!isCreate);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [promptExpanded, setPromptExpanded] = useState(false);

  // on-duty 数据
  const [duty, setDuty] = useState<DutyRow[]>([]);
  const [tokens30d, setTokens30d] = useState<number | null>(null);
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [chipAnchor, setChipAnchor] = useState<DOMRect | null>(null);
  const [openThinkingChip, setOpenThinkingChip] = useState<string | null>(null);
  const [thinkingAnchor, setThinkingAnchor] = useState<DOMRect | null>(null);

  const loadAgent = () => {
    setLoading(true);
    getAgent(name)
      .then((agent) => {
        setAgentData(agent);
        const raw = reconstructMarkdown(agent);
        setContent(raw);
        setOriginalContent(raw);
      })
      .catch((err) => { console.error("Failed to load Agent", err); toast("Couldn’t load this Agent. Try again.", "error"); })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isCreate) loadAgent();
  }, [name, isCreate]);

  // 加载跨房间在岗：members(agent==name) × rooms(含该 member)
  const loadDuty = useCallback(async () => {
    if (isCreate) return;
    try {
      const [allMembers, allRooms] = await Promise.all([getMembers(), getRooms()]);
      const mine = allMembers.filter((m) => m.agent === name);
      const mineNames = new Set(mine.map((m) => m.name));
      const rows: DutyRow[] = [];
      await Promise.all(allRooms.map(async (r) => {
        const names = r.members.filter((memberName) => mineNames.has(memberName));
        if (names.length === 0) return;
        const effectiveMembers = await getRoomMembers(r.id).catch(() => mine.filter((m) => names.includes(m.name)));
        for (const m of effectiveMembers) {
          if (!mineNames.has(m.name)) continue;
          rows.push({ member: m, room: r, status: r.agentStatuses?.[m.name] || "inactive" });
        }
      }));
      setDuty(rows);
      // context usage（逐行拉取，失败忽略）
      rows.forEach((row, i) => {
        getAgentContextUsage(row.room.id, row.member.name)
          .then((usage) => setDuty((prev) => prev.map((p, j) => (j === i ? { ...p, usage } : p))))
          .catch(() => {});
      });
      // token 用量合计
      const usages = await Promise.all(
        mine.map((m) => getMemberTokenUsage(m.id).then((u) => u.totalTokens).catch(() => 0)),
      );
      setTokens30d(usages.reduce((a, b) => a + b, 0));
    } catch (err) {
      console.error(err);
    }
  }, [name, isCreate]);

  useEffect(() => { loadDuty(); }, [loadDuty]);
  useEffect(() => {
    if (!isCreate) getConfiguredModels().then(setModels).catch(console.error);
  }, [isCreate]);

  // 点击外部关闭模型弹层
  useEffect(() => {
    if (!openChip) return;
    const close = () => { setOpenChip(null); setChipAnchor(null); };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openChip]);

  const handleSwitchModel = async (roomId: string, member: MemberInfo, model: string, credentialId: string) => {
    setOpenChip(null);
    setChipAnchor(null);
    try {
      await updateRoomMember(roomId, member.name, { model, credentialId });
      toast(`${member.name} model updated for this Room. It applies on the next turn.`, "success");
      loadDuty();
    } catch (err) {
      console.error("Failed to update member model", err);
      toast("Couldn’t update the model. Check the connection in Settings → Models, then try again.", "error");
    }
  };

  const handleSwitchThinking = async (roomId: string, member: MemberInfo, thinkingLevel: string | null) => {
    setOpenThinkingChip(null);
    setThinkingAnchor(null);
    try {
      await updateRoomMember(roomId, member.name, { thinkingLevel });
      toast(`${member.name} thinking level updated for this Room.`, "success");
      loadDuty();
    } catch (err) {
      console.error("Failed to update thinking level", err);
      toast("Couldn’t update the thinking level. Try again.", "error");
    }
  };

  const handleSave = async () => {
    setSaveState("saving");
    try {
      if (isCreate) {
        if (!agentName) { toast("Name is required", "error"); setSaveState("idle"); return; }
        await createAgent(agentName, content);
        onCreated?.(agentName);
      } else {
        await updateAgent(name, content);
        setOriginalContent(content);
        setEditing(false);
        loadAgent();
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err: any) {
      console.error("Failed to save Agent", err);
      toast("Couldn’t save this Agent. Check the required fields, then try again.", "error");
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm(`Delete agent "${name}"? This cannot be undone.`))) return;
    try { await deleteAgent(name); onBack(); }
    catch (err) { console.error("Failed to delete Agent", err); toast("Couldn’t delete this Agent. Try again.", "error"); }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setEditing(false);
    setSaveState("idle");
  };

  const isBuiltin = agentData?.tags?.includes("builtin");
  const anyWorking = duty.some((d) => d.status === "working");
  const skills: string[] = agentData?.skills ?? [];

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-ink-4 text-sm">Loading…</div>;
  }

  /* ---- 编辑 / 创建模式：保持 markdown 源编辑 ---- */
  if (editing) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
        <MobileTopBar title={isCreate ? "New Agent" : name} onOpenSidebar={onOpenMobileSidebar || (() => {})} />
        <div className="flex-1 flex flex-col min-h-0 w-full max-w-[880px] mx-auto px-6 md:px-9 py-6">
          <div className="flex items-center justify-between mb-4 shrink-0">
            <div className="flex items-center gap-3">
              <button onClick={isCreate ? onBack : handleCancel} className="text-ink-4 hover:text-ink-1 transition-colors cursor-pointer">
                <ArrowLeft size={17} />
              </button>
              {isCreate ? (
                <input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="agent-name"
                  autoFocus
                  className="text-base font-semibold text-ink-1 bg-transparent border-b border-line focus:border-accent outline-none px-1"
                />
              ) : (
                <h1 className="text-base font-semibold text-ink-1">{name}</h1>
              )}
              <span className="text-[10px] font-semibold tracking-[0.05em] text-think bg-think-dim px-2 py-0.5 rounded-full">EDITING</span>
            </div>
            <div className="flex items-center gap-2">
              {!isCreate && (
                <button onClick={handleCancel} className={`flex items-center gap-1.5 ${btnCls}`}>
                  <X size={13} /> Cancel
                </button>
              )}
              <button
                onClick={handleSave}
                disabled={saveState === "saving" || (isCreate && !agentName)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-md bg-accent text-accent-contrast cursor-pointer disabled:opacity-40 transition-opacity"
              >
                <Save size={13} />
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "✓ Saved" : saveState === "error" ? "✗ Failed" : isCreate ? "Create" : "Save"}
              </button>
            </div>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full bg-inset border border-line rounded-lg px-4 py-3 text-base md:text-xs text-ink-2 font-mono leading-relaxed resize-none focus:outline-none focus:border-line-strong overflow-y-auto"
          />
        </div>
      </div>
    );
  }

  /* ---- 档案模式 ---- */
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
      <MobileTopBar title={name} onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="w-full max-w-[880px] mx-auto px-6 md:px-9 pt-7 pb-16">

          {/* Profile header */}
          <div className="flex items-start gap-4.5">
            <StaffBadge name={name} avatar={agentData?.avatar} status={anyWorking ? "working" : "idle"} size="lg" />
            <div className="min-w-0">
              <h2 className="text-[19px] font-semibold tracking-tight text-ink-1 flex items-center gap-2.5 flex-wrap">
                {name}
                {isBuiltin && (
                  <span className="text-[10px] font-semibold tracking-[0.05em] px-2 py-0.5 rounded-full bg-accent-dim text-accent-ink">
                    BUILT-IN
                  </span>
                )}
              </h2>
              <p className="text-[13px] text-ink-2 mt-1 max-w-[560px]">{agentData?.description || "No description"}</p>
            </div>
            {!isBuiltin && (
              <div className="ml-auto flex gap-2 shrink-0">
                <button onClick={() => setEditing(true)} className={btnCls}>Edit</button>
                <button onClick={handleDelete} className={`${btnCls} hover:!text-blocked hover:!border-blocked/40`}>Delete</button>
              </div>
            )}
          </div>

          {/* Meta strip */}
          <div className="flex flex-wrap gap-x-6 gap-y-3 py-3.5 mt-4.5 mb-5 border-y border-line-soft">
            <Meta k="DEFAULT MODEL" v={agentData?.model || "—"} mono />
            <Meta k="SKILLS" v={skills.length ? skills.join(" · ") : "—"} />
            <Meta k="IN ROOMS" v={duty.length ? `${duty.length} Room${duty.length === 1 ? "" : "s"}` : "Not in a Room"} />
            <Meta k="TOKENS" v={tokens30d != null ? formatTokens(tokens30d) : "—"} mono />
          </div>

          {/* On-duty table */}
          <h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 mb-2.5">
            ROOM MEMBERS
          </h3>
          {duty.length === 0 ? (
            <p className="text-xs text-ink-4 border border-line rounded-lg px-4 py-5 bg-surface-0/40">
              This Agent is not used in any Room yet. Add a member in a Room and choose this Agent.
            </p>
          ) : (
            <div className="border border-line rounded-lg bg-surface-1 overflow-x-auto">
              <div className="min-w-[640px]">
                <div className="grid grid-cols-[1fr_1.5fr_92px_0.9fr_130px] gap-3 items-center px-4 py-2 bg-surface-2 rounded-t-lg">
                  {["ROOM", "MODEL · CREDENTIAL", "STATUS", "CONTEXT", ""].map((h, i) => (
                    <span key={i} className="text-[10px] font-semibold tracking-[0.06em] text-ink-4">{h}</span>
                  ))}
                </div>
                {duty.map((row) => {
                  const chipKey = `${row.room.id}:${row.member.id}`;
                  const pct = row.usage?.supported && row.usage.percentage !== undefined ? Math.round(row.usage.percentage) : null;
                  return (
                    <div key={chipKey} className="grid grid-cols-[1fr_1.5fr_92px_0.9fr_130px] gap-3 items-center px-4 py-2.5 border-t border-line-soft">
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium text-ink-2 truncate">{row.room.name}</div>
                        <div className="font-mono text-[10px] text-ink-4 truncate">~{row.room.cwd.replace(/^\/home\/[^/]+/, "")}</div>
                      </div>
                      <div className="relative min-w-0 flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenThinkingChip(null);
                            setThinkingAnchor(null);
                            if (openChip === chipKey) {
                              setOpenChip(null);
                              setChipAnchor(null);
                            } else {
                              setOpenChip(chipKey);
                              setChipAnchor(e.currentTarget.getBoundingClientRect());
                            }
                          }}
                          title={`${row.member.model || "agent default"} · This room only`}
                          className="font-mono text-[10.5px] text-ink-3 hover:text-accent-ink hover:bg-accent-dim rounded px-1.5 -mx-1.5 py-0.5 flex items-center gap-1 cursor-pointer transition-colors min-w-0"
                        >
                          <span className="truncate">{row.member.model || "agent default"}</span>
                          <ChevronDown size={9} className="shrink-0 opacity-70" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenChip(null);
                            setChipAnchor(null);
                            if (openThinkingChip === chipKey) {
                              setOpenThinkingChip(null);
                              setThinkingAnchor(null);
                            } else {
                              setOpenThinkingChip(chipKey);
                              setThinkingAnchor(e.currentTarget.getBoundingClientRect());
                            }
                          }}
                          title={`think · ${row.member.thinkingLevel || "off"} · This room only`}
                          className="font-mono text-[9.5px] text-ink-4 hover:text-accent-ink hover:bg-accent-dim rounded border border-line-soft/70 px-1.5 py-0.5 cursor-pointer transition-colors shrink-0"
                        >
                          think <span className={`font-semibold ${thinkLevelTextClass(row.member.thinkingLevel || "off")}`}>{row.member.thinkingLevel || "off"}</span>
                        </button>
                        {openChip === chipKey && (
                          <ModelPop
                            anchorRect={chipAnchor}
                            models={models}
                            current={{ model: row.member.model ?? null, credentialId: row.member.credentialId ?? null }}
                            onClose={() => { setOpenChip(null); setChipAnchor(null); }}
                            onSelect={(model, credentialId) => handleSwitchModel(row.room.id, row.member, model, credentialId)}
                          />
                        )}
                        {openThinkingChip === chipKey && (
                          <ThinkingPop
                            anchorRect={thinkingAnchor}
                            currentThinking={row.member.thinkingLevel || "off"}
                            onClose={() => { setOpenThinkingChip(null); setThinkingAnchor(null); }}
                            onSelect={(thinkingLevel) => handleSwitchThinking(row.room.id, row.member, thinkingLevel)}
                          />
                        )}
                      </div>
                      <StatusTag status={row.status} />
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-[3px] rounded-full bg-surface-3 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pct !== null && pct >= 85 ? "bg-think" : "bg-ink-3"}`}
                            style={{ width: `${pct ?? 0}%` }}
                          />
                        </div>
                        <span className="font-mono text-[10px] text-ink-4 whitespace-nowrap">
                          {pct !== null ? `${pct}%${row.usage?.totalTokens ? ` · ${formatTokens(row.usage.totalTokens)}` : ""}` : "—"}
                        </span>
                      </div>
                      <div className="flex gap-1.5 justify-end">
                        <DutyBtn onClick={() => onOpenRoom?.(row.room.id)}>Open room</DutyBtn>
                        <DutyBtn onClick={() => onOpenRoom?.(row.room.id, row.member.name)}>Lens</DutyBtn>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Skills */}
          {skills.length > 0 && (
            <>
              <h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 mt-7 mb-2.5">SKILLS</h3>
              <div className="flex gap-2 flex-wrap">
                {skills.map((s) => (
                  <span key={s} className="text-[11.5px] text-ink-2 border border-line rounded-full px-3 py-1">{s}</span>
                ))}
              </div>
            </>
          )}

          {/* Prompt */}
          <h3 className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 mt-7 mb-2.5">PROMPT</h3>
          {isBuiltin && !agentData?.systemPrompt ? (
            <p className="text-xs text-ink-4 border border-line rounded-lg px-4 py-4 bg-inset">
              This built-in general Agent uses the standard prompt and takes its role from the conversation. It cannot be edited or deleted.
            </p>
          ) : (
            <div className={`relative border border-line rounded-lg bg-inset px-4 py-3.5 ${promptExpanded ? "" : "max-h-[180px] overflow-hidden"}`}>
              <div className="text-xs text-ink-2 leading-relaxed [&_pre]:bg-transparent">
                <Markdown content={agentData?.systemPrompt || ""} />
              </div>
              {!promptExpanded && (
                <div className="absolute inset-x-0 bottom-0 h-16 rounded-b-lg bg-gradient-to-t from-[var(--inset)] to-transparent flex items-end justify-center pb-2">
                  <button onClick={() => setPromptExpanded(true)} className="text-[11px] text-accent-ink cursor-pointer">Show full prompt</button>
                </div>
              )}
              {promptExpanded && (
                <button onClick={() => setPromptExpanded(false)} className="block mx-auto mt-2 text-[11px] text-accent-ink cursor-pointer">Collapse</button>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] tracking-[0.04em] text-ink-4 mb-0.5">{k}</div>
      <div className={`text-[12.5px] text-ink-2 truncate ${mono ? "font-mono text-[11.5px]" : ""}`}>{v}</div>
    </div>
  );
}

function StatusTag({ status }: { status: string }) {
  const cls =
    status === "working" ? "text-onair bg-onair-dim"
    : status === "idle" ? "text-ink-3 bg-surface-2"
    : "text-ink-4 bg-surface-2";
  const label = status === "working" ? "WORKING" : status === "idle" ? "IDLE" : "OFF";
  return (
    <span className={`text-[10px] font-semibold tracking-[0.05em] px-2 py-0.5 rounded-full justify-self-start whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}

function DutyBtn({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="border border-line text-ink-3 text-[10.5px] font-medium px-2.5 py-1 rounded-md hover:text-accent-ink hover:border-line-strong cursor-pointer transition-colors whitespace-nowrap"
    >
      {children}
    </button>
  );
}

function reconstructMarkdown(agent: any): string {
  const meta: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
    model: agent.model,
  };
  if (agent.skills?.length) meta.skills = agent.skills;
  if (agent.tags?.length) meta.tags = agent.tags;
  if (agent.avatar) meta.avatar = agent.avatar;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      if (value.length > 0) {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  return `---\n${lines.join("\n")}\n---\n\n${agent.systemPrompt}`;
}
