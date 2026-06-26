// Pi SDK Runtime — in-process pi Agent SDK integration behind the legacy pi-cli storage key
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { logger } from "../../foundation/logger.js";
import { readConfig } from "../../shared/config.js";
import { ensureBossmodeMcpDirs, getBossmodeMcpConfigPath, getBossmodeMcpRuntimeDir } from "../../shared/mcp-settings.js";
import type { PiTransportSetting } from "../../shared/types.js";
import { getBossmodePiRuntimeRoot, exportPiConfigForMember, normalizeModelRef, createSyncedAuthStorage } from "../model-credentials.js";
import { createBossmodeSdkTools } from "./bossmode-sdk-tools.js";
import { mapContextUsage, mapPiAgentEvent } from "./pi-events.js";
import type { AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts, RuntimeCapabilities, RuntimeDetectResult, ContextUsage, AgentRuntimeParams } from "./types.js";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function splitModelRef(modelRef: string): { provider: string; modelId: string } {
  const normalized = normalizeModelRef(modelRef);
  const idx = normalized.indexOf("/");
  return idx > 0 ? { provider: normalized.slice(0, idx), modelId: normalized.slice(idx + 1) } : { provider: "anthropic", modelId: normalized };
}

function resolveModelLabel(modelRef: string): string {
  const { provider, modelId } = splitModelRef(modelRef);
  return `${provider}/${modelId}`;
}

const VALID_TRANSPORTS = new Set<PiTransportSetting>(["auto", "websocket", "websocket-cached", "sse"]);

interface RuntimeTransportSettings {
  transport: PiTransportSetting;
  websocketConnectTimeoutMs: number;
  httpIdleTimeoutMs?: number;
}

function normalizeTimeout(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    logger.warn("runtime:pi-sdk", "invalid runtime timeout ignored", { field, value });
    return undefined;
  }
  return Math.floor(value);
}

function resolveRuntimeTransportSettings(): RuntimeTransportSettings {
  const defaults: RuntimeTransportSettings = { transport: "auto", websocketConnectTimeoutMs: 60000 };
  try {
    const runtime = readConfig().runtime;
    const configuredTransport = runtime?.codexTransport;
    const transport = configuredTransport && VALID_TRANSPORTS.has(configuredTransport)
      ? configuredTransport
      : defaults.transport;
    if (configuredTransport && !VALID_TRANSPORTS.has(configuredTransport)) {
      logger.warn("runtime:pi-sdk", "invalid runtime transport ignored", { transport: configuredTransport });
    }
    return {
      transport,
      websocketConnectTimeoutMs: normalizeTimeout(runtime?.websocketConnectTimeoutMs, "websocketConnectTimeoutMs") ?? defaults.websocketConnectTimeoutMs,
      httpIdleTimeoutMs: normalizeTimeout(runtime?.httpIdleTimeoutMs, "httpIdleTimeoutMs"),
    };
  } catch {
    return defaults;
  }
}

function applyRuntimeTransportSettings(settingsManager: SettingsManager): RuntimeTransportSettings {
  const settings = resolveRuntimeTransportSettings();
  const overrides: Record<string, unknown> = {
    transport: settings.transport,
    websocketConnectTimeoutMs: settings.websocketConnectTimeoutMs,
  };
  if (settings.httpIdleTimeoutMs !== undefined) overrides.httpIdleTimeoutMs = settings.httpIdleTimeoutMs;
  settingsManager.applyOverrides(overrides as any);
  return {
    transport: settingsManager.getTransport() as PiTransportSetting,
    websocketConnectTimeoutMs: settingsManager.getWebSocketConnectTimeoutMs() ?? settings.websocketConnectTimeoutMs,
    httpIdleTimeoutMs: settingsManager.getHttpIdleTimeoutMs(),
  };
}

interface McpRuntimeSettings {
  enabled: boolean;
  adapterPath?: string;
  configPath: string;
  runtimeDir: string;
}

function resolveVendorMcpAdapterPath(): string {
  return fileURLToPath(new URL("../../../vendor/pi-mcp-adapter/index.ts", import.meta.url));
}

function resolveMcpRuntimeSettings(): McpRuntimeSettings {
  const configPath = getBossmodeMcpConfigPath();
  const runtimeDir = getBossmodeMcpRuntimeDir();
  let enabled = false;
  try {
    enabled = readConfig().mcp?.enabled === true;
  } catch {
    enabled = false;
  }
  if (!enabled) return { enabled: false, configPath, runtimeDir };

  const adapterPath = resolveVendorMcpAdapterPath();
  if (!existsSync(adapterPath)) {
    throw new Error(`MCP adapter not found at ${adapterPath}. Run git submodule update --init --recursive.`);
  }
  ensureBossmodeMcpDirs();
  process.env.MCP_DIRECT_TOOLS = "__none__";
  process.env.PI_CODING_AGENT_DIR = runtimeDir;
  process.env.MCP_OAUTH_DIR = join(runtimeDir, "oauth");
  return { enabled: true, adapterPath, configPath, runtimeDir };
}

