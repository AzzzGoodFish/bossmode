// Pi SDK Runtime — in-process pi Agent SDK integration behind the legacy pi-cli storage key
import { existsSync, mkdirSync } from "node:fs";
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

function getSessionContextModel(sessionManager: SessionManager): { provider: string; modelId: string } | null {
  try {
    const model = (sessionManager as any).buildSessionContext?.().model;
    if (!model || typeof model.provider !== "string" || typeof model.modelId !== "string") return null;
    return { provider: model.provider, modelId: model.modelId };
  } catch {
    return null;
  }
}

function getSessionLeafAssistantError(sessionManager: SessionManager): string | null {
  try {
    const leaf = (sessionManager as any).getLeafEntry?.() ?? (sessionManager as any).getBranch?.().slice(-1)[0];
    const message = leaf?.type === "message" ? leaf.message : undefined;
    if (message?.role === "assistant" && message.stopReason === "error") {
      return typeof message.errorMessage === "string" && message.errorMessage.trim() ? message.errorMessage : "provider error";
    }
  } catch {
    return null;
  }
  return null;
}

function freshSessionReason(sessionManager: SessionManager): { reason: string; previous?: string } | null {
  const leafError = getSessionLeafAssistantError(sessionManager);
  if (leafError) return { reason: "previous assistant turn ended with provider error", previous: leafError };
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
    try { this.session.setThinkingLevel(level as any); }
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
    const model = modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model not found: ${resolvedModel}`);

    let sessionManager: SessionManager;
    let appendConfiguredModelChange = false;
    try {
      if (opts.resumeSession?.sessionFile) {
        const resumed = SessionManager.open(opts.resumeSession.sessionFile, sessionDir, opts.cwd);
        const freshReason = freshSessionReason(resumed);
        if (freshReason) {
          logger.warn("runtime:pi-sdk", "resume session skipped, starting fresh", {
            agent: opts.member.name,
            reason: freshReason.reason,
            previous: freshReason.previous,
            configured: resolvedModel,
          });
          sessionManager = SessionManager.create(opts.cwd, sessionDir);
        } else {
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
        }
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
    const extensionPaths = piConfig?.extensionPaths ?? [];
    const resourceLoader = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      additionalSkillPaths: skillPaths,
      additionalExtensionPaths: extensionPaths,
      systemPrompt: rolePrompt || undefined,
      appendSystemPrompt,
    });
    await resourceLoader.reload();

    const customTools = createBossmodeSdkTools({ roomId: opts.roomId, agentName: opts.member.name, roomMembers: opts.roomMembers });
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
      tools: ["read", "bash", "edit", "write", ...customTools.map((t) => t.name)],
    });

    if (appendConfiguredModelChange) {
      await session.setModel(model);
    }

    opts.onSessionChanged?.({ sessionId: session.sessionId, sessionFile: session.sessionFile });

    const runtimeParams: AgentRuntimeParams = {
      model: resolvedModel,
      thinkingLevel: session.thinkingLevel || opts.member.thinkingLevel || "off",
      systemPrompt: [rolePrompt, ...appendSystemPrompt].filter(Boolean).join("\n\n"),
      skills: opts.skillNames ?? skillPaths,
      extensions: ["bossmode-sdk-tools", ...extensionPaths],
    };
    const handle = new PiSdkAgentHandle(session, modelRegistry, runtimeParams);
    this.handles.add(handle);
    logger.info("runtime:pi-sdk", "createAgent", { agent: opts.member.name, model: resolvedModel, thinking: runtimeParams.thinkingLevel, skills: skillPaths.length });
    return handle;
  }

  async shutdownAll(): Promise<void> {
    for (const handle of this.handles) handle.destroy();
    this.handles.clear();
  }
}
