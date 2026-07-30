import { useState, useEffect } from "react";
import { Plus, KeyRound, Pencil, Trash2, Link2, PlugZap, RefreshCw } from "lucide-react";
import { MobileTopBar } from "../components/MobileTopBar";
import type { RuntimeSettings, PiTransportSetting, McpSettings, McpServerSummary, PublicModelCredentialProfile, ModelCredentialProfileInput, ModelDefinitionConfig, ModelProtocol, ModelAuthType, OAuthLoginJob, LinearIntegrationStatus, PublicModelProvider, ExtensionRecord, ExtensionsListResponse, ModelCatalogStatus } from "../api/client";
import {
  getRuntimeSettings,
  updateRuntimeSettings,
  getMcpSettings,
  updateMcpSettings,
  checkMcpServers,
  getModelCredentialProfiles,
  createModelCredentialProfile,
  updateModelCredentialProfile,
  deleteModelCredentialProfile,
  getModelCatalogStatus,
  updateModelCatalogSettings,
  refreshModelCatalog,
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
  getExtensions,
  installExtension,
  uninstallExtension,
} from "../api/client";
import { Sheet } from "../components/Sheet";
import { UsagePage } from "./UsagePage";
import { useDialog } from "../components/dialogs";
import type { SettingsSection } from "../components/Sidebar";
import { userActionError } from "../utils/user-error";

interface SettingsPageProps {
  section?: SettingsSection;
  onOpenMobileSidebar?: () => void;
}

const SECTION_META: Record<SettingsSection, { title: string; desc: string }> = {
  models: { title: "Models", desc: "Connect providers and choose available models." },
  runtime: { title: "Runtime", desc: "Session continuity and connection recovery." },
  extensions: { title: "Extensions", desc: "Install pi agent extensions managed by Bossmode." },
  integrations: { title: "Integrations", desc: "Connect external tools and services." },
  usage: { title: "Usage", desc: "Token consumption by identity, room and time" },
};

function normalizeRuntimeSettings(settings: RuntimeSettings): RuntimeSettings {
  return {
    sessionResume: settings.sessionResume !== false,
    codexTransport: settings.codexTransport || "auto",
    websocketConnectTimeoutMs: settings.websocketConnectTimeoutMs ?? 15000,
    httpIdleTimeoutMs: settings.httpIdleTimeoutMs === null ? null : settings.httpIdleTimeoutMs,
  };
}

function secondsFromMs(ms: number | undefined, fallbackSeconds: number): number {
  return Math.round((ms ?? fallbackSeconds * 1000) / 1000);
}

export function oauthStatusLabel(status: OAuthLoginJob["status"]): string {
  switch (status) {
    case "starting": return "Waiting for sign-in";
    case "awaiting_device": return "Waiting for sign-in";
    case "awaiting_input": return "Waiting for code";
    case "completed": return "Connected";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
    default: return "Connecting";
  }
}

