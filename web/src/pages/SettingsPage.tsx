import { useState, useEffect } from "react";
import { Plus, KeyRound, Pencil, Trash2, Link2, PlugZap, RefreshCw } from "lucide-react";
import { MobileTopBar } from "../components/MobileTopBar";
import type { SummarySettings, TeamUpdateSettings, PublicModelCredentialProfile, ModelCredentialProfileInput, ModelProtocol, ModelAuthType, OAuthLoginJob, LinearIntegrationStatus, PublicModelProvider } from "../api/client";
import {
  getSummarySettings,
  updateSummarySettings,
  getRuntimeSettings,
  updateRuntimeSettings,
  getTeamUpdateSettings,
  updateTeamUpdateSettings,
  checkTeamUpdates,
  getModelCredentialProfiles,
  createModelCredentialProfile,
  updateModelCredentialProfile,
  deleteModelCredentialProfile,
  refreshModelCredentialProfileModels,
  discoverModelCredentialModels,
  startOAuthLoginJob,
  submitOAuthLoginJobInput,
  cancelOAuthLoginJob,
  getModelProviderCatalog,
  connectModelProviderApiKey,
  startOAuthConnection,
  getOAuthConnectionJob,
  submitOAuthConnectionInput,
  cancelOAuthConnection,
  getLinearIntegrationStatus,
  connectLinearIntegration,
  disconnectLinearIntegration,
} from "../api/client";
import { Sheet } from "../components/Sheet";
import { useDialog } from "../components/dialogs";
import type { SettingsSection } from "../components/Sidebar";

interface SettingsPageProps {
  section?: SettingsSection;
  onOpenMobileSidebar?: () => void;
}

const SECTION_META: Record<SettingsSection, { title: string; desc: string }> = {
  models: { title: "Models", desc: "模型凭证与可用模型。per-model 定制在 catalog 刷新后保留。" },
  runtime: { title: "Runtime", desc: "pi SDK 运行时与会话行为。" },
  summary: { title: "Summarization", desc: "智能消息摘要的自动触发与保留策略。" },
  integrations: { title: "Integrations", desc: "外部系统连接。" },
  "team-updates": { title: "Team Updates", desc: "内置 agents / skills / rules 的版本更新。" },
};