async function bindMcpExtension(session: AgentSession, opts: { configPath: string; agent: string }): Promise<void> {
  try {
    session.extensionRunner.setFlagValue("mcp-config", opts.configPath);
    await session.bindExtensions({
      mode: "print",
      onError: (err) => logger.warn("runtime:pi-sdk", "mcp extension error", {
        agent: opts.agent,
        event: err.event,
        extensionPath: err.extensionPath,
        error: err.error,
      }),
    });
  } catch (err: any) {
    logger.warn("runtime:pi-sdk", "mcp extension bind failed", { agent: opts.agent, error: err.message || String(err) });
    throw err;
  }
}

function getSessionContextModel(sessionManager: SessionManager): { provider: string; modelId: string } | null {
  try {
    const model = (sessionManager as any).buildSessionContext?.().model;
    if (!model || typeof model.provider !== "string" || typeof model.modelId !== "string") return null;
    return { provider: model.provider, modelId: model.modelId };
  } catch {
    return null;
  }
}

function recoverableErrorLeaf(sessionManager: SessionManager): { id: string; parentId: string | null; errorMessage: string } | null {
  try {
    const leaf = (sessionManager as any).getLeafEntry?.() ?? (sessionManager as any).getBranch?.().slice(-1)[0];
    if (!leaf || leaf.type !== "message") return null;
    const message = leaf.message;
    if (message?.role === "assistant" && message.stopReason === "error") {
      const errorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : "provider error";
      return { id: leaf.id, parentId: leaf.parentId ?? null, errorMessage };
    }
  } catch {
    return null;
  }
  return null;
}

function sessionModelDiffers(sessionManager: SessionManager, provider: string, modelId: string): { provider: string; modelId: string } | null {
  const sessionModel = getSessionContextModel(sessionManager);
  if (!sessionModel) return null;
  return sessionModel.provider !== provider || sessionModel.modelId !== modelId ? sessionModel : null;
}

class PiSdkAgentHandle implements AgentHandle {
  readonly runtimeName = "pi-cli";
  readonly runtimeParams: AgentRuntimeParams;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private unsubscribeSession: (() => void) | undefined;
  private currentRun: Promise<void> | null = null;
  private destroyed = false;