export function SettingsPage({ section = "models", onOpenMobileSidebar }: SettingsPageProps = {}) {
  const { toast, confirm } = useDialog();
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>({
    sessionResume: true,
    codexTransport: "auto",
    websocketConnectTimeoutMs: 15000,
  });
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeSaved, setRuntimeSaved] = useState(false);
  const [profiles, setProfiles] = useState<PublicModelCredentialProfile[]>([]);
  const [editingProfile, setEditingProfile] = useState<PublicModelCredentialProfile | null>(null);
  const [showProfileSheet, setShowProfileSheet] = useState(false);
  const [showConnectProvider, setShowConnectProvider] = useState(false);
  const [linearStatus, setLinearStatus] = useState<LinearIntegrationStatus>({ connected: false });
  const [mcpSettings, setMcpSettings] = useState<McpSettings | null>(null);
  const [extensionsData, setExtensionsData] = useState<ExtensionsListResponse | null>(null);
  const [extPackage, setExtPackage] = useState("");
  const [extBusy, setExtBusy] = useState(false);
  const [extError, setExtError] = useState<string | null>(null);

  const refreshExtensions = () => getExtensions().then(setExtensionsData).catch(console.error);

  useEffect(() => {
    getRuntimeSettings().then((v) => setRuntimeSettings(normalizeRuntimeSettings(v))).catch(console.error);
    getModelCredentialProfiles().then(setProfiles).catch(console.error);
    getLinearIntegrationStatus().then(setLinearStatus).catch(console.error);
    getMcpSettings().then(setMcpSettings).catch(console.error);
    refreshExtensions();
  }, []);

  const handleRuntimeChange = async (updates: Partial<RuntimeSettings>) => {
    const previous = runtimeSettings;
    const next = normalizeRuntimeSettings({ ...runtimeSettings, ...updates });
    setRuntimeSettings(next);
    setRuntimeSaving(true);
    try {
      const saved = await updateRuntimeSettings(next);
      setRuntimeSettings(normalizeRuntimeSettings(saved));
      setRuntimeSaved(true);
      setTimeout(() => setRuntimeSaved(false), 2000);
    } catch (err: any) {
      console.error("Failed to save runtime settings:", err);
      toast(userActionError("save Runtime settings"), "error");
      setRuntimeSettings(previous);
    } finally {
      setRuntimeSaving(false);
    }
  };

  const handleSessionResumeToggle = async () => {
    await handleRuntimeChange({ sessionResume: !runtimeSettings.sessionResume });
  };

  const handleRuntimeNetworkSave = async () => {
    const websocketConnectTimeoutMs = runtimeSettings.websocketConnectTimeoutMs ?? 15000;
    const wsSeconds = Math.round(websocketConnectTimeoutMs / 1000);
    if (wsSeconds < 5 || wsSeconds > 180) {
      toast("WebSocket connect timeout must be between 5 and 180 seconds", "error");
      return;
    }
    await handleRuntimeChange({
      codexTransport: runtimeSettings.codexTransport || "auto",
      websocketConnectTimeoutMs,
      httpIdleTimeoutMs: runtimeSettings.httpIdleTimeoutMs,
    });
  };

  const refreshProfiles = async () => setProfiles(await getModelCredentialProfiles());

  const handleDeleteProfile = async (profile: PublicModelCredentialProfile) => {
    if (!(await confirm(`Delete model credential "${profile.name}"?`))) return;
    try { await deleteModelCredentialProfile(profile.id); await refreshProfiles(); }
    catch (err) { console.error("Failed to delete model connection", err); toast(userActionError("delete this model connection"), "error"); }
  };

  const handleSyncCatalog = async () => {
    try {
      const result = await refreshModelCatalog();
      await refreshProfiles();
      if (result.error) {
        toast(`Catalog sync finished with issues: ${result.error}`, "info");
      } else {
        toast(`Catalog synced · ${result.modelCount} models · ${result.freshnessLabel}`, "success");
      }
    } catch (err) {
      console.error("Failed to sync catalog", err);
      toast(userActionError("sync the model catalog"), "error");
    }
  };

  const meta = SECTION_META[section];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
      <MobileTopBar title={meta.title} onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 flex flex-col overflow-y-auto">
      <div className={`w-full ${section === "usage" ? "" : "max-w-3xl"} mx-auto px-6 pt-7 pb-20`}>
      <div className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink-1">{meta.title}</h1>
        <p className="text-xs text-ink-3 mt-1">{meta.desc}</p>
      </div>

      {section === "usage" && <UsagePage />}

      {section === "integrations" && (
        <div className="space-y-6">
          <McpIntegrationSection settings={mcpSettings} onSettings={setMcpSettings} />
          <LinearIntegrationSection status={linearStatus} onStatus={setLinearStatus} />
        </div>
      )}

      {section === "models" && (
        <ModelCredentialsSection
          profiles={profiles}
          onAdd={() => setShowConnectProvider(true)}
          onCustom={() => { setEditingProfile(null); setShowProfileSheet(true); }}
          onEdit={(p) => { setEditingProfile(p); setShowProfileSheet(true); }}
          onDelete={handleDeleteProfile}
          onSyncCatalog={handleSyncCatalog}
        />
      )}

      {/* Runtime */}
      {section === "runtime" && (
      <div className="space-y-4">
        <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-ink-1">Continue previous sessions</div>
              <div className="text-xs text-ink-3 mt-0.5">Continue each member’s conversation after Bossmode restarts. Changes apply to sessions started afterward.</div>
            </div>
            <button
              onClick={handleSessionResumeToggle}
              disabled={runtimeSaving}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-60 ${
                runtimeSettings.sessionResume ? "bg-accent" : "bg-surface-3"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  runtimeSettings.sessionResume ? "translate-x-5" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>

        <details className="bg-surface-1 border border-line rounded-lg p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-1">Connection troubleshooting</summary>
          <div className="mt-4 space-y-4">
          <p className="text-xs text-ink-3">Automatic is recommended. Change these options only when a provider connection repeatedly fails.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-2">Transport mode</span>
              <select
                className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1"
                value={runtimeSettings.codexTransport || "auto"}
                onChange={(e) => setRuntimeSettings({ ...runtimeSettings, codexTransport: e.target.value as PiTransportSetting })}
              >
                <option value="auto">Automatic (recommended)</option>
                <option value="websocket-cached">WebSocket cached</option>
                <option value="websocket">WebSocket</option>
                <option value="sse">SSE</option>
              </select>
              <span className="block text-[11px] text-ink-4">Choose a specific mode only when Automatic cannot maintain a connection.</span>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-2">Connection timeout</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={5}
                  max={180}
                  step={1}
                  disabled={(runtimeSettings.codexTransport || "auto") === "sse"}
                  className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 disabled:opacity-50 disabled:cursor-not-allowed"
                  value={secondsFromMs(runtimeSettings.websocketConnectTimeoutMs, 15)}
                  onChange={(e) => setRuntimeSettings({ ...runtimeSettings, websocketConnectTimeoutMs: Math.max(0, Number(e.target.value || 0)) * 1000 })}
                />
                <span className="text-xs text-ink-3">sec</span>
              </div>
              <span className="block text-[11px] text-ink-4">How long Bossmode waits while establishing a provider connection.</span>
            </label>
          </div>
          <details className="rounded-md border border-line-soft bg-inset/40 p-3">
            <summary className="cursor-pointer text-xs font-medium text-ink-2">Advanced</summary>
            <label className="mt-3 block space-y-1 max-w-sm">
              <span className="text-xs font-medium text-ink-2">HTTP idle timeout</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1"
                  value={runtimeSettings.httpIdleTimeoutMs == null ? "" : Math.round(runtimeSettings.httpIdleTimeoutMs / 1000)}
                  placeholder="SDK default"
                  onChange={(e) => setRuntimeSettings({ ...runtimeSettings, httpIdleTimeoutMs: e.target.value === "" ? null : Math.max(0, Number(e.target.value || 0)) * 1000 })}
                />
                <span className="text-xs text-ink-3">sec</span>
              </div>
              <span className="block text-[11px] text-ink-4">Leave empty to use the recommended default.</span>
            </label>
          </details>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-ink-4">Changes apply when a member starts or restarts.</p>
            <button
              onClick={handleRuntimeNetworkSave}
              disabled={runtimeSaving}
              className="px-3 py-1.5 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed"
            >
              {runtimeSaving ? "Saving..." : "Save connection settings"}
            </button>
          </div>
          {runtimeSaved && <div className="text-xs text-onair">Saved!</div>}
          </div>
        </details>
      </div>
      )}

      {/* Extensions — prototype: extensions-install-v1 */}
      {section === "extensions" && (
      <div className="space-y-4">
        <p className="text-sm text-ink-3 leading-relaxed">
          Extensions add capabilities to your members — install one and every member can use its tools after Reload. Same model as the <b className="text-ink-2">pi CLI</b>.
        </p>

        <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-3">
          <div>
            <div className="text-sm font-medium text-ink-1">Install an extension</div>
            <div className="text-xs text-ink-3 mt-0.5">
              Enter a package source — an npm package, a git repo, a URL, or a local path.
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={extPackage}
              onChange={(e) => setExtPackage(e.target.value)}
              placeholder="npm:pi-web-access"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 rounded-lg border border-line bg-inset px-3 py-2 text-sm text-ink-1 outline-none focus:border-line-strong font-mono placeholder:text-ink-4"
            />
            <button
              type="button"
              disabled={extBusy || !extPackage.trim()}
              onClick={async () => {
                setExtBusy(true);
                setExtError(null);
                try {
                  await installExtension(extPackage.trim());
                  await refreshExtensions();
                  setExtPackage("");
                  toast(`Installed. Reload members to use new tools.`, "success");
                } catch (err) {
                  const msg = err instanceof Error ? err.message : userActionError("install extension");
                  setExtError(msg);
                  toast(msg, "error");
                } finally {
                  setExtBusy(false);
                }
              }}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-accent-contrast hover:opacity-90 disabled:opacity-50 cursor-pointer"
            >
              {extBusy ? "Installing…" : "Install"}
            </button>
          </div>
          {extError && <div className="text-xs text-blocked">{extError}</div>}

          {/* Source format examples — flat 2×2 cards (approved prototype) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            {([
              { kind: "npm:", example: "npm:@foo/bar" },
              { kind: "git:", example: "git:github.com/user/repo" },
              { kind: "https:", example: "https://github.com/user/repo" },
              { kind: "path:", example: "./local/path" },
            ] as const).map((ex) => (
              <button
                key={ex.kind}
                type="button"
                onClick={() => setExtPackage(ex.example)}
                className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-inset px-3 py-2.5 text-left hover:border-line-strong hover:bg-surface-2 cursor-pointer transition-colors"
              >
                <span className="shrink-0 rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] font-bold text-accent-ink">{ex.kind}</span>
                <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-3">{ex.example}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1 border-t border-line-soft">
            <span className="text-[11.5px] text-ink-4">Not sure what to install? Browse the pi package catalog.</span>
            <a
              href="https://pi.dev/packages"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[12px] font-semibold text-accent-ink hover:underline shrink-0"
            >
              Browse packages ↗
            </a>
          </div>

          <div className="text-[11px] text-ink-4">
            Some extensions need keys in <code className="rounded bg-surface-3 px-1">{extensionsData?.webSearchConfig.path || "~/.pi/web-search.json"}</code>
            {" · "}
            {extensionsData?.webSearchConfig.exists ? "found" : "not configured yet (optional for Exa default)"}
          </div>
        </div>

        <div className="bg-surface-1 border border-line rounded-lg">
          <div className="px-4 pt-3.5 pb-1">
            <div className="text-sm font-medium text-ink-1">
              Installed{" "}
              <span className="text-[10px] font-semibold text-ink-4">{extensionsData?.extensions?.length ?? 0}</span>
            </div>
            <div className="text-xs text-ink-3 mt-0.5">Active for all members after Reload. Uninstall to remove an extension&apos;s tools.</div>
          </div>
          <div className="divide-y divide-line-soft mt-1">
            {(extensionsData?.extensions ?? []).length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-ink-4">
                <div className="text-2xl mb-2 opacity-40">⧉</div>
                No extensions installed yet.
                <br />
                Install one above, or{" "}
                <a href="https://pi.dev/packages" target="_blank" rel="noopener noreferrer" className="text-accent-ink hover:underline">browse the catalog</a>.
              </div>
            ) : (
              (extensionsData?.extensions ?? []).map((ext: ExtensionRecord) => (
                <div key={ext.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-ink-1">{ext.name}</span>
                      <span className="text-[10px] text-ink-4 font-mono">{ext.id}</span>
                      {ext.version && <span className="text-[10px] text-ink-4 font-mono">{ext.version}</span>}
                      {!ext.error && ext.extensionPaths.length > 0 && (
                        <span className="rounded-full border border-onair/40 bg-onair/10 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-onair">active</span>
                      )}
                    </div>
                    {ext.description && <p className="mt-0.5 text-xs text-ink-3 line-clamp-2">{ext.description}</p>}
                    <p className="mt-0.5 text-[10.5px] text-ink-4">
                      {ext.extensionPaths.length} entry · {ext.skillPaths.length} skill dir
                    </p>
                    {ext.error && <p className="mt-0.5 text-xs text-blocked">{ext.error}</p>}
                  </div>
                  <button
                    type="button"
                    disabled={extBusy}
                    onClick={async () => {
                      if (!(await confirm(`Uninstall ${ext.name}?`))) return;
                      setExtBusy(true);
                      try {
                        await uninstallExtension(ext.name);
                        await refreshExtensions();
                        toast(`Uninstalled ${ext.name}.`, "success");
                      } catch (err) {
                        toast(err instanceof Error ? err.message : userActionError("uninstall extension"), "error");
                      } finally {
                        setExtBusy(false);
                      }
                    }}
                    className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink-3 hover:text-blocked hover:border-blocked/40 cursor-pointer"
                  >
                    Uninstall
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      )}

      </div>
    </div>
    {showConnectProvider && (
      <ConnectProviderSheet
        profiles={profiles}
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

function McpIntegrationSection({ settings, onSettings }: { settings: McpSettings | null; onSettings: (settings: McpSettings) => void }) {
  const { toast } = useDialog();
  const [enabled, setEnabled] = useState(false);
  const [configText, setConfigText] = useState("{\n  \"mcpServers\": {}\n}");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);

  const servers = settings?.servers || [];

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setConfigText(settings.configText || "{\n  \"mcpServers\": {}\n}");
  }, [settings?.enabled, settings?.configText]);

  const save = async () => {
    setSaving(true);
    try {
      const next = await updateMcpSettings({ enabled, configText });
      onSettings(next);
      setEnabled(next.enabled);
      setConfigText(next.configText);
      toast("MCP settings saved", "success");
    } catch (err) {
      console.error("Failed to save MCP settings", err);
      toast(userActionError("save MCP server settings", "Check the configuration, then try again."), "error");
    } finally {
      setSaving(false);
    }
  };

  const check = async (server?: string) => {
    setChecking(server || "__all__");
    try {
      const next = await checkMcpServers(server, 10000);
      onSettings(next);
      toast(server ? `Checked ${server}` : "Checked MCP servers", "success");
    } catch (err) {
      console.error("Failed to check MCP servers", err);
      toast(userActionError("check MCP servers", "Check the server configuration, then try again."), "error");
    } finally {
      setChecking(null);
    }
  };

  const statusClass = (status?: string) => {
    if (status === "available") return "text-onair border-onair/30 bg-onair/10";
    if (status === "auth-required") return "text-think border-think/30 bg-think/10";
    if (status === "unavailable" || status === "invalid-config") return "text-blocked border-blocked/30 bg-blocked-dim/40";
    return "text-ink-4 border-line bg-surface-2";
  };

  return (
    <section>
      <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider mb-4">MCP servers</h2>
      <div className="space-y-4">
        <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-ink-1">MCP servers</div>
              <div className="text-xs text-ink-3 mt-0.5">Add the servers you use here, then assign them from each member profile.</div>
              {settings && <div className="text-[11px] text-ink-4 mt-1">{settings.serverCount} server{settings.serverCount === 1 ? "" : "s"} configured</div>}
            </div>
            <button
              onClick={() => setEnabled(!enabled)}
              disabled={!settings || saving}
              className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer disabled:opacity-60 ${enabled ? "bg-accent" : "bg-surface-3"}`}
              aria-label={enabled ? "Disable MCP servers" : "Enable MCP servers"}
            >
              <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>
          {servers.length === 0 && <div className="text-xs text-ink-4 rounded bg-inset border border-line-soft p-3">No MCP servers configured.</div>}
          <details className="rounded border border-line-soft bg-inset/50 p-3">
            <summary className="cursor-pointer text-xs font-medium text-ink-2">Advanced configuration</summary>
            <div className="mt-3 space-y-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-2">Server configuration</span>
                <textarea
                  className="w-full min-h-56 font-mono bg-inset border border-line rounded px-3 py-2 text-xs text-ink-1 leading-5"
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  spellCheck={false}
                  placeholder={'{\n  "mcpServers": {}\n}'}
                />
              </label>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11px] text-ink-4">Secrets stay on this device and are hidden after saving.</p>
                <button onClick={save} disabled={!settings || saving} className="px-3 py-1.5 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed">
                  {saving ? "Saving..." : "Save changes"}
                </button>
              </div>
            </div>
          </details>
        </div>

        <div className="bg-surface-1 border border-line rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-ink-1">Availability</div>
              <div className="text-xs text-ink-3 mt-0.5">Check whether your configured servers can connect.</div>
            </div>
            <button onClick={() => check()} disabled={!settings || servers.length === 0 || checking !== null} className="px-3 py-1.5 border border-line rounded-lg text-sm text-ink-2 hover:bg-surface-2 disabled:opacity-50">
              {checking === "__all__" ? "Checking..." : "Check all"}
            </button>
          </div>
          {servers.length === 0 && <div className="text-xs text-ink-4 rounded bg-inset border border-line-soft p-3">No MCP servers configured.</div>}
          {servers.map((server: McpServerSummary) => {
            const availability = server.availability;
            const status = availability?.status || "unchecked";
            return (
              <div key={server.name} className="rounded-md bg-inset/60 border border-line-soft p-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium text-ink-1 truncate">{server.name}</span>
                    <span className={`text-[10px] border rounded px-1.5 py-0.5 uppercase ${statusClass(status)}`}>{status}</span>
                  </div>
                  <div className="text-[11px] text-ink-4 mt-1">
                    {availability?.toolCount !== undefined ? `${availability.toolCount} tools · ` : ""}{server.assignedCount || 0} assignment{server.assignedCount === 1 ? "" : "s"}{availability?.checkedAt ? ` · ${new Date(availability.checkedAt).toLocaleTimeString()}` : ""}
                  </div>
                  {availability?.error && <div className="text-[11px] text-blocked mt-1">Connection unavailable. Check this server’s configuration.</div>}
                </div>
                <button onClick={() => check(server.name)} disabled={checking !== null} className="px-2 py-1 border border-line rounded text-xs text-ink-2 hover:bg-surface-2 disabled:opacity-50">
                  {checking === server.name ? "Checking..." : "Check"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
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
    } catch (err) { console.error("Failed to connect Linear", err); toast(userActionError("connect Linear", "Check the API key, then try again."), "error"); }
    finally { setSaving(false); }
  };

  const disconnect = async () => {
    if (!(await confirm("Disconnect Linear and clear room Linear bindings?"))) return;
    setSaving(true);
    try {
      const result = await disconnectLinearIntegration();
      onStatus({ connected: false });
      toast(`Linear disconnected. Cleared ${result.clearedRooms} Room bindings.`, "success");
    } catch (err) { console.error("Failed to disconnect Linear", err); toast(userActionError("disconnect Linear"), "error"); }
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

function ModelCredentialsSection({ profiles, onAdd, onCustom, onEdit, onDelete, onSyncCatalog }: {
  profiles: PublicModelCredentialProfile[];
  onAdd: () => void;
  onCustom: () => void;
  onEdit: (profile: PublicModelCredentialProfile) => void;
  onDelete: (profile: PublicModelCredentialProfile) => void;
  onSyncCatalog: () => void | Promise<void>;
}) {
  const { toast } = useDialog();
  const [expandedProfiles, setExpandedProfiles] = useState<Set<string>>(new Set());
  const [expandedModelLists, setExpandedModelLists] = useState<Set<string>>(new Set());
  const [catalogStatus, setCatalogStatus] = useState<ModelCatalogStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [savingInterval, setSavingInterval] = useState(false);

  const refreshCatalogStatus = () => {
    getModelCatalogStatus().then(setCatalogStatus).catch(() => setCatalogStatus(null));
  };
  useEffect(() => { refreshCatalogStatus(); }, []);

  const handleSyncCatalog = async () => {
    setSyncing(true);
    try {
      await onSyncCatalog();
      refreshCatalogStatus();
    } finally {
      setSyncing(false);
    }
  };

  const handleIntervalChange = async (days: number) => {
    setSavingInterval(true);
    try {
      const next = await updateModelCatalogSettings({ autoRefreshIntervalDays: days });
      setCatalogStatus({
        ...next.status,
        autoRefreshIntervalDays: next.autoRefreshIntervalDays,
        refreshDue: next.refreshDue,
      });
      toast(
        days <= 0 ? "Automatic catalog refresh turned off." : `Catalog will auto-refresh every ${days} day${days === 1 ? "" : "s"}.`,
        "success",
      );
    } catch (err) {
      console.error("Failed to update catalog settings", err);
      toast(userActionError("update catalog settings"), "error");
    } finally {
      setSavingInterval(false);
    }
  };

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

  const intervalDays = catalogStatus?.autoRefreshIntervalDays ?? 7;

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink-3 uppercase tracking-wider">Model providers</h2>
          <p className="text-xs text-ink-3 mt-1">Connect a provider, then choose its available models for each member.</p>
          {catalogStatus && (
            <p className="text-[11px] text-ink-4 mt-1" title={catalogStatus.fetchedAtIso || undefined}>
              {catalogStatus.freshnessLabel}
              {catalogStatus.modelCount > 0 ? ` · ${catalogStatus.modelCount} models in catalog` : ""}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span>Auto-refresh built-in catalog</span>
            <select
              className="bg-inset border border-line rounded px-2 py-1 text-[11px] text-ink-2 cursor-pointer"
              value={String(intervalDays)}
              disabled={savingInterval}
              onChange={(e) => { void handleIntervalChange(Number(e.target.value)); }}
            >
              <option value="0">Off</option>
              <option value="1">Every day</option>
              <option value="7">Every 7 days</option>
              <option value="30">Every 30 days</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => { void handleSyncCatalog(); }}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-line rounded-lg text-ink-2 hover:text-ink-1 hover:border-line-strong text-sm cursor-pointer disabled:opacity-50"
            title="Sync the built-in provider catalog from pi.dev"
          >
            <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
            {syncing ? "Syncing…" : "Sync catalog"}
          </button>
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
          <div className="text-sm font-medium text-ink-1">No model providers connected</div>
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
            const kind = profile.profileKind ?? "custom_endpoint";
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
                      <Badge tone={kind === "builtin_provider" ? "success" : "neutral"}>
                        {kind === "builtin_provider" ? "Built-in" : "Custom"}
                      </Badge>
                      {!profile.enabled && <Badge tone="neutral">Disabled</Badge>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                      <span>{profile.models.length} models</span><span>·</span><span>{profile.hasSecret ? "Connected" : "Connection needs attention"}</span>
                    </div>
                  </button>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => toggleProfile(profile.id)} className="px-2 py-1 text-xs text-ink-3 hover:text-ink-1 cursor-pointer" title={expanded ? "Collapse" : "Expand"}>{expanded ? "Collapse" : "Expand"}</button>
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
                        {visibleModels.map((m) => <div key={m.id} className="flex items-center justify-between gap-2 text-xs"><code className="text-ink-2 truncate">{profile.providerSlug}/{m.id}</code>{m.contextWindow ? <span className="text-ink-4 shrink-0">{Math.round(m.contextWindow / 1000)}k context</span> : null}</div>)}
                        {profile.models.length > 3 && (
                          <button type="button" onClick={() => toggleModels(profile.id)} className="text-[11px] text-accent-ink hover:opacity-80 cursor-pointer">
                            {modelsExpanded ? "Show less" : `+${profile.models.length - 3} more`}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-3">
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

function nextProviderProfileName(profiles: PublicModelCredentialProfile[], providerSlug: string, displayName: string): string {
  const existing = profiles.filter((p) => p.providerSlug === providerSlug && (p.profileKind ?? "custom_endpoint") === "builtin_provider");
  if (existing.length === 0) return displayName;
  const used = new Set(existing.map((p) => p.name));
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${displayName} ${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${displayName} ${existing.length + 1}`;
}

function ConnectProviderSheet({ profiles, onClose, onSaved }: { profiles: PublicModelCredentialProfile[]; onClose: () => void; onSaved: () => void }) {
  const { toast } = useDialog();
  const [providers, setProviders] = useState<PublicModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<PublicModelProvider | null>(null);
  const [authMode, setAuthMode] = useState<"api_key" | "oauth">("api_key");
  const [apiKey, setApiKey] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [oauthJob, setOauthJob] = useState<OAuthLoginJob | null>(null);
  const [oauthInput, setOauthInput] = useState("");

  useEffect(() => {
    getModelProviderCatalog()
      .then((items) => setProviders(items))
      .catch((err) => { console.error("Failed to load model providers", err); toast(userActionError("load model providers"), "error"); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setAuthMode(selected.defaultAuthMode);
    setName(nextProviderProfileName(profiles, selected.providerSlug, selected.displayName));
    setApiKey("");
    setApiUrl("");
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
      } catch (err) {
        window.clearInterval(timer);
        console.error("Failed to continue provider sign-in", err);
        toast(userActionError("continue provider sign-in", "Start sign-in again."), "error");
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
        name: name.trim() || nextProviderProfileName(profiles, selected.providerSlug, selected.displayName),
        baseUrlOverride: apiUrl.trim() || undefined,
      });
      toast("Provider connected", "success");
      onSaved();
    } catch (err) { console.error("Failed to connect model provider", err); toast(userActionError("connect this provider", "Check the key, then try again."), "error"); }
    finally { setBusy(false); }
  };

  const startOAuth = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setOauthJob(await startOAuthConnection({
        providerId: selected.providerSlug,
        name: name.trim() || nextProviderProfileName(profiles, selected.providerSlug, selected.displayName),
      }));
    } catch (err) { console.error("Failed to start provider sign-in", err); toast(userActionError("start provider sign-in"), "error"); }
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
    } catch (err) { console.error("Failed to submit provider sign-in code", err); toast(userActionError("submit the sign-in code", "Check the code, then try again."), "error"); }
    finally { setBusy(false); }
  };

  const cancelOAuth = async () => {
    if (!oauthJob) { onClose(); return; }
    setBusy(true);
    try { setOauthJob(await cancelOAuthConnection(oauthJob.id)); }
    catch (err) { console.error("Failed to cancel provider sign-in", err); toast(userActionError("cancel provider sign-in"), "error"); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <div className="p-5 space-y-5">
        <div>
          <h3 className="text-base font-semibold text-ink-1">Connect Provider</h3>
          <p className="text-xs text-ink-3 mt-1">Choose a provider to connect. Edit an existing connection if you need to replace it.</p>
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

                  {profiles.some((p) => p.providerSlug === selected.providerSlug && (p.profileKind ?? "custom_endpoint") === "builtin_provider") && (
                    <div className="rounded border border-line-soft bg-surface-2 px-3 py-2 text-[11px] text-ink-3 leading-relaxed">
                      This creates another {selected.displayName} connection. To replace an existing one, choose Edit on that connection.
                    </div>
                  )}
                  <Field label="Connection name"><input className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" value={name} onChange={(e) => setName(e.target.value)} /></Field>

                  {selected.authModes.length > 1 && (
                    <Field label="Authentication"><select className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" value={authMode} onChange={(e) => setAuthMode(e.target.value as "api_key" | "oauth")}>{selected.authModes.map((mode) => <option key={mode} value={mode}>{mode === "api_key" ? "API Key" : "OAuth login"}</option>)}</select></Field>
                  )}

                  {authMode === "api_key" ? (
                    <div className="space-y-3">
                      <Field label="API key"><input type="password" className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Paste provider API key" /></Field>
                      <Field label="API URL"><div className="space-y-1"><input className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="Official default" /><div className="text-[11px] text-ink-3">Optional. Leave empty to use the provider default URL.</div></div></Field>
                      <button type="button" onClick={connectApiKey} disabled={busy || !apiKey.trim()} className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed">{busy ? "Connecting..." : "Connect"}</button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {!oauthJob && <button type="button" onClick={startOAuth} disabled={busy} className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer disabled:cursor-not-allowed">{busy ? "Starting..." : "Start login"}</button>}
                      {oauthJob && <div className="rounded border border-line-soft bg-inset p-3 space-y-2 text-xs text-ink-3">
                        <div>Status: <span className="font-medium">{oauthStatusLabel(oauthJob.status)}</span></div>
                        {oauthJob.prompt && <div>{oauthJob.prompt}</div>}
                        {oauthJob.authUrl && <a className="text-accent-ink hover:underline break-all" href={oauthJob.authUrl} target="_blank" rel="noreferrer">Open login page</a>}
                        {oauthJob.deviceCode && <div className="space-y-1"><div>Code: <code>{oauthJob.deviceCode.userCode}</code></div><a className="text-accent-ink hover:underline break-all" href={oauthJob.deviceCode.verificationUri} target="_blank" rel="noreferrer">{oauthJob.deviceCode.verificationUri}</a></div>}
                        {oauthJob.userCode && <div>Code: <code>{oauthJob.userCode}</code></div>}
                        {oauthJob.status === "awaiting_input" && <div className="flex gap-2"><input className="flex-1 bg-surface-1 border border-line rounded px-3 py-2 text-sm" value={oauthInput} onChange={(e) => setOauthInput(e.target.value)} placeholder="Paste code or response" /><button type="button" onClick={submitOAuthInput} disabled={busy || !oauthInput.trim()} className="px-3 py-2 bg-accent text-accent-contrast rounded text-xs disabled:opacity-40">Submit</button></div>}
                        {oauthJob.error && <div className="text-blocked">Sign-in failed. Try again or choose another connection method.</div>}
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

function addedModels(profile: ModelCredentialProfileInput): ModelDefinitionConfig[] {
  return profile.modelCustomizations?.addedModels || [];
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
    isDefault: false,
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
  const addCustomModel = () => {
    const current = modelCustomizations(form);
    updateModelCustomizations({ ...current, addedModels: [...(current.addedModels || []), { id: "", metadataSource: "unknown" }] });
  };
  const updateCustomModel = (index: number, patch: Partial<ModelDefinitionConfig>) => {
    const current = modelCustomizations(form);
    const next = [...(current.addedModels || [])];
    next[index] = { ...next[index], ...patch };
    updateModelCustomizations({ ...current, addedModels: next });
  };
  const removeCustomModel = (index: number) => {
    const current = modelCustomizations(form);
    const next = (current.addedModels || []).filter((_, i) => i !== index);
    updateModelCustomizations({ ...current, addedModels: next.length ? next : undefined });
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
    } catch (err) {
      console.error("Failed to fetch models", err);
      const message = userActionError("fetch models", "Check the endpoint and connection, or add models manually.");
      setFetchError(message);
      toast(message, "error");
    } finally {
      setFetchingModels(false);
    }
  };
  const startOAuth = async () => {
    setOauthBusy(true);
    try {
      const job = await startOAuthLoginJob({ profileId: profile?.id, providerId: form.oauthProviderId, profile: form });
      setOauthJob(job);
    } catch (err) { console.error("Failed to start OAuth sign-in", err); toast(userActionError("start sign-in"), "error"); }
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
      } else if (job.error) toast("Sign-in failed. Check the response and try again.", "error");
    } catch (err) { console.error("Failed to submit OAuth input", err); toast(userActionError("submit the sign-in response", "Check the response, then try again."), "error"); }
    finally { setOauthBusy(false); }
  };
  const cancelOAuth = async () => {
    if (!oauthJob) return;
    setOauthBusy(true);
    try { setOauthJob(await cancelOAuthLoginJob(oauthJob.id)); }
    catch (err) { console.error("Failed to cancel OAuth sign-in", err); toast(userActionError("cancel sign-in"), "error"); }
    finally { setOauthBusy(false); }
  };
  const save = async () => {
    setSaving(true);
    try {
      const payload = { ...form, requestProfile: "standard" as const };
      if (profile) await updateModelCredentialProfile(profile.id, payload);
      else await createModelCredentialProfile(payload);
      onSaved();
    } catch (err) { console.error("Failed to save model connection", err); toast(userActionError("save this model connection", "Check the required fields, then try again."), "error"); }
    finally { setSaving(false); }
  };
  return (
    <Sheet open onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <div className="p-5 space-y-5">
        <div><h3 className="text-base font-semibold text-ink-1">{profile ? "Edit" : "Add"} connection</h3><p className="text-xs text-ink-3 mt-1">Configure the provider and models available through this connection. Secrets are hidden after saving.</p></div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <Field label="Name"><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="OpenRouter main" /></Field>
            <Field label="Provider slug"><input className={inputCls} value={form.providerSlug} onChange={(e) => setForm({ ...form, providerSlug: e.target.value })} placeholder="openrouter" /></Field>
            <Field label="Protocol"><select className={inputCls} value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value as ModelProtocol })}>{PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
            <Field label="Base URL"><input className={inputCls} value={form.baseUrl || ""} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></Field>
            <Field label="Auth type"><select className={inputCls} value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value as ModelAuthType })}>{AUTH_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
            {form.authType === "api_key" && <Field label="API key"><input type="password" className={inputCls} value={form.apiKey || ""} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder={profile?.hasSecret ? "Leave blank to keep existing key" : "sk-..."} /></Field>}
            {form.authType === "oauth" && <div className="rounded border border-line-soft p-3 space-y-2">
              <Field label="OAuth provider"><select className={inputCls} value={form.oauthProviderId || ""} onChange={(e) => setForm({ ...form, oauthProviderId: e.target.value })}><option value="">Select provider...</option>{["anthropic", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex"].map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
              <div className="flex items-center gap-2 text-xs"><span className={profile?.hasSecret ? "text-onair" : "text-ink-3"}>{profile?.hasSecret ? "OAuth connected" : "OAuth not connected"}</span><button type="button" disabled={oauthBusy || !form.oauthProviderId} onClick={startOAuth} className="text-accent-ink hover:opacity-80 disabled:text-ink-4 disabled:cursor-not-allowed">Start login</button>{oauthJob && oauthJob.status === "awaiting_input" && <button type="button" disabled={oauthBusy} onClick={cancelOAuth} className="text-ink-3 hover:text-ink-4">Cancel</button>}</div>
              {oauthJob && <div className="text-xs text-ink-2 space-y-1"><div>Status: {oauthStatusLabel(oauthJob.status)}</div><div>{oauthJob.prompt}</div>{oauthJob.authUrl && <div>Auth URL: <code className="break-all">{oauthJob.authUrl}</code></div>}{oauthJob.userCode && <div>Code: <code>{oauthJob.userCode}</code></div>}{oauthJob.error && <div className="text-blocked">Sign-in failed. Try again or choose another connection method.</div>}{oauthJob.status === "awaiting_input" && <div className="flex gap-2"><input className={inputCls} value={oauthCode} onChange={(e) => setOauthCode(e.target.value)} placeholder="Paste OAuth input if requested" /><button type="button" disabled={oauthBusy} onClick={submitOAuth} className="px-3 py-2 text-xs bg-accent text-accent-contrast rounded disabled:opacity-40">Submit</button></div>}</div>}
              <p className="text-xs text-ink-3">Tokens are stored locally and are never shown in the API or UI.</p>
            </div>}
            <div className="text-xs rounded border border-think/30 bg-think-dim text-think p-3">Keys are stored unencrypted on this device and hidden after saving. Use a scoped key.</div>
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
                <div className="pt-3 mt-1 border-t border-line-soft">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-ink-1">Custom models</h4>
                    <button type="button" onClick={addCustomModel} className="text-xs text-accent-ink hover:opacity-80 cursor-pointer">Add custom model</button>
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">Models not yet in the official catalog. Metadata you leave blank uses reasonable defaults.</p>
                  {addedModels(form).map((m, i) => (
                    <div key={i} className="border border-line-soft rounded-lg p-3 space-y-2 mt-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-2 text-ink-3">Custom</span>
                        <button type="button" className="text-xs text-blocked cursor-pointer" onClick={() => removeCustomModel(i)}>Remove</button>
                      </div>
                      <input className={inputCls} value={m.id} onChange={(e) => updateCustomModel(i, { id: e.target.value })} placeholder="model id" />
                      <input className={inputCls} value={m.name || ""} onChange={(e) => updateCustomModel(i, { name: e.target.value })} placeholder="display name (optional)" />
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <Field label="Context window (tokens)"><input type="number" min={1} step={1} className={inputCls} value={m.contextWindow ?? ""} onChange={(e) => updateCustomModel(i, { contextWindow: parseIntegerInput(e.target.value), metadataSource: "endpoint" })} placeholder="e.g. 128000" /></Field>
                        <Field label="Max output tokens"><input type="number" min={1} step={1} className={inputCls} value={m.maxTokens ?? ""} onChange={(e) => updateCustomModel(i, { maxTokens: parseIntegerInput(e.target.value), metadataSource: "endpoint" })} placeholder="optional" /></Field>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-ink-2">
                        <input type="checkbox" checked={!!m.input?.includes("image")} onChange={(e) => updateCustomModel(i, { input: e.target.checked ? ["text", "image"] : undefined })} />
                        Supports image input
                      </label>
                    </div>
                  ))}
                </div>
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
                  <label className="flex items-center gap-2 text-xs text-ink-2">
                    <input type="checkbox" checked={!!m.input?.includes("image")} onChange={(e) => { const models = [...form.models]; models[i] = { ...m, input: e.target.checked ? ["text", "image"] : undefined }; setForm({ ...form, models }); }} />
                    Supports image input
                  </label>
                  {m.contextWindow ? <div className="text-[11px] text-ink-3">{`${Math.round(m.contextWindow / 1000)}k context${m.maxTokens ? ` · ${Math.round(m.maxTokens / 1000)}k max output` : ""}`}</div> : null}
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