export function SettingsPage({ section = "models", onOpenMobileSidebar }: SettingsPageProps = {}) {
  const { toast, confirm } = useDialog();
  const [summarySettings, setSummarySettings] = useState<SummarySettings>({
    autoEnabled: false,
    threshold: 200,
    keepCount: 50,
  });
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summarySaved, setSummarySaved] = useState(false);
  const [sessionResume, setSessionResume] = useState(true);
  const [sessionResumeSaving, setSessionResumeSaving] = useState(false);
  const [sessionResumeSaved, setSessionResumeSaved] = useState(false);
  const [teamUpdateSettings, setTeamUpdateSettings] = useState<TeamUpdateSettings | null>(null);
  const [checkingTeamUpdates, setCheckingTeamUpdates] = useState(false);
  const [profiles, setProfiles] = useState<PublicModelCredentialProfile[]>([]);
  const [editingProfile, setEditingProfile] = useState<PublicModelCredentialProfile | null>(null);
  const [showProfileSheet, setShowProfileSheet] = useState(false);
  const [showConnectProvider, setShowConnectProvider] = useState(false);
  const [linearStatus, setLinearStatus] = useState<LinearIntegrationStatus>({ connected: false });

  useEffect(() => {
    getSummarySettings().then(setSummarySettings).catch(console.error);
    getRuntimeSettings().then((v) => setSessionResume(v.sessionResume)).catch(console.error);
    getTeamUpdateSettings().then(setTeamUpdateSettings).catch(console.error);
    getModelCredentialProfiles().then(setProfiles).catch(console.error);
    getLinearIntegrationStatus().then(setLinearStatus).catch(console.error);
  }, []);

  const handleSummaryChange = async (updates: Partial<SummarySettings>) => {
    const newSettings = { ...summarySettings, ...updates };
    setSummarySettings(newSettings);
    setSummaryLoading(true);
    try {
      await updateSummarySettings(newSettings);
      setSummarySaved(true);
      setTimeout(() => setSummarySaved(false), 2000);
    } catch (err: any) {
      console.error("Failed to save summary settings:", err);
    } finally {
      setSummaryLoading(false);
    }
  };

  const handleSessionResumeToggle = async () => {
    const next = !sessionResume;
    setSessionResume(next);
    setSessionResumeSaving(true);
    try {
      await updateRuntimeSettings(next);
      setSessionResumeSaved(true);
      setTimeout(() => setSessionResumeSaved(false), 2000);
    } catch (err: any) {
      console.error("Failed to save session resume setting:", err);
      setSessionResume(!next);
    } finally {
      setSessionResumeSaving(false);
    }
  };

  const handleTeamUpdateToggle = async () => {
    if (!teamUpdateSettings) return;
    try {
      const next = await updateTeamUpdateSettings(!teamUpdateSettings.dismissPermanent);
      setTeamUpdateSettings(next);
    } catch (err) {
      console.error("Failed to update team update settings", err);
    }
  };

  const refreshProfiles = async () => setProfiles(await getModelCredentialProfiles());

  const handleDeleteProfile = async (profile: PublicModelCredentialProfile) => {
    if (!(await confirm(`Delete model credential "${profile.name}"?`))) return;
    try { await deleteModelCredentialProfile(profile.id); await refreshProfiles(); }
    catch (err: any) { toast(err.message, "error"); }
  };

  const handleRefreshProfileModels = async (profile: PublicModelCredentialProfile) => {
    try {
      const refreshed = await refreshModelCredentialProfileModels(profile.id);
      await refreshProfiles();
      toast(`Refreshed ${refreshed.models.length} model${refreshed.models.length === 1 ? "" : "s"}.`, "success");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleCheckTeamUpdates = async () => {
    setCheckingTeamUpdates(true);
    try {
      const result = await checkTeamUpdates();
      console.info("team updates check", result);
    } catch (err) {
      console.error("Failed to check team updates", err);
    } finally {
      setCheckingTeamUpdates(false);
    }
  };

  const meta = SECTION_META[section];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
      <MobileTopBar title={meta.title} onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 flex flex-col overflow-y-auto">
      <div className="w-full max-w-3xl mx-auto px-6 pt-7 pb-20">
      <div className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink-1">{meta.title}</h1>
        <p className="text-xs text-ink-3 mt-1">{meta.desc}</p>
      </div>

      {section === "integrations" && (
        <LinearIntegrationSection status={linearStatus} onStatus={setLinearStatus} />
      )}

      {section === "models" && (
        <ModelCredentialsSection
          profiles={profiles}
          onAdd={() => setShowConnectProvider(true)}
          onCustom={() => { setEditingProfile(null); setShowProfileSheet(true); }}
          onEdit={(p) => { setEditingProfile(p); setShowProfileSheet(true); }}
          onDelete={handleDeleteProfile}
          onRefreshModels={handleRefreshProfileModels}
        />
      )}

      {/* Session Resume */}
      {section === "runtime" && (
      <div>
        <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-ink-1">Session Resume</div>
              <div className="text-xs text-ink-3 mt-0.5">When enabled, new agent sessions resume from where they left off. Turning off only affects newly started sessions.</div>
            </div>
            <button
              onClick={handleSessionResumeToggle}
              disabled={sessionResumeSaving}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-60 ${
                sessionResume ? "bg-accent" : "bg-surface-3"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  sessionResume ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          <div className="text-xs text-ink-4">
            {sessionResumeSaved && <span className="text-onair">Saved!</span>}
          </div>
        </div>
      </div>
      )}

      {/* Auto-Summary */}
      {section === "summary" && (
      <div>
        <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-ink-1">Enable Auto-Summary</div>
              <div className="text-xs text-ink-3 mt-0.5">Automatically summarize when message count exceeds threshold</div>
            </div>
            <button
              onClick={() => handleSummaryChange({ autoEnabled: !summarySettings.autoEnabled })}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${
                summarySettings.autoEnabled ? "bg-accent" : "bg-surface-3"
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                summarySettings.autoEnabled ? "translate-x-5" : "translate-x-0"
              }`} />
            </button>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-xs text-ink-3 block mb-1">Threshold (messages)</label>
              <input
                type="number"
                value={summarySettings.threshold}
                onChange={(e) => handleSummaryChange({ threshold: parseInt(e.target.value) || 200 })}
                min={50}
                max={1000}
                className="w-full bg-inset border border-line rounded px-3 py-1.5 text-sm text-ink-1"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-ink-3 block mb-1">Keep latest (messages)</label>
              <input
                type="number"
                value={summarySettings.keepCount}
                onChange={(e) => handleSummaryChange({ keepCount: parseInt(e.target.value) || 50 })}
                min={10}
                max={200}
                className="w-full bg-inset border border-line rounded px-3 py-1.5 text-sm text-ink-1"
              />
            </div>
          </div>

          <div className="text-xs text-ink-4">
            Summarizer's model can be configured from its workstation card in any room.
            {summarySaved && <span className="ml-2 text-onair">Saved!</span>}
          </div>
        </div>
      </div>
      )}

      {/* Built-in Team Updates */}
      {section === "team-updates" && (
      <div>
        <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-ink-1">Check for updates automatically</div>
              <div className="text-xs text-ink-3 mt-0.5">Installed version: {teamUpdateSettings?.installedVersion || "-"}</div>
            </div>
            <button
              onClick={handleTeamUpdateToggle}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${
                teamUpdateSettings?.dismissPermanent ? "bg-surface-3" : "bg-accent"
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                teamUpdateSettings?.dismissPermanent ? "translate-x-0" : "translate-x-5"
              }`} />
            </button>
          </div>
          <button
            onClick={handleCheckTeamUpdates}
            disabled={checkingTeamUpdates}
            className="px-3 py-1.5 text-xs border border-line rounded text-ink-2 hover:text-ink-1 hover:border-line-strong cursor-pointer disabled:opacity-60"
          >
            {checkingTeamUpdates ? "Checking..." : "Check now"}
          </button>
        </div>
      </div>
      )}

      </div>
    </div>
    {showConnectProvider && (
      <ConnectProviderSheet
        onClose={() => setShowConnectProvider(false)}
        onSaved={async () => { setShowConnectProvider(false); await refreshProfiles(); }}
      />
    )}
    {showProfileSheet && (
      <CredentialProfileSheet
        profile={editingProfile}
        onClose={() => setShowProfileSheet(false)}
        onSaved={async () => { setShowProfileSheet(false); await refreshProfiles(); }}
      />
    )}
    </div>
  );
}