  constructor(
    private session: AgentSession,
    private modelRegistry: ModelRegistry,
    runtimeParams: AgentRuntimeParams,
  ) {
    this.runtimeParams = runtimeParams;
    this.unsubscribeSession = session.subscribe((raw) => {
      const mapped = mapPiAgentEvent(raw);
      if (mapped) this.emit(mapped);
    });
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async prompt(message: string): Promise<void> {
    if (message === "/compact") return this.compact();
    const run = this.session.prompt(message, { source: "external" as any }).catch((err) => {
      this.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: err.message || String(err) });
      throw err;
    }).finally(() => {
      if (this.currentRun === run) this.currentRun = null;
    });
    this.currentRun = run;
    await run;
  }

  steer(message: string): void {
    if (message === "/compact") {
      this.compact().catch((err) => logger.error("runtime:pi-sdk", "compact failed in steer", { error: err.message }));
      return;
    }
    this.session.steer(message).catch((err) => {
      this.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: err.message || String(err) });
    });
  }

  abort(): void {
    this.session.abort().catch(() => {});
    try { this.session.abortCompaction(); } catch {}
    try { this.session.abortBranchSummary(); } catch {}
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try { this.abort(); } catch {}
    try {
      if (this.session.extensionRunner.hasHandlers("session_shutdown")) {
        this.session.extensionRunner.emit({ type: "session_shutdown" } as any).catch((err: any) => {
          logger.warn("runtime:pi-sdk", "extension session_shutdown failed", { error: err.message || String(err) });
        });
      }
    } catch {}
    try { this.unsubscribeSession?.(); } catch {}
    try { this.session.dispose(); } catch {}
    this.listeners.clear();
  }

  async waitForIdle(): Promise<void> {
    if (this.currentRun) await this.currentRun.catch(() => {});
  }

  refreshModelRegistry(): void {
    this.modelRegistry.refresh();
    // Reload auth.json so edited credentials (e.g. a rotated API key on the same
    // profile) take effect on the fast model-switch path. ModelRegistry.refresh()
    // only reloads models.json; the API key is resolved at request time from the
    // in-memory AuthStorage, which otherwise keeps the stale key until recreate.
    try { this.modelRegistry.authStorage?.reload?.(); }
    catch (err) { logger.warn("runtime:pi-sdk", "authStorage reload failed", { error: String(err) }); }
  }

  async setModel(modelRef: string): Promise<void> {
    const { provider, modelId } = splitModelRef(modelRef);
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      logger.warn("runtime:pi-sdk", "setModel target not found", { modelRef });
      throw new Error(`Model not found: ${modelRef}`);
    }
    await this.session.setModel(model);
    this.runtimeParams.model = resolveModelLabel(modelRef);
  }

  setThinkingLevel(level: string): void {
    try {
      this.session.setThinkingLevel(level as any);
      this.runtimeParams.thinkingLevel = (this.session as any).thinkingLevel || level;
    }
    catch (err) { logger.warn("runtime:pi-sdk", "setThinkingLevel failed", { level, error: String(err) }); }
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    try {
      const raw = typeof (this.session as any).getContextUsage === "function"
        ? await (this.session as any).getContextUsage()
        : (typeof (this.session as any).getSessionStats === "function" ? (await (this.session as any).getSessionStats())?.contextUsage : undefined);
      return mapContextUsage(raw, this.runtimeParams.model);
    } catch (err) {
      logger.warn("runtime:pi-sdk", "getContextUsage failed", { error: String(err) });
      return null;
    }
  }

  private async compact(): Promise<void> {
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_start" });
    this.emit({ type: "message_update", text: "Compacting context..." });
    try {
      const result = await this.session.compact();
      const summary = String((result as any)?.summary || "No summary").slice(0, 300);
      const tokensBefore = (result as any)?.tokensBefore ?? "unknown";
      this.emit({ type: "message_end", text: `Context compacted.\nTokens before: ${tokensBefore}\nSummary: ${summary}` });
    } catch (err: any) {
      this.emit({ type: "message_end", text: `Compaction failed: ${err.message || String(err)}` });
    } finally {
      this.emit({ type: "agent_end" });
    }
  }
}

