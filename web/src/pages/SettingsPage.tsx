import { useState, useEffect } from "react";
import { Plus, KeyRound, Pencil, Trash2, Download, Link2 } from "lucide-react";
import { MobileTopBar } from "../components/MobileTopBar";
import type { SummarySettings, TeamUpdateSettings, PublicModelCredentialProfile, ModelCredentialProfileInput, ModelProtocol, ModelAuthType, OAuthLoginJob, PiConfigImportPreview, LinearIntegrationStatus } from "../api/client";
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
  discoverModelCredentialModels,
  startOAuthLoginJob,
  submitOAuthLoginJobInput,
  cancelOAuthLoginJob,
  getPiConfigPreview,
  importPiConfig,
  getLinearIntegrationStatus,
  connectLinearIntegration,
  disconnectLinearIntegration,
} from "../api/client";
import { Sheet } from "../components/Sheet";
import { useDialog } from "../components/dialogs";

interface SettingsPageProps {
  onOpenMobileSidebar?: () => void;
}

export function SettingsPage({ onOpenMobileSidebar }: SettingsPageProps = {}) {
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
  const [showImportDialog, setShowImportDialog] = useState(false);
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title="Settings" onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      <h1 className="text-lg font-bold text-zinc-900 dark:text-white mb-6">Settings</h1>

      <LinearIntegrationSection status={linearStatus} onStatus={setLinearStatus} />

      <ModelCredentialsSection
        profiles={profiles}
        onAdd={() => { setEditingProfile(null); setShowProfileSheet(true); }}
        onEdit={(p) => { setEditingProfile(p); setShowProfileSheet(true); }}
        onDelete={handleDeleteProfile}
        onImport={() => setShowImportDialog(true)}
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-8">
      {/* Session Resume */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">Runtime</h2>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-zinc-900 dark:text-white">Session Resume</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">When enabled, new agent sessions resume from where they left off. Turning off only affects newly started sessions.</div>
            </div>
            <button
              onClick={handleSessionResumeToggle}
              disabled={sessionResumeSaving}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-60 ${
                sessionResume ? "bg-violet-500" : "bg-zinc-300 dark:bg-zinc-700"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  sessionResume ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
          <div className="text-xs text-zinc-400 dark:text-zinc-500">
            {sessionResumeSaved && <span className="text-emerald-500">Saved!</span>}
          </div>
        </div>
      </div>

      {/* Auto-Summary */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">Auto-Summary</h2>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-zinc-900 dark:text-white">Enable Auto-Summary</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Automatically summarize when message count exceeds threshold</div>
            </div>
            <button
              onClick={() => handleSummaryChange({ autoEnabled: !summarySettings.autoEnabled })}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${
                summarySettings.autoEnabled ? "bg-violet-500" : "bg-zinc-300 dark:bg-zinc-700"
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                summarySettings.autoEnabled ? "translate-x-5" : "translate-x-0"
              }`} />
            </button>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="text-xs text-zinc-500 dark:text-zinc-400 block mb-1">Threshold (messages)</label>
              <input
                type="number"
                value={summarySettings.threshold}
                onChange={(e) => handleSummaryChange({ threshold: parseInt(e.target.value) || 200 })}
                min={50}
                max={1000}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-900 dark:text-white"
              />
            </div>
            <div className="flex-1">
              <label className="text-xs text-zinc-500 dark:text-zinc-400 block mb-1">Keep latest (messages)</label>
              <input
                type="number"
                value={summarySettings.keepCount}
                onChange={(e) => handleSummaryChange({ keepCount: parseInt(e.target.value) || 50 })}
                min={10}
                max={200}
                className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-900 dark:text-white"
              />
            </div>
          </div>

          <div className="text-xs text-zinc-400 dark:text-zinc-500">
            Summarizer's model can be configured in the Members page.
            {summarySaved && <span className="ml-2 text-emerald-500">Saved!</span>}
          </div>
        </div>
      </div>

      {/* Built-in Team Updates */}
      <div>
        <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">Built-in Team Updates</h2>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-zinc-900 dark:text-white">Check for updates automatically</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Installed version: {teamUpdateSettings?.installedVersion || "-"}</div>
            </div>
            <button
              onClick={handleTeamUpdateToggle}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer ${
                teamUpdateSettings?.dismissPermanent ? "bg-zinc-300 dark:bg-zinc-700" : "bg-violet-500"
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
            className="px-3 py-1.5 text-xs border rounded bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 cursor-pointer disabled:opacity-60"
          >
            {checkingTeamUpdates ? "Checking..." : "Check now"}
          </button>
        </div>
      </div>

      </div>

    </div>
    {showProfileSheet && (
      <CredentialProfileSheet
        profile={editingProfile}
        onClose={() => setShowProfileSheet(false)}
        onSaved={async () => { setShowProfileSheet(false); await refreshProfiles(); }}
      />
    )}
    {showImportDialog && (
      <PiConfigImportDialog
        onClose={() => setShowImportDialog(false)}
        onImported={async () => { setShowImportDialog(false); await refreshProfiles(); }}
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
      <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-4">Integrations</h2>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 w-8 h-8 rounded bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center"><Link2 size={16} /></div>
            <div>
              <div className="text-sm font-medium text-zinc-900 dark:text-white">Linear</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Sync Bossmode room tasks to Linear issues. API key is stored locally and never exposed to agents.</div>
              {status.connected && <div className="text-xs text-emerald-500 mt-1">Connected as {status.viewer?.name || "Linear user"}</div>}
              {!status.connected && status.error && <div className="text-xs text-amber-500 mt-1">Connection error: {status.error}</div>}
            </div>
          </div>
          {status.connected && <button onClick={disconnect} disabled={saving} className="px-3 py-1.5 border rounded-lg text-sm text-zinc-700 dark:text-zinc-300 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 cursor-pointer disabled:opacity-50">Disconnect</button>}
        </div>
        {!status.connected && (
          <div className="flex gap-2">
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="lin_api_..." className="flex-1 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-sm text-zinc-900 dark:text-white" />
            <button onClick={connect} disabled={saving || !apiKey.trim()} className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed">{saving ? "Connecting..." : "Connect Linear"}</button>
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

function ModelCredentialsSection({ profiles, onAdd, onEdit, onDelete, onImport }: {
  profiles: PublicModelCredentialProfile[];
  onAdd: () => void;
  onEdit: (profile: PublicModelCredentialProfile) => void;
  onDelete: (profile: PublicModelCredentialProfile) => void;
  onImport: () => void;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4 gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Model Credentials</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Configure provider access once, then choose available models for each member.</p>
        </div>
        <div className="flex items-center gap-2">
          {profiles.length > 0 && <button onClick={onImport} className="inline-flex items-center gap-1.5 px-3 py-1.5 border rounded-lg bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 text-sm cursor-pointer"><Download size={14} /> Import from pi</button>}
          <button onClick={onAdd} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg cursor-pointer">
            <Plus size={14} /> Add credential
          </button>
        </div>
      </div>
      {profiles.length === 0 ? (
        <div className="bg-white dark:bg-zinc-900 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg p-8 text-center">
          <KeyRound size={22} className="mx-auto text-zinc-400 dark:text-zinc-600 mb-3" />
          <div className="text-sm font-medium text-zinc-900 dark:text-white">No model credentials yet</div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 max-w-md mx-auto">Add an API key, OAuth account, proxy endpoint, or local no-auth endpoint. Models you add here become selectable in Member settings.</p>
          <button onClick={onAdd} className="mt-4 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg cursor-pointer">Add credential</button>
          <div className="my-3 text-xs text-zinc-400 dark:text-zinc-600">── or ──</div>
          <button onClick={onImport} className="px-3 py-1.5 border rounded-lg bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 text-sm cursor-pointer">Import from pi config</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {profiles.map((profile) => (
            <div key={profile.id} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-white truncate">{profile.name}</h3>
                    {profile.isDefault && <Badge tone="success">Default</Badge>}
                    {!profile.enabled && <Badge tone="neutral">Disabled</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <code className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{profile.providerSlug}</code>
                    <span>{profile.protocol}</span><span>·</span><span>{profile.authType}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => onEdit(profile)} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer" title="Edit"><Pencil size={14} /></button>
                  <button onClick={() => onDelete(profile)} className="text-zinc-400 hover:text-red-500 cursor-pointer" title="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
              {profile.baseUrl && <div className="text-[11px] text-zinc-500 dark:text-zinc-500 font-mono truncate mb-3">{profile.baseUrl}</div>}
              <div className="rounded-md bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-800 p-3">
                <div className="flex items-center justify-between mb-2"><span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{profile.models.length} models</span><span className="text-[11px] text-zinc-400 dark:text-zinc-500">{profile.hasSecret ? "Secret configured" : profile.authType}</span></div>
                <div className="space-y-1">
                  {profile.models.slice(0, 3).map((m) => <div key={m.id} className="flex items-center justify-between gap-2 text-xs"><code className="text-zinc-700 dark:text-zinc-300 truncate">{profile.providerSlug}/{m.id}</code>{m.contextWindow ? <span className="text-zinc-400 dark:text-zinc-500 shrink-0">{Math.round(m.contextWindow / 1000)}k ctx · {m.metadataSource === "pi_catalog" ? "pi catalog" : "endpoint"}</span> : <span className="text-zinc-400 dark:text-zinc-500 shrink-0">metadata unknown</span>}</div>)}
                  {profile.models.length > 3 && <div className="text-[11px] text-zinc-500">+{profile.models.length - 3} more</div>}
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-3"><button onClick={() => onEdit(profile)} className="px-3 py-1.5 text-xs border rounded-lg bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 cursor-pointer">Edit</button></div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PiConfigImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const { toast } = useDialog();
  const [preview, setPreview] = useState<PiConfigImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overwrite, setOverwrite] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    getPiConfigPreview()
      .then((p) => {
        setPreview(p);
        setSelected(new Set(p.providers.filter((provider) => provider.importable && !provider.existingProfileId).map((provider) => provider.providerSlug)));
      })
      .catch((err) => toast(err.message, "error"))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (slug: string) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(slug) ? next.delete(slug) : next.add(slug);
    return next;
  });
  const toggleOverwrite = (slug: string) => setOverwrite((prev) => {
    const next = new Set(prev);
    next.has(slug) ? next.delete(slug) : next.add(slug);
    return next;
  });

  const handleImport = async () => {
    setImporting(true);
    try {
      const result = await importPiConfig({ providers: Array.from(selected), overwriteProviderSlugs: Array.from(overwrite) });
      toast(`Imported ${result.imported.length}, overwritten ${result.overwritten.length}, skipped ${result.skipped.length}`);
      onImported();
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setImporting(false);
    }
  };

  return (
    <Sheet open onClose={onClose} size="md" closeOnOverlayClick={false}>
      <div className="bg-white dark:bg-zinc-900 rounded-lg p-5 w-full space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">Import from pi config</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Preview reads legacy pi config and copies references into Bossmode credentials. Secrets are not resolved in preview.</p>
        </div>
        {loading && <div className="text-sm text-zinc-500">Scanning pi config...</div>}
        {!loading && preview && !preview.found && (
          <div className="rounded border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-3 text-sm text-amber-700 dark:text-amber-300">No pi config found at {preview.piAgentDir}. Please add credentials manually.</div>
        )}
        {!loading && preview?.found && (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            <div className="text-xs text-zinc-500 dark:text-zinc-400">Found in <code>{preview.piAgentDir}</code></div>
            {preview.providers.map((provider) => (
              <div key={provider.providerSlug} className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-3">
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={selected.has(provider.providerSlug)} disabled={!provider.importable} onChange={() => toggle(provider.providerSlug)} className="mt-1" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-zinc-900 dark:text-white">{provider.displayName}</span>
                      <code className="text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{provider.providerSlug}</code>
                      {provider.existingProfileId && <Badge tone="neutral">Existing</Badge>}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{provider.modelCount} models · {provider.authSource} · {provider.secretPreview}</div>
                    {provider.warnings.length > 0 && <div className="text-xs text-amber-500 mt-1">{provider.warnings.join("; ")}</div>}
                    {provider.existingProfileId && provider.importable && (
                      <label className="mt-2 flex items-center gap-2 text-xs text-zinc-500">
                        <input type="checkbox" checked={overwrite.has(provider.providerSlug)} onChange={() => toggleOverwrite(provider.providerSlug)} />
                        Overwrite existing provider
                      </label>
                    )}
                  </div>
                </label>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer">Cancel</button>
          <button type="button" onClick={handleImport} disabled={importing || selected.size === 0} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg cursor-pointer">{importing ? "Importing..." : "Import"}</button>
        </div>
      </div>
    </Sheet>
  );
}

function Badge({ tone, children }: { tone: "success" | "neutral"; children: React.ReactNode }) {
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${tone === "success" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>{children}</span>;
}

function CredentialProfileSheet({ profile, onClose, onSaved }: { profile: PublicModelCredentialProfile | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useDialog();
  const [form, setForm] = useState<ModelCredentialProfileInput>(() => ({
    name: profile?.name || "",
    providerSlug: profile?.providerSlug || "",
    protocol: profile?.protocol || "openai-responses",
    baseUrl: profile?.baseUrl || "",
    authType: profile?.authType || "api_key",
    apiKey: "",
    requestProfile: profile?.requestProfile || "standard",
    enabled: profile?.enabled ?? true,
    isDefault: profile?.isDefault ?? false,
    models: profile?.models?.length ? profile.models : [{ id: "", input: ["text"], metadataSource: "unknown" }],
  }));
  const [saving, setSaving] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [oauthJob, setOauthJob] = useState<OAuthLoginJob | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const inputCls = "w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600";
  const fetchModels = async () => {
    setFetchingModels(true);
    setFetchError(null);
    try {
      const result = await discoverModelCredentialModels({ ...form, id: profile?.id });
      if (result.models.length === 0) {
        setFetchError("No models found. You can still add models manually.");
      } else {
        setForm({ ...form, models: result.models });
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
      const payload = { ...form, requestProfile: form.protocol === "anthropic-messages" ? form.requestProfile : "standard" as const };
      if (profile) await updateModelCredentialProfile(profile.id, payload);
      else await createModelCredentialProfile(payload);
      onSaved();
    } catch (err: any) { toast(err.message, "error"); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <div className="p-5 space-y-5">
        <div><h3 className="text-base font-semibold text-zinc-900 dark:text-white">{profile ? "Edit" : "Add"} credential profile</h3><p className="text-xs text-zinc-500 mt-1">Provider connection + model catalog. Raw secrets are never shown after save.</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <Field label="Name"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenRouter main" /></Field>
            <Field label="Provider slug"><input className={inputCls} value={form.providerSlug} onChange={(e) => setForm({ ...form, providerSlug: e.target.value })} placeholder="openrouter" /></Field>
            <Field label="Protocol"><select className={inputCls} value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as ModelProtocol, requestProfile: e.target.value === "anthropic-messages" ? form.requestProfile : "standard" })}>{PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
            <Field label="Base URL"><input className={inputCls} value={form.baseUrl || ""} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
            <Field label="Auth type"><select className={inputCls} value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as ModelAuthType })}>{AUTH_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
            {form.authType === "api_key" && <Field label="API key"><input type="password" className={inputCls} value={form.apiKey || ""} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={profile?.hasSecret ? "Leave blank to keep existing key" : "sk-..."} /></Field>}
            {form.authType === "oauth" && <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
              <Field label="OAuth provider"><select className={inputCls} value={form.oauthProviderId || ""} onChange={(e) => setForm({ ...form, oauthProviderId: e.target.value })}><option value="">Select provider...</option>{["anthropic", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex"].map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
              <div className="flex items-center gap-2 text-xs"><span className={profile?.hasSecret ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}>{profile?.hasSecret ? "OAuth connected" : "OAuth not connected"}</span><button type="button" disabled={oauthBusy || !form.oauthProviderId} onClick={startOAuth} className="text-blue-500 hover:text-blue-400 disabled:text-zinc-400 disabled:cursor-not-allowed">Start login</button>{oauthJob && oauthJob.status === "awaiting_input" && <button type="button" disabled={oauthBusy} onClick={cancelOAuth} className="text-zinc-500 hover:text-zinc-400">Cancel</button>}</div>
              {oauthJob && <div className="text-xs text-zinc-600 dark:text-zinc-400 space-y-1"><div>Status: {oauthJob.status}</div><div>{oauthJob.prompt}</div>{oauthJob.authUrl && <div>Auth URL: <code className="break-all">{oauthJob.authUrl}</code></div>}{oauthJob.userCode && <div>Code: <code>{oauthJob.userCode}</code></div>}{oauthJob.error && <div className="text-red-500">{oauthJob.error}</div>}{oauthJob.status === "awaiting_input" && <div className="flex gap-2"><input className={inputCls} value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} placeholder="Paste OAuth input if requested" /><button type="button" disabled={oauthBusy} onClick={submitOAuth} className="px-3 py-2 text-xs bg-blue-600 text-white rounded disabled:bg-zinc-700">Submit</button></div>}</div>}
              <p className="text-xs text-zinc-500">Tokens are stored locally and are never shown in the API or UI.</p>
            </div>}
            <div className="text-xs rounded border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 p-3">Secrets are stored locally in plaintext with 0600 file permissions. Use a scoped key when possible.</div>
            {form.protocol === "anthropic-messages" && <div className="rounded border border-zinc-200 dark:border-zinc-800 p-3 space-y-2"><label className="flex gap-2 text-xs text-zinc-700 dark:text-zinc-300"><input type="checkbox" checked={form.requestProfile === "anthropic_claude_code_oauth"} onChange={(e) => setForm({ ...form, requestProfile: e.target.checked ? "anthropic_claude_code_oauth" : "standard" })} /> Enable Claude Code / OAuth-compatible request handling</label><p className="text-xs text-zinc-500 dark:text-zinc-400">Only enable this if your proxy explicitly requires Anthropic OAuth or Claude Code compatible requests. It changes auth headers, beta headers, system identity, and tool naming. Leave off for standard Anthropic-compatible proxies.</p></div>}
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between"><h4 className="text-sm font-medium text-zinc-900 dark:text-white">Models</h4><div className="flex gap-3"><button type="button" onClick={fetchModels} disabled={fetchingModels} className="text-xs text-blue-500 hover:text-blue-400 disabled:text-zinc-400 disabled:cursor-not-allowed">{fetchingModels ? "Fetching..." : "Fetch models"}</button><button type="button" onClick={() => setForm({ ...form, models: [...form.models, { id: "", input: ["text"], metadataSource: "unknown" }] })} className="text-xs text-blue-500">Add model manually</button></div></div>
            {fetchError && <div className="text-xs rounded border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 p-2">{fetchError} Manual add remains available.</div>}
            {form.models.map((m, i) => <div key={i} className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 space-y-2">
              <input className={inputCls} value={m.id} onChange={(e) => { const models = [...form.models]; models[i] = { ...m, id: e.target.value }; setForm({ ...form, models }); }} placeholder="model id" />
              <input className={inputCls} value={m.name || ""} onChange={(e) => { const models = [...form.models]; models[i] = { ...m, name: e.target.value }; setForm({ ...form, models }); }} placeholder="display name (optional)" />
              <div className="text-[11px] text-zinc-500 dark:text-zinc-500">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx · ${m.metadataSource === "pi_catalog" ? "from pi catalog" : "from endpoint"}` : "metadata unknown"}</div>
              <button type="button" className="text-xs text-red-500" onClick={() => setForm({ ...form, models: form.models.filter((_, idx) => idx !== i) })}>Remove</button>
            </div>)}
          </div>
        </div>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="px-4 py-2 text-sm text-zinc-500">Cancel</button><button onClick={save} disabled={saving} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg">{saving ? "Saving..." : "Save"}</button></div>
      </div>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">{label}</span>{children}</label>;
}