function LinearIntegrationSection({ status, onStatus }: { status: LinearIntegrationStatus; onStatus: (status: LinearIntegrationStatus) => void }) {
  const { toast, confirm } = useDialog();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  const connect = async () => {
    if (!apiKey.trim()) { toast("Linear API key is required", "error"); return; }
    setSaving(true);
    try {
      const next = await connectLinearIntegration(apiKey.trim());
      onStatus(next);
      setApiKey("");
      toast("Linear connected", "success");
    } catch (err: any) { toast(err.message, "error"); }
    finally { setSaving(false); }
  };

  const disconnect = async () => {
    if (!(await confirm("Disconnect Linear and clear room Linear bindings?"))) return;
    setSaving(true);
    try {
      const result = await disconnectLinearIntegration();
      onStatus({ connected: false });
      toast(`Linear disconnected. Cleared ${result.clearedRooms} room bindings.`, "success");
    } catch (err: any) { toast(err.message, "error"); }
    finally { setSaving(false); }
  };

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider mb-4">Integrations</h2>
      <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-8 h-8 rounded bg-surface-2 flex items-center justify-center"><Link2 size={16} /></div>
            <div>
              <div className="text-sm font-medium text-ink-1">Linear</div>
              <div className="text-xs text-ink-3 mt-0.5">Sync Bossmode room tasks to Linear issues. API key is stored locally and never exposed to agents.</div>
              {status.connected && <div className="text-xs text-onair mt-1">Connected as {status.viewer?.name || "Linear user"}</div>}
              {!status.connected && status.error && <div className="text-xs text-think mt-1">Connection error: {status.error}</div>}
            </div>
          </div>
          {status.connected && <button onClick={disconnect} disabled={saving} className="px-3 py-1.5 border rounded-lg text-sm text-ink-2 border-line hover:bg-surface-2 cursor-pointer disabled:opacity-50">Disconnect</button>}
        </div>
        {!status.connected && (
          <div className="flex gap-2">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="lin_api_..." className="flex-1 bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" />
            <button onClick={connect} disabled={saving || !apiKey.trim()} className="px-3 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed">{saving ? "Connecting..." : "Connect Linear"}</button>
          </div>
        )}
      </div>
    </section>
  );
}

const PROTOCOLS: ModelProtocol[] = [
  "openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages",
  "azure-openai-responses", "google-generative-ai", "google-gemini-cli", "google-vertex",
  "bedrock-converse-stream", "mistral-conversations",
];
const AUTH_TYPES: ModelAuthType[] = ["api_key", "oauth", "none", "ambient"];

