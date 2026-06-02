import { useState, useEffect } from "react";
import { Plus, Search, ArrowLeft, Save, Trash2, RefreshCw } from "lucide-react";
import { MobileTopBar } from "../components/MobileTopBar";
import type { MemberInfo, AgentInfo, MemberInstanceInfo, ModelOption } from "../api/client";
import { getMemberModelBadge } from "../model-helpers";
import { ModelPicker } from "../components/ModelPicker";
import {
  getMembers, createMember, getMember, updateMember, deleteMemberApi,
  getAgents, getAgent, getMemberStatus, restartMember, getConfiguredModels, getMemberTokenUsage,
} from "../api/client";
import { useDialog } from "../components/dialogs";

interface MembersPageProps {
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onRefresh?: () => void;
  onNavigateAgent?: (name: string) => void;
  onOpenMobileSidebar?: () => void;
}



export function MembersPage({ selectedId: propSelectedId, onSelect, onRefresh, onNavigateAgent, onOpenMobileSidebar }: MembersPageProps) {
  const { toast, confirm } = useDialog();
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(propSelectedId ?? null);
  const [showCreate, setShowCreate] = useState(propSelectedId === null);
  const [configuredModels, setConfiguredModels] = useState<ModelOption[]>([]);
  const [configuredModelsLoaded, setConfiguredModelsLoaded] = useState(false);

  useEffect(() => {
    if (propSelectedId !== undefined) {
      setSelectedId(propSelectedId);
      setShowCreate(propSelectedId === null);
    }
  }, [propSelectedId]);

  useEffect(() => { getMembers().then(setMembers).catch(console.error); }, []);

  useEffect(() => {
    getConfiguredModels()
      .then((loadedModels) => setConfiguredModels(loadedModels))
      .catch(() => setConfiguredModels([]))
      .finally(() => setConfiguredModelsLoaded(true));
  }, []);

  const refresh = () => { getMembers().then(setMembers); onRefresh?.(); };

  const handleDelete = async (m: MemberInfo) => {
    if (!(await confirm(`Delete member "${m.name}"? If this member is used in a room, it will become inactive.`))) return;
    try { await deleteMemberApi(m.id); refresh(); } catch (err: any) { toast(err.message, "error"); }
  };

  const filtered = members.filter((m) =>
    m.name.toLowerCase().includes(search.toLowerCase()) ||
    m.agent.toLowerCase().includes(search.toLowerCase()) ||
    (m.model || "").toLowerCase().includes(search.toLowerCase())
  );

  const modelDisplay = (member: MemberInfo) => member.model || "Use agent default";

  // Create mode
  if (propSelectedId === null && showCreate) {
    return <MemberDetailView
      id={null}
      isCreate
      onBack={() => { setShowCreate(false); onSelect?.(undefined as any); refresh(); }}
      onCreated={(newId) => { setSelectedId(newId); onSelect?.(newId); refresh(); }}
      onNavigateAgent={onNavigateAgent}
      configuredModels={configuredModels}
      configuredModelsLoaded={configuredModelsLoaded}
    />;
  }

  if (selectedId) {
    return <MemberDetailView
      id={selectedId}
      onBack={() => { setSelectedId(null); refresh(); }}
      onNavigateAgent={onNavigateAgent}
      configuredModels={configuredModels}
      configuredModelsLoaded={configuredModelsLoaded}
    />;
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title="Members" onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-white">Members</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{members.length} configured members</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg cursor-pointer">
          <Plus size={14} /> New Member
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
        <input autoComplete="off" type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search members..."
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600 placeholder:text-zinc-600" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((m) => (
          <div key={m.id} className="group relative bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors cursor-pointer"
            onClick={() => setSelectedId(m.id)}>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(m); }}
              className="absolute top-2 right-2 text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
              title="Delete member"
            >
              <Trash2 size={14} />
            </button>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">{m.avatar || "👤"}</span>
              <span className="font-semibold text-white text-sm">{m.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                {getMemberModelBadge(m.model || null, m.credentialId || null, configuredModels)}
              </span>
            </div>
            <div className="text-xs text-zinc-500">Model: {modelDisplay(m)}</div>
            <div className="text-xs text-zinc-600">Agent: {m.agent}</div>
          </div>
        ))}
      </div>

    </div>
    </div>
  );
}