export class PiSdkRuntime implements AgentRuntime {
  readonly name = "pi-cli"; // storage compatibility alias
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    toolEvents: true,
    thinking: true,
    usage: true,
    dynamicModel: true,
    dynamicThinking: true,
    permissionControl: false,
    sessionResume: true,
    contextUsage: true,
  };

  private handles = new Set<PiSdkAgentHandle>();

  async detect(): Promise<RuntimeDetectResult> {
    return { available: true, version: PI_SDK_VERSION, path: "@earendil-works/pi-coding-agent" };
  }

  async createAgent(opts: CreateAgentOpts): Promise<AgentHandle> {
    const resolvedModel = resolveModelLabel(opts.member.model || "claude-sonnet-4-6");
    const { provider, modelId } = splitModelRef(resolvedModel);
    const piConfig = exportPiConfigForMember({
      roomId: opts.roomId,
      memberName: opts.member.name,
      modelRef: resolvedModel,
      credentialId: opts.member.credentialId,
    });
    if (!piConfig) {
      throw new Error(`No model credentials configured for ${resolvedModel}. Go to Settings → Model Credentials to add or import credentials.`);
    }

    const safeRoom = safeSegment(opts.roomId);
    const safeMember = safeSegment(opts.member.name);
    const runtimeAgentDir = piConfig?.agentDir || join(getBossmodePiRuntimeRoot(), safeRoom, safeMember);
    const sessionDir = join(getBossmodePiRuntimeRoot(), safeRoom, safeMember, "sessions");
    mkdirSync(runtimeAgentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    const authStorage = piConfig.profile ? createSyncedAuthStorage(join(runtimeAgentDir, "auth.json"), piConfig.profile) : AuthStorage.create(join(runtimeAgentDir, "auth.json"));
    const modelRegistry = ModelRegistry.create(authStorage, join(runtimeAgentDir, "models.json"));
    const settingsManager = SettingsManager.create(opts.cwd, runtimeAgentDir);
    const transportSettings = applyRuntimeTransportSettings(settingsManager);
    const model = modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model not found: ${resolvedModel}`);

    let sessionManager: SessionManager;
    let appendConfiguredModelChange = false;
    try {
      if (opts.resumeSession?.sessionFile) {
        const resumed = SessionManager.open(opts.resumeSession.sessionFile, sessionDir, opts.cwd);
        const errorLeaf = recoverableErrorLeaf(resumed);
        if (errorLeaf) {
          // The last assistant turn ended with a provider error (rate limit,
          // network blip, stale credential, etc.). Don't discard the whole
          // conversation — just roll the leaf back past the failed turn so the
          // prior context is preserved on restart.
          try {
            if (errorLeaf.parentId) (resumed as any).branch(errorLeaf.parentId);
            else (resumed as any).resetLeaf?.();
            logger.info("runtime:pi-sdk", "resume session recovered past failed turn", {
              agent: opts.member.name,
              previous: errorLeaf.errorMessage,
              configured: resolvedModel,
            });
          } catch (branchErr) {
            logger.warn("runtime:pi-sdk", "failed to roll back error turn, resuming as-is", { agent: opts.member.name, error: String(branchErr) });
          }
        }
        const previous = sessionModelDiffers(resumed, provider, modelId);
        if (previous) {
          appendConfiguredModelChange = true;
          logger.info("runtime:pi-sdk", "resuming session with configured model switch", {
            agent: opts.member.name,
            previous: `${previous.provider}/${previous.modelId}`,
            configured: resolvedModel,
          });
        }
        sessionManager = resumed;
      } else {
        sessionManager = SessionManager.create(opts.cwd, sessionDir);
      }
    } catch (err) {
      logger.warn("runtime:pi-sdk", "session resume failed, starting fresh", { agent: opts.member.name, error: String(err) });
      sessionManager = SessionManager.create(opts.cwd, sessionDir);
    }

    const rolePrompt = opts.agentPrompt.trim();
    const appendSystemPrompt = [opts.envPrompt, opts.rulesPrompt].filter((v): v is string => !!v && v.trim().length > 0);
    const skillPaths = opts.skillPaths.filter((p) => existsSync(p));
    const mcpSettings = resolveMcpRuntimeSettings();
    const extensionPaths = piConfig?.extensionPaths ?? [];
    const activeExtensionPaths = mcpSettings.enabled && mcpSettings.adapterPath
      ? [...extensionPaths, mcpSettings.adapterPath]
      : extensionPaths;
    const resourceLoader = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      additionalSkillPaths: skillPaths,
      additionalExtensionPaths: activeExtensionPaths,
      systemPrompt: rolePrompt || undefined,
      appendSystemPrompt,
    });
    await resourceLoader.reload();

    const customTools = createBossmodeSdkTools({ roomId: opts.roomId, agentName: opts.member.name, roomMembers: opts.roomMembers });
    const activeTools = ["read", "bash", "edit", "write", ...customTools.map((t) => t.name), ...(mcpSettings.enabled ? ["mcp"] : [])];
    const { session } = await createAgentSession({
      cwd: opts.cwd,
      agentDir: runtimeAgentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel: (opts.member.thinkingLevel || "off") as any,
      resourceLoader,
      sessionManager,
      settingsManager,
      customTools,
      tools: activeTools,
    });

    if (mcpSettings.enabled) {
      await bindMcpExtension(session, { configPath: mcpSettings.configPath, agent: opts.member.name });
    }

    if (appendConfiguredModelChange) {
      await session.setModel(model);
    }

    opts.onSessionChanged?.({ sessionId: session.sessionId, sessionFile: session.sessionFile });

    const runtimeParams: AgentRuntimeParams = {
      model: resolvedModel,
      thinkingLevel: session.thinkingLevel || opts.member.thinkingLevel || "off",
      systemPrompt: [rolePrompt, ...appendSystemPrompt].filter(Boolean).join("\n\n"),
      skills: opts.skillNames ?? skillPaths,
      extensions: ["bossmode-sdk-tools", ...activeExtensionPaths],
      credentialId: piConfig.profile?.id,
      credentialName: piConfig.profile?.name,
    };
    const handle = new PiSdkAgentHandle(session, modelRegistry, runtimeParams);
    this.handles.add(handle);
    logger.info("runtime:pi-sdk", "createAgent", {
      agent: opts.member.name,
      model: resolvedModel,
      thinking: runtimeParams.thinkingLevel,
      skills: skillPaths.length,
      transport: transportSettings.transport,
      websocketConnectTimeoutMs: transportSettings.websocketConnectTimeoutMs,
      httpIdleTimeoutMs: transportSettings.httpIdleTimeoutMs,
      piSdkVersion: PI_SDK_VERSION,
      mcpEnabled: mcpSettings.enabled,
    });
    return handle;
  }

  async shutdownAll(): Promise<void> {
    for (const handle of this.handles) handle.destroy();
    this.handles.clear();
  }
}