function ModelCredentialsSection({ profiles, onAdd, onCustom, onEdit, onDelete, onRefreshModels }: {
  profiles: PublicModelCredentialProfile[];
  onAdd: () => void;
  onCustom: () => void;
  onEdit: (profile: PublicModelCredentialProfile) => void;
  onDelete: (profile: PublicModelCredentialProfile) => void;
  onRefreshModels: (profile: PublicModelCredentialProfile) => void;
}) {
  const [expandedProfiles, setExpandedProfiles] = useState<Set<string>>(new Set());
  const [expandedModelLists, setExpandedModelLists] = useState<Set<string>>(new Set());

  const toggleProfile = (id: string) => setExpandedProfiles((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleModels = (id: string) => setExpandedModelLists((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider">Model Credentials</h2>
          <p className="text-xs text-ink-3 mt-1">Configure provider access once, then choose available models for each member.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onCustom} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-line rounded-lg text-ink-2 hover:text-ink-1 hover:border-line-strong text-sm cursor-pointer">
            Custom Endpoint
          </button>
          <button onClick={onAdd} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-accent-contrast hover:opacity-90 text-sm font-medium rounded-lg cursor-pointer">
            <PlugZap size={14} /> Connect Provider
          </button>
        </div>
      </div>
      {profiles.length === 0 ? (
        <div className="bg-surface-1 border border-dashed border-line rounded-lg p-8 text-center">
          <KeyRound size={22} className="mx-auto text-ink-4 mb-3" />
          <div className="text-sm font-medium text-ink-1">No model credentials yet</div>
          <p className="text-xs text-ink-3 mt-1 max-w-md mx-auto">Connect an official provider, or add a custom endpoint for proxy/local models.</p>
          <button onClick={onAdd} className="mt-4 px-3 py-1.5 bg-accent text-accent-contrast hover:opacity-90 text-sm font-medium rounded-lg cursor-pointer">Connect Provider</button>
          <button onClick={onCustom} className="ml-2 mt-4 px-3 py-1.5 border border-line rounded-lg text-ink-2 hover:text-ink-1 hover:border-line-strong text-sm cursor-pointer">Custom Endpoint</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {profiles.map((profile) => {
            const expanded = expandedProfiles.has(profile.id);
            const modelsExpanded = expandedModelLists.has(profile.id);
            const visibleModels = modelsExpanded ? profile.models : profile.models.slice(0, 3);
            return (
              <div key={profile.id} className="bg-surface-1 border border-line rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleProfile(profile.id)}
                    className="min-w-0 flex-1 text-left cursor-pointer"
                    aria-expanded={expanded}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold text-ink-1 truncate">{profile.name}</h3>
                      {profile.isDefault && <Badge tone="success">Default</Badge>}
                      {!profile.enabled && <Badge tone="neutral">Disabled</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                      <code className="px-1.5 py-0.5 rounded bg-surface-2">{profile.providerSlug}</code>
                      <span>{profile.models.length} models</span><span>·</span><span>{profile.protocol}</span><span>·</span><span>{profile.authType}</span>
                    </div>
                  </button>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => toggleProfile(profile.id)} className="px-2 py-1 text-xs text-ink-3 hover:text-ink-1 cursor-pointer" title={expanded ? "Collapse" : "Expand"}>{expanded ? "Collapse" : "Expand"}</button>
                    {profile.profileKind === "builtin_provider" && <button onClick={() => onRefreshModels(profile)} className="text-ink-4 hover:text-accent-ink cursor-pointer" title="Refresh models"><RefreshCw size={14} /></button>}
                    <button onClick={() => onEdit(profile)} className="text-ink-4 hover:text-ink-1 cursor-pointer" title="Edit"><Pencil size={14} /></button>
                    <button onClick={() => onDelete(profile)} className="text-ink-4 hover:text-blocked cursor-pointer" title="Delete"><Trash2 size={14} /></button>
                  </div>
                </div>
                {expanded && (
                  <>
                    {profile.baseUrl && <div className="text-[11px] text-ink-3 font-mono truncate mt-3 mb-3">{profile.baseUrl}</div>}
                    <div className="rounded-md bg-inset/60 border border-line-soft p-3 mt-3">
                      <div className="flex items-center justify-between mb-2"><span className="text-xs font-medium text-ink-2">Models</span><span className="text-[11px] text-ink-4">{profile.hasSecret ? "Secret configured" : profile.authType}</span></div>
                      <div className="space-y-1">
                        {visibleModels.map((m) => <div key={m.id} className="flex items-center justify-between gap-2 text-xs"><code className="text-ink-2 truncate">{profile.providerSlug}/{m.id}</code>{m.contextWindow ? <span className="text-ink-4 shrink-0">{Math.round(m.contextWindow / 1000)}k ctx · {m.metadataSource === "pi_catalog" ? "pi catalog" : "endpoint"}</span> : <span className="text-ink-4 shrink-0">metadata unknown</span>}</div>)}
                        {profile.models.length > 3 && (
                          <button type="button" onClick={() => toggleModels(profile.id)} className="text-[11px] text-accent-ink hover:opacity-80 cursor-pointer">
                            {modelsExpanded ? "Show less" : `+${profile.models.length - 3} more`}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-3">
                      {profile.profileKind === "builtin_provider" && <button onClick={() => onRefreshModels(profile)} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-line rounded-lg text-ink-2 hover:text-ink-1 hover:border-line-strong cursor-pointer"><RefreshCw size={12} /> Refresh models</button>}
                      <button onClick={() => onEdit(profile)} className="px-3 py-1.5 text-xs border border-line rounded-lg text-ink-2 hover:text-ink-1 hover:border-line-strong cursor-pointer">Edit</button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function ConnectProviderSheet({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useDialog();
  const [providers, setProviders] = useState<PublicModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PublicModelProvider | null>(null);
  const [authMode, setAuthMode] = useState<"api_key" | "oauth">("api_key");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [enableClaudeCodeFingerprint, setEnableClaudeCodeFingerprint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [oauthJob, setOauthJob] = useState<OAuthLoginJob | null>(null);
  const [oauthInput, setOauthInput] = useState("");

  useEffect(() => {
    getModelProviderCatalog()
      .then((items) => setProviders(items))
      .catch((err) => toast(err.message, "error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setAuthMode(selected.defaultAuthMode);
    setName(selected.displayName);
    setApiKey("");
    setEnableClaudeCodeFingerprint(false);
    setOauthJob(null);
    setOauthInput("");
  }, [selected?.providerSlug]);

  useEffect(() => {
    if (!oauthJob || ["completed", "failed", "cancelled"].includes(oauthJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getOAuthConnectionJob(oauthJob.id);
        setOauthJob(next);
        if (next.status === "completed") {
          toast("Provider connected", "success");
          window.clearInterval(timer);
          onSaved();
        }
      } catch (err: any) {
        window.clearInterval(timer);
        toast(err.message, "error");
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [oauthJob?.id, oauthJob?.status]);

  const connectApiKey = async () => {
    if (!selected) return;
    if (!apiKey.trim()) { toast("API key is required", "error"); return; }
    setBusy(true);
    try {
      await connectModelProviderApiKey({
        providerSlug: selected.providerSlug,
        apiKey: apiKey.trim(),
        name: name.trim() || selected.displayName,
        requestProfile: selected.providerSlug === "anthropic" && enableClaudeCodeFingerprint ? "anthropic_proxy_claude_code" : "standard",
      });
      toast("Provider connected", "success");
      onSaved();
    } catch (err: any) { toast(err.message, "error"); }
    finally { setBusy(false); }
  };

  const startOAuth = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setOauthJob(await startOAuthConnection({
        providerId: selected.providerSlug,
        name: name.trim() || selected.displayName,
        requestProfile: selected.providerSlug === "anthropic" && enableClaudeCodeFingerprint ? "anthropic_proxy_claude_code" : "standard",
      }));
    } catch (err: any) { toast(err.message, "error"); }
    finally { setBusy(false); }
  };

  const submitOAuthInput = async () => {
    if (!oauthJob || !oauthInput.trim()) return;
    setBusy(true);
    try {
      const next = await submitOAuthConnectionInput(oauthJob.id, oauthInput.trim());
      setOauthJob(next);
      if (next.status === "completed") {
        toast("Provider connected", "success");
        onSaved();
      }
    } catch (err: any) { toast(err.message, "error"); }
    finally { setBusy(false); }
  };

  const cancelOAuth = async () => {
    if (!oauthJob) { onClose(); return; }
    setBusy(true);
    try { setOauthJob(await cancelOAuthConnection(oauthJob.id)); }
    catch (err: any) { toast(err.message, "error"); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <div className="p-5 space-y-5">
        <div>
          <h3 className="text-base font-semibold text-ink-1">Connect Provider</h3>
          <p className="text-xs text-ink-3 mt-1">Choose an official provider. No base URL, protocol, or manual model setup required.</p>
        </div>

        {loading ? <div className="text-sm text-ink-3">Loading providers...</div> : (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,340px)_1fr] gap-5">
            <div className="space-y-2 max-h-[62vh] overflow-y-auto pr-1">
              {providers.map((provider) => {
                const active = selected?.providerSlug === provider.providerSlug;
                return (
                  <button
                    key={provider.providerSlug}
                    type="button"
                    onClick={() => setSelected(provider)}
                    className={`w-full text-left rounded-lg border p-3 cursor-pointer transition-colors ${active ? "border-accent bg-accent-dim" : "border-line-soft bg-surface-1 hover:border-line-strong"}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-lg bg-surface-2 flex items-center justify-center text-sm font-semibold text-ink-2">{provider.displayName.slice(0, 1)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-ink-1 truncate">{provider.displayName}</div>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {provider.authModes.map((mode) => <Badge key={mode} tone="neutral">{mode === "api_key" ? "API Key" : "OAuth"}</Badge>)}
                          <Badge tone="neutral">{provider.modelCount} models</Badge>
                        </div>
                        {provider.sampleModels.length > 0 && <div className="mt-1 text-[11px] text-ink-3 truncate">{provider.sampleModels.slice(0, 2).join(", ")}</div>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="rounded-lg border border-line-soft bg-surface-1 p-4 min-h-[360px]">
              {!selected ? (
                <div className="h-full flex items-center justify-center text-sm text-ink-3">Select a provider to continue.</div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <div className="text-sm font-semibold text-ink-1">{selected.displayName}</div>
                    <div className="text-xs text-ink-3 mt-1">{selected.modelCount} models available from provider catalog.</div>
                  </div>

                  <Field label="Credential name"><input className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" value={name} onChange={(e) => setName(e.target.value)} /></Field>

                  {selected.authModes.length > 1 && (
                    <Field label="Authentication"><select className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" value={authMode} onChange={(e) => setAuthMode(e.target.value as "api_key" | "oauth")}>{selected.authModes.map((mode) => <option key={mode} value={mode}>{mode === "api_key" ? "API Key" : "OAuth login"}</option>)}</select></Field>
                  )}

                  {selected.providerSlug === "anthropic" && <div className="rounded border border-line-soft p-3 space-y-2">
                    <label className="flex items-center justify-between gap-3 text-xs text-ink-2">
                      <span>
                        <span className="block font-medium text-ink-1">Enable Claude Code fingerprint</span>
                        <span className="block mt-1 text-ink-3">Turn on when this credential requires Claude Code-compatible request headers and payload shaping. Leave off for regular Anthropic API keys.</span>
                      </span>
                      <input type="checkbox" checked={enableClaudeCodeFingerprint} onChange={(e) => setEnableClaudeCodeFingerprint(e.target.checked)} />
                    </label>
                  </div>}

                  {authMode === "api_key" ? (
                    <div className="space-y-3">
                      <Field label="API key"><input type="password" className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste provider API key" /></Field>
                      <button type="button" onClick={connectApiKey} disabled={busy || !apiKey.trim()} className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed">{busy ? "Connecting..." : "Connect"}</button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {!oauthJob && <button type="button" onClick={startOAuth} disabled={busy} className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed">{busy ? "Starting..." : "Start login"}</button>}
                      {oauthJob && <div className="rounded border border-line-soft bg-inset p-3 space-y-2 text-xs text-ink-3">
                        <div>Status: <span className="font-medium">{oauthJob.status}</span></div>
                        {oauthJob.prompt && <div>{oauthJob.prompt}</div>}
                        {oauthJob.authUrl && <a className="text-accent-ink hover:underline break-all" href={oauthJob.authUrl} target="_blank" rel="noreferrer">Open login page</a>}
                        {oauthJob.deviceCode && <div className="space-y-1"><div>Code: <code>{oauthJob.deviceCode.userCode}</code></div><a className="text-accent-ink hover:underline break-all" href={oauthJob.deviceCode.verificationUri} target="_blank" rel="noreferrer">{oauthJob.deviceCode.verificationUri}</a></div>}
                        {oauthJob.userCode && <div>Code: <code>{oauthJob.userCode}</code></div>}
                        {oauthJob.status === "awaiting_input" && <div className="flex gap-2"><input className="flex-1 bg-surface-1 border border-line rounded px-3 py-2 text-sm" value={oauthInput} onChange={(e) => setOauthInput(e.target.value)} placeholder="Paste code or response" /><button type="button" onClick={submitOAuthInput} disabled={busy || !oauthInput.trim()} className="px-3 py-2 bg-accent text-accent-contrast rounded text-xs disabled:opacity-40">Submit</button></div>}
                        {oauthJob.error && <div className="text-blocked">{oauthJob.error}</div>}
                        {!["completed", "failed", "cancelled"].includes(oauthJob.status) && <button type="button" onClick={cancelOAuth} disabled={busy} className="text-ink-3 hover:text-ink-1">Cancel login</button>}
                      </div>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2"><button onClick={onClose} className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer">Close</button></div>
      </div>
    </Sheet>
  );
}


function Badge({ tone, children }: { tone: "success" | "neutral"; children: React.ReactNode }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone === "success" ? "bg-onair-dim text-onair" : "bg-surface-2 text-ink-3"}`}>{children}</span>;
}

function usesClaudeCodeFingerprint(profile: Pick<ModelCredentialProfileInput, "requestProfile">): boolean {
  return profile.requestProfile === "anthropic_claude_code_oauth" || profile.requestProfile === "anthropic_proxy_claude_code";
}

function parseIntegerInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number(trimmed);
}

function modelCustomizations(profile: ModelCredentialProfileInput): NonNullable<ModelCredentialProfileInput["modelCustomizations"]> {
  return profile.modelCustomizations || {};
}

function isModelHidden(profile: ModelCredentialProfileInput, id: string): boolean {
  return (profile.modelCustomizations?.disabled || []).includes(id);
}

function modelOverride(profile: ModelCredentialProfileInput, id: string): { contextWindow?: number; maxTokens?: number } {
  return profile.modelCustomizations?.contextWindowOverride?.[id] !== undefined ? { contextWindow: modelCustomizations(profile).contextWindowOverride?.[id] } : {};
}

function formatK(value?: number): string {
  return value ? `${Math.round(value / 1000)}k` : "unavailable";
}

function mergeFetchedModelsWithOverrides(current: ModelCredentialProfileInput["models"], fetched: ModelCredentialProfileInput["models"]): ModelCredentialProfileInput["models"] {
  const byId = new Map(current.map((m) => [m.id, m]));
  return fetched.map((m) => {
    const existing = byId.get(m.id);
    if (!existing) return m;
    return {
      ...m,
      name: existing.name || m.name,
      contextWindow: existing.contextWindow ?? m.contextWindow,
      maxTokens: existing.maxTokens ?? m.maxTokens,
      metadataSource: existing.contextWindow !== undefined || existing.maxTokens !== undefined ? "endpoint" : m.metadataSource,
    };
  });
}

function CredentialProfileSheet({ profile, onClose, onSaved }: { profile: PublicModelCredentialProfile | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useDialog();
  const [form, setForm] = useState<ModelCredentialProfileInput>(() => ({
    profileKind: profile?.profileKind || "custom_endpoint",
    name: profile?.name || "",
    providerSlug: profile?.providerSlug || "",
    protocol: profile?.protocol || "openai-responses",
    baseUrl: profile?.baseUrl || "",
    authType: profile?.authType || "api_key",
    apiKey: "",
    requestProfile: profile?.requestProfile || "standard",
    enabled: profile?.enabled ?? true,
    isDefault: profile?.isDefault ?? false,
    models: profile?.profileKind === "builtin_provider" && profile.catalogModels?.length ? profile.catalogModels : (profile?.models?.length ? profile.models : [{ id: "", metadataSource: "unknown" }]),
    modelCustomizations: profile?.modelCustomizations,
  }));
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [oauthJob, setOauthJob] = useState<OAuthLoginJob | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const inputCls = "w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong";
  const builtinProvider = form.profileKind === "builtin_provider";
  const updateModelCustomizations = (next: ModelCredentialProfileInput["modelCustomizations"]) => setForm({ ...form, modelCustomizations: next });
  const setModelVisible = (id: string, visible: boolean) => {
    const current = modelCustomizations(form);
    const disabled = new Set(current.disabled || []);
    visible ? disabled.delete(id) : disabled.add(id);
    updateModelCustomizations({ ...current, disabled: Array.from(disabled) });
  };
  const setModelOverride = (id: string, field: "contextWindow", value: number | undefined) => {
    const current = modelCustomizations(form);
    const contextWindowOverride = { ...(current.contextWindowOverride || {}) };
    if (value === undefined) delete contextWindowOverride[id];
    else contextWindowOverride[id] = value;
    updateModelCustomizations({ ...current, contextWindowOverride });
  };
  const fetchModels = async () => {
    setFetchingModels(true);
    setFetchError(null);
    try {
      const result = await discoverModelCredentialModels({ ...form, id: profile?.id });
      if (result.models.length === 0) {
        setFetchError("No models found. You can still add models manually.");
      } else {
        setForm({ ...form, models: mergeFetchedModelsWithOverrides(form.models, result.models) });
        toast(`Fetched ${result.models.length} model${result.models.length === 1 ? "" : "s"}.`, "success");
        if (result.warnings.length > 0) setFetchError(result.warnings.join(" "));
      }
    } catch (err: any) {
      setFetchError(err.message || String(err));
      toast(err.message || String(err), "error");
    } finally {
      setFetchingModels(false);
    }
  };
  const startOAuth = async () => {
    setOauthBusy(true);
    try {
      const job = await startOAuthLoginJob({ profileId: profile?.id, providerId: form.oauthProviderId, profile: form });
      setOauthJob(job);
    } catch (err: any) { toast(err.message, "error"); }
    finally { setOauthBusy(false); }
  };
  const submitOAuth = async () => {
    if (!oauthJob) return;
    setOauthBusy(true);
    try {
      const job = await submitOAuthLoginJobInput(oauthJob.id, oauthCode);
      setOauthJob(job);
      if (job.status === "completed") {
        toast("OAuth connected.", "success");
        onSaved();
      } else if (job.error) toast(job.error, "error");
    } catch (err: any) { toast(err.message, "error"); }
    finally { setOauthBusy(false); }
  };
  const cancelOAuth = async () => {
    if (!oauthJob) return;
    setOauthBusy(true);
    try { setOauthJob(await cancelOAuthLoginJob(oauthJob.id)); }
    catch (err: any) { toast(err.message, "error"); }
    finally { setOauthBusy(false); }
  };
  const save = async () => {
    setSaving(true);
    try {
      const payload = { ...form, requestProfile: form.protocol === "anthropic-messages" && usesClaudeCodeFingerprint(form) ? "anthropic_proxy_claude_code" as const : "standard" as const };
      if (profile) await updateModelCredentialProfile(profile.id, payload);
      else await createModelCredentialProfile(payload);
      onSaved();
    } catch (err: any) { toast(err.message, "error"); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <div className="p-5 space-y-5">
        <div><h3 className="text-base font-semibold text-ink-1">{profile ? "Edit" : "Add"} credential profile</h3><p className="text-xs text-ink-3 mt-1">Provider connection + model catalog. Raw secrets are never shown after save.</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <Field label="Name"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenRouter main" /></Field>
            <Field label="Provider slug"><input className={inputCls} value={form.providerSlug} onChange={(e) => setForm({ ...form, providerSlug: e.target.value })} placeholder="openrouter" /></Field>
            <Field label="Protocol"><select className={inputCls} value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as ModelProtocol, requestProfile: e.target.value === "anthropic-messages" ? form.requestProfile : "standard" })}>{PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
            <Field label="Base URL"><input className={inputCls} value={form.baseUrl || ""} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
            <Field label="Auth type"><select className={inputCls} value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as ModelAuthType })}>{AUTH_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
            {form.authType === "api_key" && <Field label="API key"><input type="password" className={inputCls} value={form.apiKey || ""} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={profile?.hasSecret ? "Leave blank to keep existing key" : "sk-..."} /></Field>}
            {form.authType === "oauth" && <div className="rounded border border-line-soft p-3 space-y-2">
              <Field label="OAuth provider"><select className={inputCls} value={form.oauthProviderId || ""} onChange={(e) => setForm({ ...form, oauthProviderId: e.target.value })}><option value="">Select provider...</option>{["anthropic", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex"].map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
              <div className="flex items-center gap-2 text-xs"><span className={profile?.hasSecret ? "text-onair" : "text-ink-3"}>{profile?.hasSecret ? "OAuth connected" : "OAuth not connected"}</span><button type="button" disabled={oauthBusy || !form.oauthProviderId} onClick={startOAuth} className="text-accent-ink hover:opacity-80 disabled:text-ink-4 disabled:cursor-not-allowed">Start login</button>{oauthJob && oauthJob.status === "awaiting_input" && <button type="button" disabled={oauthBusy} onClick={cancelOAuth} className="text-ink-3 hover:text-ink-4">Cancel</button>}</div>
              {oauthJob && <div className="text-xs text-ink-2 space-y-1"><div>Status: {oauthJob.status}</div><div>{oauthJob.prompt}</div>{oauthJob.authUrl && <div>Auth URL: <code className="break-all">{oauthJob.authUrl}</code></div>}{oauthJob.userCode && <div>Code: <code>{oauthJob.userCode}</code></div>}{oauthJob.error && <div className="text-blocked">{oauthJob.error}</div>}{oauthJob.status === "awaiting_input" && <div className="flex gap-2"><input className={inputCls} value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} placeholder="Paste OAuth input if requested" /><button type="button" disabled={oauthBusy} onClick={submitOAuth} className="px-3 py-2 text-xs bg-accent text-accent-contrast rounded disabled:opacity-40">Submit</button></div>}</div>}
              <p className="text-xs text-ink-3">Tokens are stored locally and are never shown in the API or UI.</p>
            </div>}
            <div className="text-xs rounded border border-think/30 bg-think-dim text-think p-3">Secrets are stored locally in plaintext with 0600 file permissions. Use a scoped key when possible.</div>
            {form.protocol === "anthropic-messages" && <div className="rounded border border-line-soft p-3 space-y-2">
              <label className="flex items-center justify-between gap-3 text-xs text-ink-2">
                <span>
                  <span className="block font-medium text-ink-1">Enable Claude Code fingerprint</span>
                  <span className="block mt-1 text-ink-3">Turn on for Claude Code/OAuth-style keys or proxies that require Claude Code-compatible headers and payload shaping. Leave off for standard Anthropic API keys.</span>
                </span>
                <input type="checkbox" checked={usesClaudeCodeFingerprint(form)} onChange={(e) => setForm({ ...form, requestProfile: e.target.checked ? "anthropic_proxy_claude_code" : "standard" })} />
              </label>
            </div>}
          </div>
          <div className="space-y-3">
            {builtinProvider ? (
              <>
                <div><h4 className="text-sm font-medium text-ink-1">Models</h4><p className="text-xs text-ink-3 mt-0.5">Provider catalog models for this credential.</p></div>
                {form.models.map((m) => {
                  const hidden = isModelHidden(form, m.id);
                  const override = modelOverride(form, m.id);
                  return <div key={m.id} className="border border-line-soft rounded-lg p-3 space-y-2">
                    <div className={hidden ? "opacity-50" : ""}>
                      <code className="block text-xs text-ink-1 break-all whitespace-normal">{m.id}</code>
                      <div className="text-[11px] text-ink-3 mt-0.5">Provider catalog · Default: {formatK(m.contextWindow)} ctx</div>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-ink-2">
                      <input type="checkbox" checked={!hidden} onChange={(e) => setModelVisible(m.id, e.target.checked)} />
                      Enabled
                    </label>
                    <Field label="Context window"><div className="space-y-1"><input type="number" min={1} step={1} className={inputCls} value={override.contextWindow ?? ""} onChange={(e) => setModelOverride(m.id, "contextWindow", parseIntegerInput(e.target.value))} placeholder={m.contextWindow ? String(m.contextWindow) : "Default"} /><div className="text-[11px] text-ink-3">Leave empty for default.</div></div></Field>
                  </div>;
                })}
              </>
            ) : (
              <>
                <div className="flex items-center justify-between"><h4 className="text-sm font-medium text-ink-1">Models</h4><div className="flex gap-3"><button type="button" onClick={fetchModels} disabled={fetchingModels} className="text-xs text-accent-ink hover:opacity-80 disabled:text-ink-4 disabled:cursor-not-allowed">{fetchingModels ? "Fetching..." : "Fetch models"}</button><button type="button" onClick={() => setForm({ ...form, models: [...form.models, { id: "", metadataSource: "unknown" }] })} className="text-xs text-accent-ink">Add model manually</button></div></div>
                {fetchError && <div className="text-xs rounded border border-think/30 bg-think-dim text-think p-2">{fetchError} Manual add remains available.</div>}
                {form.models.map((m, i) => <div key={i} className="border border-line-soft rounded-lg p-3 space-y-2">
                  <input className={inputCls} value={m.id} onChange={(e) => { const models = [...form.models]; models[i] = { ...m, id: e.target.value }; setForm({ ...form, models }); }} placeholder="model id" />
                  <input className={inputCls} value={m.name || ""} onChange={(e) => { const models = [...form.models]; models[i] = { ...m, name: e.target.value }; setForm({ ...form, models }); }} placeholder="display name (optional)" />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Field label="Context window (tokens)"><input type="number" min={1} step={1} className={inputCls} value={m.contextWindow ?? ""} onChange={(e) => { const models = [...form.models]; models[i] = { ...m, contextWindow: parseIntegerInput(e.target.value), metadataSource: "endpoint" }; setForm({ ...form, models }); }} placeholder="e.g. 1000000" /></Field>
                    <Field label="Max output tokens"><input type="number" min={1} step={1} className={inputCls} value={m.maxTokens ?? ""} onChange={(e) => { const models = [...form.models]; models[i] = { ...m, maxTokens: parseIntegerInput(e.target.value), metadataSource: "endpoint" }; setForm({ ...form, models }); }} placeholder="e.g. 128000" /></Field>
                  </div>
                  <div className="text-[11px] text-ink-3">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx${m.maxTokens ? ` · ${Math.round(m.maxTokens / 1000)}k max` : ""} · ${m.metadataSource === "pi_catalog" ? "from pi catalog" : "custom"}` : "metadata unknown"}</div>
                  <button type="button" className="text-xs text-blocked" onClick={() => setForm({ ...form, models: form.models.filter((_, idx) => idx !== i) })}>Remove</button>
                </div>)}
              </>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-ink-3">Cancel</button><button onClick={save} disabled={saving} className="px-4 py-2 bg-accent hover:opacity-90 disabled:opacity-40 text-white text-sm font-medium rounded-lg">{saving ? "Saving..." : "Save"}</button></div>
      </div>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-xs text-ink-3 mb-1">{label}</span>{children}</label>;
}