function MemberDetailView({ id, onBack, isCreate, onCreated, onNavigateAgent, configuredModels, configuredModelsLoaded }: {
  id: string | null;
  onBack: () => void;
  isCreate?: boolean;
  onCreated?: (id: string) => void;
  onNavigateAgent?: (name: string) => void;
  configuredModels: ModelOption[];
  configuredModelsLoaded: boolean;
}) {
  const { toast, confirm } = useDialog();
  const [member, setMember] = useState<MemberInfo | null>(isCreate ? {} as MemberInfo : null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [form, setForm] = useState<Partial<MemberInfo>>(isCreate ? { model: undefined, thinkingLevel: "off" } : {});
  const models = configuredModels;
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [agentDetail, setAgentDetail] = useState<{ description: string; skills: string[]; avatar?: string } | null>(null);
  const [instances, setInstances] = useState<MemberInstanceInfo[]>([]);
  const [totalTokens, setTotalTokens] = useState<number | null>(null);


  const refreshStatus = () => {
    if (id) getMemberStatus(id).then((s) => setInstances(s.instances)).catch(() => setInstances([]));
  };

  useEffect(() => {
    if (!isCreate && id) {
      getMember(id).then((m) => {
        setMember(m);
        setForm(m);
      });
      refreshStatus();
      getMemberTokenUsage(id).then((usage) => setTotalTokens(usage.totalTokens)).catch(() => setTotalTokens(null));
    } else {
      setForm({ model: undefined, credentialId: null, thinkingLevel: "off" });
      setTotalTokens(null);
    }
    getAgents().then(setAgents);
  }, [id, isCreate]);

  // Track whether selected agent is builtin
  const [isBuiltinAgent, setIsBuiltinAgent] = useState(false);

  // Load agent detail when agent field changes
  useEffect(() => {
    if (form.agent) {
      getAgent(form.agent)
        .then((a) => {
          setAgentDetail({ description: a.description, skills: a.skills || [], avatar: a.avatar });
          setIsBuiltinAgent(a.tags?.includes("builtin") ?? false);
        })
        .catch(() => { setAgentDetail(null); setIsBuiltinAgent(false); });
    } else {
      setAgentDetail(null);
      setIsBuiltinAgent(false);
    }
  }, [form.agent]);

  const getModelPayload = () => ({ model: form.model || null, credentialId: form.credentialId || null });

  const handleSave = async () => {
    setSaveState("saving");
    try {
      const modelPayload = getModelPayload();
      const payload = { ...form, ...modelPayload };
      if (isCreate) {
        if (!form.name || !form.agent) { toast("Name and agent are required", "error"); setSaveState("idle"); return; }
        const created = await createMember(payload as any);
        onCreated?.(created.id);
        setSaveState("saved");
      } else {
        const updated = await updateMember(id!, payload);
        setMember(updated);
        setForm(updated);
        setSaveState("saved");
      }
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err: any) {
      toast(err.message, "error");
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm(`Delete member "${member?.name}"?`))) return;
    try { await deleteMemberApi(id!); onBack(); } catch (err: any) { toast(err.message, "error"); }
  };

  if (!isCreate && !member) return <div className="flex-1 flex items-center justify-center text-zinc-600">Loading...</div>;

  const headerEmoji = agentDetail?.avatar || "👤";
  const headerTitle = isCreate ? "New Member" : (form.name || "Member");

  const inputCls = "w-full bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600";
  const cardCls = "bg-white dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-800 rounded-lg";

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"><ArrowLeft size={18} /></button>
          <span className="text-lg">{headerEmoji}</span>
          <h1 className="text-lg font-bold text-zinc-900 dark:text-white">{headerTitle}</h1>
        </div>
        <div className="flex gap-2">
          {!isCreate && (
            <button onClick={handleDelete} className="flex items-center gap-1 px-3 py-1.5 text-red-500 dark:text-red-400 hover:text-red-400 dark:hover:text-red-300 text-sm cursor-pointer">
              <Trash2 size={14} /> Delete
            </button>
          )}
          <button onClick={handleSave} disabled={saveState === "saving"}
            className={`flex items-center gap-1 px-3 py-1.5 text-white text-sm font-medium rounded-lg cursor-pointer transition-colors ${
              saveState === "saved" ? "bg-emerald-600" : saveState === "error" ? "bg-red-600" : "bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700"
            }`}>
            <Save size={14} /> {saveState === "saving" ? "Saving..." : saveState === "saved" ? "✓ Saved" : saveState === "error" ? "✗ Failed" : isCreate ? "Create" : "Save"}
          </button>
        </div>
      </div>

      <div className="grid w-full max-w-7xl grid-cols-1 xl:grid-cols-[minmax(560px,720px)_minmax(320px,1fr)] gap-6">
        {/* Block 1: Configuration */}
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-3">Configuration</h2>
          <div className={`${cardCls} p-5 space-y-4`}>
            <Field label="Name">
              <input autoComplete="off" value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={isCreate ? "e.g. pm, arch-sonnet" : ""} className={inputCls} />
            </Field>

            <Field label="Agent Definition">
              <select value={form.agent || ""} onChange={(e) => { setForm({ ...form, agent: e.target.value }); if (isCreate && !form.name) setForm((f) => ({ ...f, agent: e.target.value, name: e.target.value })); }}
                className={inputCls}>
                <option value="">Select agent...</option>
                {agents.map((a) => <option key={a.name} value={a.name}>{a.name}{a.tags.includes("builtin") ? " [BUILT-IN]" : ""} — {a.description}</option>)}
              </select>
              {isBuiltinAgent && (
                <p className="text-xs text-slate-400 mt-1.5">Uses CLI default configuration. No additional prompts or skills injected.</p>
              )}
            </Field>

            <Field label="Model">
              <ModelPicker
                value={{ model: form.model || null, credentialId: form.credentialId || null }}
                models={models}
                disabled={!configuredModelsLoaded}
                onChange={(next) => setForm({ ...form, model: next.model || undefined, credentialId: next.credentialId })}
              />
              <p className="text-xs text-zinc-500 mt-1">Choose from models configured in Settings → Model Credentials, or follow the agent default.</p>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Thinking Level">
                <select value={form.thinkingLevel || "off"} onChange={(e) => setForm({ ...form, thinkingLevel: e.target.value })} className={inputCls}>
                  {["off", "minimal", "low", "medium", "high", "xhigh"].map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </Field>
              <Field
                label="Messages on Activation"
                hint="Max recent room messages this member sees each time it's activated."
              >
                <input autoComplete="off" type="number" min={1} value={form.contextLimit ?? 50}
                  onChange={(e) => setForm({ ...form, contextLimit: parseInt(e.target.value, 10) || 50 })} className={inputCls} />
              </Field>
            </div>
          </div>
        </div>

        {/* Block 2: Agent Preview + Status */}
        <div className="min-w-0 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Agent Preview</h2>
            {agentDetail && form.agent && onNavigateAgent && (
              <button onClick={() => onNavigateAgent(form.agent!)}
                className="text-xs text-blue-500 dark:text-blue-400 hover:text-blue-400 dark:hover:text-blue-300 cursor-pointer">View Agent →</button>
            )}
          </div>

          {agentDetail ? (
            <div className={`${cardCls} p-4 space-y-3`}>
              <div className="flex items-center gap-2">
                <span className="text-xl">{agentDetail.avatar || "🤖"}</span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white">{form.agent}</span>
                    {isBuiltinAgent && (
                      <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-medium uppercase tracking-wide">built-in</span>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400">{agentDetail.description}</div>
                </div>
              </div>
              {!isBuiltinAgent && agentDetail.skills.length > 0 && (
                <div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">Skills ({agentDetail.skills.length})</div>
                  <div className="flex flex-wrap gap-1.5">
                    {agentDetail.skills.map((s) => (
                      <span key={s} className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded">{s}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className={`${cardCls} p-4 text-center text-zinc-400 dark:text-zinc-600 text-sm`}>
              Select an agent to see preview
            </div>
          )}

          {!isCreate && (
            <div className={`${cardCls} p-4`}>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Historical tokens</div>
              <div className="text-xl font-semibold text-zinc-900 dark:text-white tabular-nums">
                {totalTokens === null ? "—" : totalTokens.toLocaleString()}
              </div>
            </div>
          )}

          {/* Status */}
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Status</h2>
            {!isCreate && (
              <button onClick={refreshStatus} className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer">
                <RefreshCw size={12} />
              </button>
            )}
          </div>
          <div className={`${cardCls} p-4`}>
            {instances.length === 0 ? (
              <div className="text-sm text-zinc-400 dark:text-zinc-500">Not active in any room</div>
            ) : (
              <div className="space-y-3">
                {instances.map((inst) => (
                  <div key={inst.roomId}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300"># {inst.roomName}</span>
                      <button onClick={async () => {
                        if (!(await confirm(`Restart ${form.name || "member"} in ${inst.roomName}?`))) return;
                        try { await restartMember(id!, inst.roomId); refreshStatus(); } catch (err: any) { toast(err.message, "error"); }
                      }} className="text-zinc-400 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer" title="Restart">
                        <RefreshCw size={12} />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className={`w-1.5 h-1.5 rounded-full ${inst.status === "working" ? "bg-amber-500 animate-pulse" : "bg-emerald-500"}`} />
                      <span>{inst.status === "working" ? "Working" : "Idle"}</span>
                    </div>
                    {inst.runtimeParams && <RuntimeParamsView params={inst.runtimeParams} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


function basename(pathOrLabel: string): string {
  if (!pathOrLabel.includes("/")) return pathOrLabel;
  return pathOrLabel.split("/").filter(Boolean).pop() || pathOrLabel;
}

function charCountLabel(text: string): string {
  return text.length >= 1000 ? `${(text.length / 1000).toFixed(1)}k chars` : `${text.length} chars`;
}

function RuntimeParamsView({ params }: { params: NonNullable<import("../api/client").MemberInstanceInfo["runtimeParams"]> }) {
  const skills = params.skills || [];
  const extensions = params.extensions || [];
  return (
    <div className="mt-2 space-y-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <div><span className="text-zinc-400 dark:text-zinc-500">Model:</span> <span className="font-mono">{params.model || "default"}</span></div>
      <div><span className="text-zinc-400 dark:text-zinc-500">Thinking:</span> <span className="font-mono">{params.thinkingLevel || "off"}</span></div>
      {params.systemPrompt && (
        <details>
          <summary className="text-[10px] text-zinc-400 dark:text-zinc-600 font-mono cursor-pointer hover:text-zinc-300">System Prompt [{charCountLabel(params.systemPrompt)}]</summary>
          <pre className="text-[10px] text-zinc-500 dark:text-zinc-600 font-mono mt-1 whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto rounded bg-zinc-50 dark:bg-zinc-950/40 border border-zinc-200 dark:border-zinc-800 p-2">{params.systemPrompt}</pre>
        </details>
      )}
      {skills.length > 0 && (
        <details>
          <summary className="text-[10px] text-zinc-400 dark:text-zinc-600 font-mono cursor-pointer hover:text-zinc-300">Skills ({skills.length})</summary>
          <ul className="mt-1 list-disc list-inside text-[10px] font-mono text-zinc-500 dark:text-zinc-600">{skills.map((s) => <li key={s}>{basename(s)}</li>)}</ul>
        </details>
      )}
      {extensions.length > 0 && (
        <details>
          <summary className="text-[10px] text-zinc-400 dark:text-zinc-600 font-mono cursor-pointer hover:text-zinc-300">Extensions ({extensions.length})</summary>
          <ul className="mt-1 list-disc list-inside text-[10px] font-mono text-zinc-500 dark:text-zinc-600">{extensions.map((s) => <li key={s}>{basename(s)}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">{label}</label>
      {children}
      {hint && <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1 leading-snug">{hint}</div>}
    </div>
  );
}
