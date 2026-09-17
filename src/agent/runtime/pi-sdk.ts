// Pi SDK Runtime — in-process pi Agent SDK integration behind the legacy pi-cli storage key
import { existsSync, mkdirSync } from "node:fs";
import { builtinMcpAdapterPath, discoverMemberExtensionEntries } from "../../member/extensions.js";
export { discoverMemberExtensionEntries } from "../../member/extensions.js";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { SdkExecutionService, type SdkExecutionAttempt } from "./sdk-execution-service.js";
import { logger } from "../../kernel/logger.js";
import { ensureBossmodeMcpDirs, getBossmodeMcpRuntimeDir, writeMemberScopedMcpConfig } from "../../member/mcp.js";
import { memberExtensionsDir, memberSkillsDir } from "../../files/layout.js";
import type { AgentMemberConfig, PiTransportSetting } from "../../kernel/types.js";
import { getModelCredentialProfile } from "../../config/models.js";
import { createDatabaseModelRuntime, refreshDatabaseModelRuntime, exportPiConfigForMember, resolvePiAgentDir } from "../../config/pi-adapt/credentials.js";
import { normalizeModelRef } from "../../config/models.js";
import { loadDatabaseMcpFactory } from "./mcp-factory.js";
import { ModelCredentialBinding } from "./model-credential-binding.js";
import { createBossmodeSdkTools } from "./bossmode-sdk-tools.js";
import { mapContextUsage, mapPiAgentEvent } from "./pi-events.js";
import type { AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts, RuntimeCapabilities, RuntimeDetectResult, ContextUsage, AgentRuntimeParams, ReloadAgentResourcesOpts, MemberActiveToolInfo, RuntimePromptOptions } from "./types.js";

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);


/**
 * Resolve systemPrompt vs appendSystemPrompt for pi DefaultResourceLoader.
 * The bossmode-compiled prompt is the only source (fish 2026-09-04: the
 * piBuiltinPrompt flag is retired) — pi's built-in system prompt never loads.
 * Exported for unit tests.
 */
export function resolvePiSystemPromptSources(args: {
  agentPrompt: string;
  appendSystemPrompt: string[];
}): { systemPrompt: string | undefined; appendSystemPrompt: string[] } {
  const rolePrompt = args.agentPrompt.trim();
  const appends = args.appendSystemPrompt.filter((v) => !!v && v.trim().length > 0);
  return {
    systemPrompt: rolePrompt || undefined,
    appendSystemPrompt: appends,
  };
}


/** Prompt sources are owned by Bossmode; resource discovery stays in the SDK. */
export class BossmodeResourceLoader implements ResourceLoader {
  private delegate: DefaultResourceLoader;
  private pathsChanged = false;
  private promptSources: ReturnType<typeof resolvePiSystemPromptSources>;

  constructor(
    private options: ConstructorParameters<typeof DefaultResourceLoader>[0],
    sources: ReturnType<typeof resolvePiSystemPromptSources>,
  ) {
    this.delegate = new DefaultResourceLoader(options);
    this.promptSources = { ...sources, appendSystemPrompt: [...sources.appendSystemPrompt] };
  }

  /** The SDK has no public path setters. Replace the delegate at reload, not its private fields. */
  setResourcePaths(skillPaths: string[], extensionPaths: string[]): void {
    this.options = { ...this.options, additionalSkillPaths: [...skillPaths], additionalExtensionPaths: [...extensionPaths] };
    this.pathsChanged = true;
  }

  async reload(options?: Parameters<ResourceLoader["reload"]>[0]): Promise<void> {
    if (this.pathsChanged) this.delegate = new DefaultResourceLoader(this.options);
    await this.delegate.reload(options);
    this.pathsChanged = false;
  }

  getExtensions() { return this.delegate.getExtensions(); }
  getSkills() { return this.delegate.getSkills(); }
  getPrompts() { return this.delegate.getPrompts(); }
  getThemes() { return this.delegate.getThemes(); }
  getAgentsFiles() { return this.delegate.getAgentsFiles(); }
  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void { this.delegate.extendResources(paths); }

  setPromptSources(sources: ReturnType<typeof resolvePiSystemPromptSources>): void {
    this.promptSources = { ...sources, appendSystemPrompt: [...sources.appendSystemPrompt] };
  }

  getSystemPrompt(): string | undefined {
    return this.promptSources.systemPrompt;
  }

  /** Bossmode prompt sources are in-memory (compiled per scope); there is no file backing. */
  getSystemPromptSource(): { path: string } | undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
    return [...this.promptSources.appendSystemPrompt];
  }

  getAppendSystemPromptSources(): Array<{ path: string }> {
    return [];
  }
}

/** Classify active-tool source. Bossmode tools come from the live customTools set (single source of truth) — no static name whitelist. */
function classifyToolSource(
  name: string,
  bossmodeToolNames: ReadonlySet<string>,
  sourceInfo?: { path?: string; source?: string; baseDir?: string },
): string {
  if (BUILTIN_TOOL_NAMES.has(name)) return "builtin";
  if (bossmodeToolNames.has(name)) return "bossmode";
  if (name === "mcp") return "mcp";
  const haystack = [sourceInfo?.path, sourceInfo?.baseDir, sourceInfo?.source].filter(Boolean).join(" ");
  if (haystack) {
    // Platform extension store is retired (fish 2026-09-04) — classify by
    // sourceInfo shape only: member-owned extension files classify as
    // extension:<leaf>, the MCP adapter stays "mcp".
    if (/extensions|node_modules|\.ts$|\.js$/i.test(haystack) && !/pi-mcp-adapter/.test(haystack)) {
      const leaf = haystack.split(/[/\\]/).filter(Boolean).find((p) => p.startsWith("pi-") || p.includes("web-access"));
      if (leaf) return `extension:${leaf.replace(/@.*$/, "")}`;
    }
    if (/pi-mcp-adapter|mcp/i.test(haystack)) return "mcp";
  }
  return "extension:unknown";
}

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

interface RuntimeTransportSettings {
  transport: PiTransportSetting;
  websocketConnectTimeoutMs: number;
  httpIdleTimeoutMs?: number;
}

function resolveRuntimeTransportSettings(): RuntimeTransportSettings {
  // Transport behavior is fixed (runtime settings retired 2026-09-16): auto transport,
  // 15s websocket connect timeout.
  return { transport: "auto", websocketConnectTimeoutMs: 15000 };
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
  serverNames: string[];
  dispose(): void;
}


/** Batch 6 §1: member-dir assets that join the loader paths (create + reload
 * both call this — skills dir §1.1, extensions dir §1.3 expanded to file
 * entries, present = included). */
export function memberDirLoaderAssetPaths(memberId: string): { skills: string[]; extensions: string[] } {
  const skillsDir = memberSkillsDir(memberId);
  return {
    skills: existsSync(skillsDir) ? [skillsDir] : [],
    extensions: discoverMemberExtensionEntries(memberExtensionsDir(memberId)),
  };
}

function resolveMcpRuntimeSettings(args: { roomId: string; member: AgentMemberConfig }): McpRuntimeSettings {
  // Member configuration is SQL-owned; the temporary file is derived adapter input.
  // The adapter is platform infrastructure, including for an empty configuration.
  const runtimeDir = getBossmodeMcpRuntimeDir();
  const adapterPath = builtinMcpAdapterPath();
  if (!existsSync(adapterPath)) {
    throw new Error(`MCP adapter not found at ${adapterPath}. Run git submodule update --init --recursive.`);
  }
  ensureBossmodeMcpDirs();
  const mcpRoomId = args.roomId;
  const scoped = writeMemberScopedMcpConfig({ roomId: mcpRoomId, memberId: args.member.id });
  if (scoped.serverNames.length > 0) {
    process.env.MCP_DIRECT_TOOLS = "__none__";
    process.env.BOSSMODE_MCP_CONFIG_STRICT = "1";
    process.env.PI_CODING_AGENT_DIR = runtimeDir;
  }
  return { enabled: true, adapterPath, configPath: scoped.configPath, runtimeDir, serverNames: scoped.serverNames, dispose: scoped.dispose };
}

function assertHostedMcpLoaded(loader: ResourceLoader): void {
  const extension = loader.getExtensions().extensions.find(entry => entry.path === "<inline:pi-mcp-adapter>");
  if (!extension?.tools.has("mcp")) throw new Error("Hosted MCP extension failed to load");
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

interface CompactionWatchdogRun {
  maxTokens: number;
  threshold: number;
  /** Mid-run action line: threshold − WATCHDOG_SAFETY_MARGIN. */
  actionThreshold: number;
  contextWindow: number;
  model: string;
  compactionEventSeen: boolean;
  /** Watchdog aborted this run for compaction (mid-run crossing with pending tool calls). */
  interventionRequested: boolean;
  /** Assistant stop with empty text and ≤1 output token (max_tokens clamp fault or transient). */
  emptyStopSeen: boolean;
}

interface WatchdogTurnState {
  interventions: number;
  emptyRetries: number;
}

/**
 * Buffer below the SDK compaction threshold for mid-run action. The SDK only
 * checks compaction at run boundaries; a single tool result can add tens of
 * thousands of tokens mid-run, so the watchdog acts earlier (2026-07-29 k3
 * empty-response loop: max_tokens clamped to 1 → empty reply → poisoned usage
 * blinded the boundary check).
 */
const WATCHDOG_SAFETY_MARGIN = 32768;

/**
 * Action line = threshold − SAFETY_MARGIN, floored at 50% of the window: the
 * bare formula degenerates for small windows (reserveTokens + margin ≈ the
 * whole window), which would compact nearly every turn. The floor only affects
 * windows ≲114k; k3-class windows are unchanged (450848 for a 500k window).
 */
function watchdogActionThreshold(contextWindow: number, reserveTokens: number): number {
  return Math.max(contextWindow - reserveTokens - WATCHDOG_SAFETY_MARGIN, Math.floor(contextWindow / 2));
}

/** Continue instruction after a watchdog compaction (full prompt path, so the
 * SDK's post-run handling — boundary compaction check, queue drain — stays intact). */
const WATCHDOG_CONTINUE_PROMPT =
  "⚠ Context was automatically compacted to stay within the model's context window. Continue your work from where you stopped.";

/** One verbatim retry nudge for an empty response at LOW usage (transient
 * provider behavior — compaction is never triggered by response shape). */
const WATCHDOG_EMPTY_RETRY_PROMPT =
  "⚠ Your previous response came back empty (no content). Repeat your previous response.";

function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text || "")
    .join("");
}

function assistantHasToolCalls(message: any): boolean {
  return Array.isArray(message?.content) && message.content.some((c: any) => c?.type === "toolCall");
}

/** Complete every supported shutdown stage, even after an earlier failure. */
async function shutdownSdkSession(session: AgentSession, beforeDispose?: () => void, settleResources?: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  // The SDK's AgentSession.abort() awaits waitForIdle itself — awaiting ITS
  // promise here is the awaitable run-end, unlike the void handle.abort().
  try {
    await session.abort();
  } catch (err: any) {
    errors.push(`abort: ${err?.message || String(err)}`);
  }
  try {
    session.abortCompaction();
    session.abortBranchSummary();
  } catch {}
  try { await settleResources?.(); } catch (error) { errors.push(`resource settlement: ${String(error)}`); }
  const runner: any = session.extensionRunner;
  if (typeof runner?.hasHandlers === "function" && runner.hasHandlers("session_shutdown")) {
    // Handler failures surface via onError ({extensionPath, event, error}),
    // never as emit() rejections — collect them for THIS shutdown only.
    const shutdownErrors: string[] = [];
    const off = typeof runner.onError === "function"
      ? runner.onError((e: any) => {
          if (e?.event === "session_shutdown") shutdownErrors.push(`${e?.extensionPath ?? "extension"}: ${e?.error ?? "unknown error"}`);
        })
      : null;
    try {
      await runner.emit({ type: "session_shutdown" } as any);
    } catch (err: any) {
      errors.push(`session_shutdown emit: ${err?.message || String(err)}`);
    } finally {
      try { off?.(); } catch {}
    }
    errors.push(...shutdownErrors);
  }
  try { beforeDispose?.(); } catch {}
  // Always runs, even when earlier stages failed. dispose() is synchronous
  // and throws AggregateError when a registered resource cleanup fails.
  try {
    session.dispose();
  } catch (err: any) {
    const detail = err instanceof AggregateError && Array.isArray(err.errors)
      ? err.errors.map((e: any) => e?.message || String(e)).join(", ")
      : err?.message || String(err);
    errors.push(`dispose: ${detail}`);
  }
  return errors;
}

export class PiSdkAgentHandle implements AgentHandle {
  readonly runtimeName = "pi-cli";
  readonly runtimeParams: AgentRuntimeParams;
  /** SDK session id when the runtime exposes one (live sessions report
   *  identity through onSessionChanged instead). */
  readonly sessionId: string | undefined;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private mcpConfigs = new Set<McpRuntimeSettings>();
  private unsubscribeSession: (() => void) | undefined;
  private currentRun: Promise<void> | null = null;
  private promptAttempt: SdkExecutionAttempt | null = null;
  /** Outlives SDK preflight, where Agent.abort() has no active controller yet. */
  private promptAbortIntent: { aborted: boolean } | null = null;
  private compactAttempts = new Set<SdkExecutionAttempt>();
  private compactionWatchdogRun: CompactionWatchdogRun | null = null;
  private watchdogTurn: WatchdogTurnState | null = null;
  private manualCompactionOutcome: { aborted: boolean } | null = null;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  /** Called once only after every SDK teardown surface succeeded. */
  private onTeardownSuccess: (() => void) | undefined;
  private sessionReferencePublished = false;
  /** Live set of bossmode custom tool names (from createBossmodeSdkTools) — sole source for "bossmode" classification. */
  private bossmodeToolNames: Set<string>;
  private toolAssembly: { roomId: string; agentName: string; roomMembers: string[]; memberId?: string };

  constructor(
    private session: AgentSession,
    private modelRegistry: ModelRegistry,
    private credentials: ModelCredentialBinding,
    private resourceLoader: BossmodeResourceLoader,
    private settingsManager: SettingsManager,
    private baseExtensionPaths: string[],
    private baseToolNames: string[],
    runtimeParams: AgentRuntimeParams,
    bossmodeToolNames: Iterable<string>,
    toolAssembly: { roomId: string; agentName: string; roomMembers: string[]; memberId?: string },
    onTeardownSuccess?: () => void,
    private onSessionMaterialized?: (session: { sessionId?: string; sessionFile?: string }) => void,
    initialMcpConfig?: McpRuntimeSettings,
  ) {
    if (initialMcpConfig) this.mcpConfigs.add(initialMcpConfig);
    this.runtimeParams = runtimeParams;
    this.sessionId = session.sessionId;
    this.onTeardownSuccess = onTeardownSuccess;
    this.bossmodeToolNames = new Set(bossmodeToolNames);
    this.toolAssembly = toolAssembly;
    this.unsubscribeSession = session.subscribe((raw) => {
      this.observeExecutionEvidence(raw);
      this.publishSessionReferenceIfMaterialized();
      this.observeCompactionWatchdog(raw);
      if (this.manualCompactionOutcome && (raw.type === "compaction_start" || raw.type === "compaction_end") && raw.reason === "manual") {
        if (raw.type === "compaction_start" && this.manualCompactionOutcome.aborted) {
          // Stop can arrive before the SDK creates its abort controller.
          this.session.abortCompaction();
        }
        if (raw.type === "compaction_end") this.manualCompactionOutcome.aborted = raw.aborted;
      }
      const mapped = mapPiAgentEvent(raw);
      if (mapped) this.emit(mapped);
      if (raw.type === "agent_start" && (this.promptAbortIntent?.aborted || this.destroyed)) {
        // SDK 0.82.1 creates activeRun before awaiting this public event. Re-abort
        // its NEW controller, then reject the awaited listener: the native loop
        // does not check the signal before calling streamFunction, so abort alone
        // is insufficient. Its lifecycle catch emits/persists the aborted receipt.
        // Check after forwarding too: a listener can request Stop on agent_start.
        this.session.agent.abort();
        throw new DOMException("Runtime prompt cancelled before agent execution", "AbortError");
      }
    });
    this.publishSessionReferenceIfMaterialized();
  }

  private executionService(): SdkExecutionService {
    return new SdkExecutionService(this.toolAssembly.memberId ?? "", this.toolAssembly.roomId);
  }

  private observeExecutionEvidence(raw: any): void {
    if (raw?.type === "message_end" && raw.message?.role === "assistant") {
      const stopReason = raw.message.stopReason ?? raw.message.stop_reason;
      const error = raw.message.errorMessage ?? raw.message.error_message;
      if (stopReason === "error" || stopReason === "aborted" || error) {
        this.promptAttempt?.noteUncertain(`SDK assistant ${stopReason ?? "error"}: ${error || "no detail"}`);
      }
    }
    if (raw?.type === "compaction_end" && (raw.aborted || raw.errorMessage)) {
      const reason = `SDK compaction ${raw.aborted ? "aborted" : "failed"}: ${raw.errorMessage || "no detail"}`;
      this.promptAttempt?.noteUncertain(reason);
      for (const attempt of this.compactAttempts) attempt.noteUncertain(reason);
    }
  }

  private interruptAttempts(reason: string, includeCompaction: boolean): void {
    const attempts = [this.promptAttempt, ...(includeCompaction ? this.compactAttempts : [])];
    for (const attempt of attempts) {
      if (!attempt) continue;
      // A void cancellation must still reach the SDK if recording fails. The
      // local evidence prevents acknowledgement and settlement retries the write.
      try { attempt.interrupt(reason); }
      catch (error) { logger.error("runtime:pi-sdk", "execution cancellation recording failed", { attemptId: attempt.id, error: String(error) }); }
    }
  }

  private async dispatchCompact(isCancelled?: () => boolean): Promise<void> {
    const attempt = this.executionService().dispatch("external", "pi-sdk:session.compact");
    this.compactAttempts.add(attempt);
    try {
      await attempt.run(async () => {
        try { await this.session.compact(); }
        catch (error) {
          // Only a rejected SDK call may use the public aborted outcome. SQL
          // admission/settlement failures must propagate even during teardown.
          if (!isCancelled?.()) throw error;
          attempt.noteUncertain(`SDK compaction cancelled: ${String(error)}`);
        }
      });
    } finally { this.compactAttempts.delete(attempt); }
  }

  private publishSessionReferenceIfMaterialized(): void {
    if (this.sessionReferencePublished || !this.onSessionMaterialized) return;
    const sessionFile = this.session.sessionFile;
    if (!sessionFile || !existsSync(sessionFile)) return;
    this.onSessionMaterialized({ sessionId: this.session.sessionId, sessionFile });
    this.sessionReferencePublished = true;
  }

  private emit(event: AgentStreamEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private startCompactionWatchdogRun(): void {
    const settings = this.session.settingsManager.getCompactionSettings();
    const model = this.session.model as any;
    const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : 0;
    const reserveTokens = settings.reserveTokens ?? 16384;
    if (settings.enabled === false || contextWindow <= 0) {
      this.compactionWatchdogRun = null;
      return;
    }
    this.compactionWatchdogRun = {
      maxTokens: 0,
      threshold: contextWindow - reserveTokens,
      actionThreshold: watchdogActionThreshold(contextWindow, reserveTokens),
      contextWindow,
      model: model?.provider && model?.id ? `${model.provider}/${model.id}` : (this.runtimeParams.model || "unknown"),
      compactionEventSeen: false,
      interventionRequested: false,
      emptyStopSeen: false,
    };
  }

  private observeCompactionWatchdog(raw: any): void {
    const run = this.compactionWatchdogRun;
    if (!run) return;
    if (raw?.type === "compaction_start" || raw?.type === "compaction_end") {
      run.compactionEventSeen = true;
      return;
    }
    if (raw?.type !== "message_end" || raw.message?.role !== "assistant") return;
    if (raw.message.stopReason === "error" || raw.message.stopReason === "aborted") return;
    const usage = raw.message.usage;
    if (!usage) return;
    const tokens = Number(usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)));
    if (Number.isFinite(tokens) && tokens > run.maxTokens) run.maxTokens = tokens;

    const hasToolCalls = assistantHasToolCalls(raw.message);
    if (
      raw.message.stopReason === "stop" &&
      !hasToolCalls &&
      assistantTextOf(raw.message.content).trim().length === 0 &&
      Number(usage.output ?? 0) <= 1
    ) {
      run.emptyStopSeen = true;
    }

    // Mid-run action: real usage crossed the action line and the turn continues
    // (tool calls pending). The SDK has no checkpoint until the run boundary, so
    // without this the next request can be clamped to max_tokens=1 (empty reply).
    if (
      !run.interventionRequested &&
      this.watchdogTurn && this.watchdogTurn.interventions === 0 &&
      run.actionThreshold > 0 &&
      run.maxTokens > run.actionThreshold &&
      hasToolCalls
    ) {
      run.interventionRequested = true;
      logger.warn("runtime:pi-sdk", "compaction watchdog: mid-run crossing, aborting for compaction", {
        model: run.model,
        maxTokens: run.maxTokens,
        actionThreshold: run.actionThreshold,
        contextWindow: run.contextWindow,
      });
      this.interruptAttempts("Compaction watchdog requested abort", false);
      void this.session.abort().catch((err) => {
        logger.error("runtime:pi-sdk", "compaction watchdog: abort failed", { error: String(err) });
      });
    }
  }

  private finishCompactionWatchdogRun(): CompactionWatchdogRun | null {
    const run = this.compactionWatchdogRun;
    this.compactionWatchdogRun = null;
    if (!run) return null;
    if (!run.compactionEventSeen && !run.interventionRequested && run.maxTokens > 0 && run.maxTokens > run.threshold) {
      logger.warn("runtime:pi-sdk", "compaction watchdog: run crossed threshold without SDK compaction event", {
        model: run.model,
        maxTokens: run.maxTokens,
        contextWindow: run.contextWindow,
        threshold: run.threshold,
      });
    }
    return run;
  }

  /**
   * Post-run watchdog decisions. Returns the next prompt to run (continue after
   * compaction / one empty-response retry), or null to settle the turn.
   */
  private async afterWatchdogRun(run: CompactionWatchdogRun | null): Promise<string | null> {
    const turn = this.watchdogTurn;
    if (!run || !turn || this.destroyed) return null;

    // A: mid-run intervention — the abort already happened; compact (unless the
    // SDK's own boundary check beat us to it), then continue the turn.
    if (run.interventionRequested && turn.interventions === 0) {
      turn.interventions++;
      await this.compactForWatchdog(run, "mid-run threshold crossing");
      return WATCHDOG_CONTINUE_PROMPT;
    }

    // B: empty assistant response (stop + no text + ≤1 output token).
    if (run.emptyStopSeen) {
      // Fault mode (usage near the clamp zone): compaction is decided by token
      // usage, never by response shape (fish 2026-07-29). The band is only armed
      // when it is positive — degenerate small windows fall through to the
      // generic retry below.
      const faultBandStart = run.actionThreshold - WATCHDOG_SAFETY_MARGIN;
      if (turn.interventions === 0 && faultBandStart > 0 && run.maxTokens > faultBandStart) {
        turn.interventions++;
        await this.compactForWatchdog(run, "empty response near context limit");
        return WATCHDOG_CONTINUE_PROMPT;
      }
      // Generic transient (low usage): one verbatim retry, then a visible error.
      if (turn.emptyRetries === 0) {
        turn.emptyRetries++;
        logger.warn("runtime:pi-sdk", "empty assistant response, retrying once", { model: run.model });
        return WATCHDOG_EMPTY_RETRY_PROMPT;
      }
      throw new Error("Model returned an empty response twice in a row. Try again, or compact/reset the session if it persists.");
    }
    return null;
  }

  private async compactForWatchdog(run: CompactionWatchdogRun, reason: string): Promise<void> {
    if (run.compactionEventSeen) {
      // The SDK's own post-run check already compacted after our abort.
      logger.info("runtime:pi-sdk", "compaction watchdog: SDK compaction already handled", { model: run.model, reason });
      return;
    }
    try {
      logger.warn("runtime:pi-sdk", "compaction watchdog: compacting", {
        model: run.model,
        reason,
        maxTokens: run.maxTokens,
        actionThreshold: run.actionThreshold,
      });
      await this.dispatchCompact();
    } catch (err: any) {
      const message = err?.message || String(err);
      // Raced with an SDK compaction (or nothing worth compacting) — fine.
      if (/already compacted|nothing to compact/i.test(message)) return;
      // No automatic retry (avoid retry storms): surface the failure instead.
      throw new Error(`Automatic context compaction failed: ${message}`);
    }
  }

  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private promptOperation: Promise<void> | null = null;
  prompt(message: string, options?: RuntimePromptOptions): Promise<void> {
    if (this.promptOperation) return Promise.reject(new Error("Runtime prompt is already in progress"));
    const operation = this.trackResourceOperation(() => this.promptInternal(message, options));
    this.promptOperation = operation;
    return operation.finally(() => { if (this.promptOperation === operation) this.promptOperation = null; });
  }
  private async promptInternal(message: string, options?: RuntimePromptOptions): Promise<void> {
    this.watchdogTurn = { interventions: 0, emptyRetries: 0 };
    try {
      let next: string | null = message;
      let dispatchIndex = 0;
      while (next !== null && !this.destroyed && this.watchdogTurn !== null) {
        this.startCompactionWatchdogRun();
        this.promptAbortIntent = { aborted: false };
        let settled: CompactionWatchdogRun | null = null;
        try {
          const dispatchMessage: string = next;
          if (options?.beforeDispatch?.constructor.name === "AsyncFunction") {
            throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");
          }
          const attempt = this.executionService().dispatch("input", "pi-sdk:session.prompt", options?.beforeDispatch
            ? attemptId => options.beforeDispatch!({ attemptId, dispatchIndex, message: dispatchMessage })
            : undefined);
          dispatchIndex++;
          this.promptAttempt = attempt;
          // A synchronous dispatch hook may itself request Stop before this
          // attempt is assigned. Record that intent after its SQL commit.
          if (this.promptAbortIntent.aborted || this.destroyed) attempt.interrupt("Runtime abort requested before SDK preflight");
          const run = attempt.run(() => this.session.prompt(dispatchMessage, { source: "external" as any })).catch((err) => {
            this.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: err.message || String(err) });
            throw err;
          }).finally(() => {
            if (this.currentRun === run) this.currentRun = null;
          });
          this.currentRun = run;
          await run;
        } finally {
          this.promptAttempt = null;
          this.promptAbortIntent = null;
          settled = this.finishCompactionWatchdogRun();
        }
        next = await this.afterWatchdogRun(settled);
      }
    } finally {
      this.publishSessionReferenceIfMaterialized();
      this.watchdogTurn = null;
    }
  }

  abort(options?: { preserveCompaction?: boolean }): void {
    if (this.promptAbortIntent) this.promptAbortIntent.aborted = true;
    this.interruptAttempts("Runtime abort requested", !options?.preserveCompaction);
    // The SDK owns aborted messages and tool results. Never patch session history.
    this.session.abort().catch(() => {});
    if (options?.preserveCompaction) return;
    this.watchdogTurn = null;
    if (this.manualCompactionOutcome) this.manualCompactionOutcome.aborted = true;
    try { this.session.abortCompaction(); } catch {}
    try { this.session.abortBranchSummary(); } catch {}
  }

  destroy(): void {
    // Same single teardown path. The void entry must swallow (and log) the
    // rejection — main-session stop/reload callers never await it, and an
    // unobserved promise here becomes an unhandled rejection. Await callers
    // still get the error from destroyAndWait itself.
    this.destroyAndWait().catch((err: any) => {
      logger.error("runtime:pi-sdk", "session teardown incomplete (void destroy)", { error: err?.message || String(err) });
    });
  }

  /** Idempotent awaitable teardown: every caller awaits the SAME settlement
   *  (repeated calls wait for the first, they never return early while the
   *  first teardown is still in flight). Collection covers every surface the
   *  SDK actually exposes: the session's own abort (which awaits waitForIdle),
   *  extension session_shutdown handler failures (delivered via onError —
   *  emit() catches handler throws and never rejects), emit failure itself,
   *  and the synchronous dispose (registered resource cleanups, e.g. provider
   *  session caches — AggregateError on failure). Each stage runs even when an
   *  earlier one fails; all errors are aggregated into one throw at the end. */
  async destroyAndWait(): Promise<void> {
    if (!this.destroyPromise) {
      this.destroyed = true;
      if (this.promptAbortIntent) this.promptAbortIntent.aborted = true;
      this.interruptAttempts("Runtime teardown requested", true);
      this.destroyPromise = this.runTeardown();
    }
    return this.destroyPromise;
  }

  private async runTeardown(): Promise<void> {
    if (this.manualCompactionOutcome) this.manualCompactionOutcome.aborted = true;
    const errors = await shutdownSdkSession(this.session, () => this.unsubscribeSession?.(), async () => {
      // SDK idle does not include manual compaction or reload continuations.
      await Promise.allSettled([...this.resourceOperations]);
    });
    for (const config of this.mcpConfigs) {
      try { config.dispose(); } catch (err) { errors.push(`MCP config cleanup: ${String(err)}`); }
    }
    this.mcpConfigs.clear();
    this.listeners.clear();
    if (errors.length > 0) {
      throw new Error(`teardown incomplete (${errors.length}): ${errors.join("; ")}`);
    }
    // A fully torn-down handle must not stay registered (and hold its session)
    // until service shutdown. Failed teardown stays registered so
    // shutdownAll can surface it rather than pretending cleanup succeeded.
    this.onTeardownSuccess?.();
  }

  async waitForIdle(): Promise<void> {
    if (this.promptOperation) await this.promptOperation.catch(() => {});
    else if (this.currentRun) await this.currentRun.catch(() => {});
  }

  refreshModelRegistry(_opts?: { allowNetwork?: boolean }): Promise<void> {
    return this.trackResourceOperation(()=>this.refreshModelRegistryInternal());
  }
  private async refreshModelRegistryInternal(): Promise<void> {
    // Catalog network refresh belongs to the application service; the SDK consumes SQL snapshots.
    const profileId = this.runtimeParams.credentialId;
    await refreshDatabaseModelRuntime(this.session.modelRuntime, profileId);
  }

  setModel(modelRef: string, credentialId: string): Promise<void> {
    return this.trackResourceOperation(()=>this.setModelInternal(modelRef,credentialId));
  }
  private async setModelInternal(modelRef: string, credentialId: string): Promise<void> {
    const { provider, modelId } = splitModelRef(modelRef);
    const profile = getModelCredentialProfile(credentialId);
    if (!profile || !profile.enabled || profile.providerSlug !== provider) {
      throw new Error(`Invalid credential binding for ${modelRef}`);
    }
    await this.credentials.runProfile(profile, () => refreshDatabaseModelRuntime(this.session.modelRuntime, profile.id));
    if (this.destroyed) throw new Error("Runtime instance is destroyed");
    const found = this.modelRegistry.find(provider, modelId);
    if (!found) throw new Error(`Model not found: ${modelRef}`);
    const model = this.credentials.bind(found, profile);
    await this.credentials.run(model, () => this.session.setModel(model));
    this.runtimeParams.model = resolveModelLabel(modelRef);
    this.runtimeParams.credentialId = profile.id;
    this.runtimeParams.credentialName = profile.name;
  }

  setThinkingLevel(level: string): void {
    if (this.destroyed) throw new Error("Runtime instance is destroyed");
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

  getActiveTools(): MemberActiveToolInfo[] {
    if (this.destroyed) return [];
    try {
      const session = this.session as any;
      if (typeof session.getActiveToolNames !== "function" || typeof session.getAllTools !== "function") return [];
      const active = new Set<string>((session.getActiveToolNames() as string[]) || []);
      const all = (session.getAllTools() as Array<{
        name: string;
        description?: string;
        parameters?: unknown;
        sourceInfo?: { path?: string; source?: string; baseDir?: string };
      }>) || [];
      const tools: MemberActiveToolInfo[] = [];
      for (const t of all) {
        if (!t?.name || !active.has(t.name)) continue;
        const def = typeof session.getToolDefinition === "function" ? session.getToolDefinition(t.name) : undefined;
        tools.push({
          name: t.name,
          label: typeof def?.label === "string" ? def.label : t.name,
          description: t.description || "",
          parameters: t.parameters ?? { type: "object", properties: {} },
          source: classifyToolSource(t.name, this.bossmodeToolNames, t.sourceInfo),
        });
      }
      return tools;
    } catch (err) {
      logger.warn("runtime:pi-sdk", "getActiveTools failed", { error: String(err) });
      return [];
    }
  }

  /** Called by the owner at the idle boundary before the next prompt. */
  refreshPrompt(opts: { agentPrompt: string; appendSystemPrompt: string[] }): void {
    if (this.destroyed) throw new Error("Runtime instance is destroyed");
    if (this.currentRun || this.watchdogTurn || this.manualCompactionOutcome || this.session.isStreaming || this.session.isCompacting) {
      throw new Error("Prompt refresh requires an idle pre-prompt boundary");
    }
    const sources = resolvePiSystemPromptSources(opts);
    this.resourceLoader.setPromptSources(sources);
    // Supported SDK API rebuilds its base prompt from the resource loader.
    // Retain the exact active tools, session history, resources, and credentials.
    this.session.setActiveToolsByName(this.session.getActiveToolNames());
    this.runtimeParams.systemPrompt = [sources.systemPrompt, ...sources.appendSystemPrompt].filter(Boolean).join("\n\n");
  }

  private resourceOperations = new Set<Promise<unknown>>();
  private trackResourceOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error("Runtime instance is destroyed"));
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<T>((yes,no) => { resolve=yes; reject=no; });
    this.resourceOperations.add(pending);
    // Register ownership first, then start synchronously so an immediate abort
    // sees manual-compaction admission even before the SDK's first event.
    try { operation().then(resolve,reject); } catch (error) { reject(error); }
    return pending.finally(() => this.resourceOperations.delete(pending));
  }

  reloadResources(opts: ReloadAgentResourcesOpts): Promise<void> {
    return this.trackResourceOperation(() => this.reloadResourcesInternal(opts));
  }
  private async reloadResourcesInternal(opts: ReloadAgentResourcesOpts): Promise<void> {
    if (this.destroyed) throw new Error("Runtime instance is destroyed");
    await this.waitForIdle();
    if (this.destroyed) throw new Error("Runtime instance is destroyed");
    const mcpSettings = resolveMcpRuntimeSettings({ roomId: opts.roomId, member: opts.member });
    // A failed reload can leave either generation active; retain both until teardown.
    this.mcpConfigs.add(mcpSettings);
    // Batch 6 §1: member dir assets re-resolved on every reload.
    const memberAssets = memberDirLoaderAssetPaths(opts.member.id);
    // Batch 7 closeout (fish 2026-09-04): the platform extension store is gone —
    // member-owned extensions/ dir entries are the only managed extensions.
    const managedExtensions = [...memberAssets.extensions];
    const activeExtensionPaths = [
      ...managedExtensions,
      ...this.baseExtensionPaths.filter((p) => !managedExtensions.includes(p)),
    ];
    const appendBase = (opts.appendSystemPrompt || []).filter((v) => v && v.trim().length > 0);
    const promptSources = resolvePiSystemPromptSources({
      agentPrompt: opts.agentPrompt,
      appendSystemPrompt: appendBase,
    });
    this.resourceLoader.setPromptSources(promptSources);
    this.resourceLoader.setResourcePaths(
      [...opts.skillPaths.filter((p) => existsSync(p)), ...memberAssets.skills], activeExtensionPaths,
    );

    await this.session.reload({
      beforeSessionStart: async () => {
        if (this.destroyed) throw new Error("Runtime instance is destroyed");
        assertHostedMcpLoaded(this.resourceLoader);
        this.session.extensionRunner.setFlagValue("mcp-config", mcpSettings.configPath);
      },
    });
    // Agent/session reload re-reads settings and clears in-memory overrides.
    // Reapply runtime transport only after it completes so explicit Codex SSE/WS
    // and timeout configuration remains effective for the next provider call.
    const transportSettings = applyRuntimeTransportSettings(this.settingsManager);
    logger.info("runtime:pi-sdk", "reloadResources transport", {
      agent: opts.member.name,
      transport: transportSettings.transport,
      websocketConnectTimeoutMs: transportSettings.websocketConnectTimeoutMs,
      httpIdleTimeoutMs: transportSettings.httpIdleTimeoutMs,
    });
    // Refresh bossmode tool name set from the same factory that builds customTools (leader gate, new tools).
    this.toolAssembly = {
      roomId: opts.roomId,
      agentName: opts.member.name,
      roomMembers: this.toolAssembly.roomMembers,
      memberId: this.toolAssembly.memberId ?? opts.member.id,
    };
    const customTools = createBossmodeSdkTools({
    roomId: opts.roomId,
    memberId: opts.member.id,
    scopeKind: opts.roomId.startsWith("dm:") ? "dm" : "room",
    ...(opts.resolveChatId ? { resolveChatId: opts.resolveChatId } : {}),
});
    this.bossmodeToolNames = new Set(customTools.map((t) => t.name));
    if (typeof (this.session as any).setActiveToolsByName !== "function" || typeof (this.session as any).getActiveToolNames !== "function") {
      throw new Error("Runtime cannot verify active tools after reload.");
    }
    // Keep extension tools enabled after reload (pi reload uses includeAllExtensionTools).
    // Do NOT reset active tools to base+mcp only — that stripped web_search/fetch_content.
    const registeredNames: string[] = typeof (this.session as any).getAllTools === "function"
      ? (this.session as any).getAllTools().map((t: { name: string }) => t.name)
      : [];
    let activeTools = registeredNames.length > 0
      ? registeredNames
      : [...this.baseToolNames, ...(mcpSettings.enabled ? ["mcp"] : [])];
    if (!mcpSettings.enabled) {
      activeTools = activeTools.filter((n) => n !== "mcp");
    } else if (!activeTools.includes("mcp")) {
      activeTools = [...activeTools, "mcp"];
    }
    (this.session as any).setActiveToolsByName(activeTools);
    const activeToolNames = await (this.session as any).getActiveToolNames();
    const mcpIsActive = Array.isArray(activeToolNames) && activeToolNames.includes("mcp");
    if (mcpIsActive !== mcpSettings.enabled) {
      throw new Error("Reload could not apply MCP access.");
    }

    // Panel metadata: bossmode segments only (role + original appends), not pi built-in.
    this.runtimeParams.systemPrompt = [opts.agentPrompt.trim(), ...appendBase].filter(Boolean).join("\n\n");
    this.runtimeParams.skills = opts.skillNames ?? opts.skillPaths;
    this.runtimeParams.extensions = ["bossmode-sdk-tools", ...activeExtensionPaths, "pi-mcp-adapter"];
    for (const config of this.mcpConfigs) {
      if (config === mcpSettings) continue;
      config.dispose();
      this.mcpConfigs.delete(config);
    }
    logger.info("runtime:pi-sdk", "reloaded resources", { agent: opts.member.name, skills: opts.skillPaths.length, mcpEnabled: mcpSettings.enabled, mcpServers: mcpSettings.serverNames });
  }

  compact(): Promise<{ aborted: boolean }> {
    return this.trackResourceOperation(() => this.compactInternal());
  }
  private async compactInternal(): Promise<{ aborted: boolean }> {
    const outcome = { aborted: false };
    this.manualCompactionOutcome = outcome;
    this.emit({ type: "agent_start" });
    try {
      // The supported SDK emits compaction_start/end itself, then rejects on
      // cancellation or failure. Never manufacture replacement events.
      await this.dispatchCompact(() => outcome.aborted);
    } finally {
      this.manualCompactionOutcome = null;
      this.emit({ type: "agent_end" });
    }
    return outcome;
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

  private handles = new Map<PiSdkAgentHandle, string>();
  private creationCleanupFailures = new Map<string, Error[]>();
  /** Shared shutdown settlement: concurrent shutdownAll calls await the same teardown. */
  private shutdownSettlement: Promise<void> | null = null;

  async detect(): Promise<RuntimeDetectResult> {
    return { available: true, version: PI_SDK_VERSION, path: "@earendil-works/pi-coding-agent" };
  }

  async createAgent(opts: CreateAgentOpts): Promise<AgentHandle> {
    const attempt = new SdkExecutionService(opts.member.id, opts.roomId).dispatch("session-create", "pi-sdk:createAgent");
    let handle: PiSdkAgentHandle | undefined;
    try {
      handle = await this.createAgentInternal(opts);
      attempt.settle();
      return handle;
    } catch (error) {
      // Internal creation already cleans partial sessions. A fully created
      // handle still needs teardown if durable acknowledgement itself fails.
      if (handle) {
        try { await handle.destroyAndWait(); }
        catch (cleanupError) {
          return attempt.fail(new AggregateError([error, cleanupError], "Runtime creation and cleanup failed"));
        }
      }
      return attempt.fail(error);
    }
  }

  private async createAgentInternal(opts: CreateAgentOpts): Promise<PiSdkAgentHandle> {
    if (!opts.member.model || !opts.member.credentialId) {
      throw new Error(`Member "${opts.member.name}" hasn't selected a model yet. Open the member card to choose a model and credential.`);
    }
    const modelRef = opts.member.model;
    const piConfig = exportPiConfigForMember({
      roomId: opts.roomId,
      memberName: opts.member.id,
      modelRef,
      credentialId: opts.member.credentialId,
    });
    if (!piConfig || !piConfig.profile) {
      throw new Error(`No model credentials configured for ${modelRef}. Go to Settings → Model Credentials to add or import credentials.`);
    }
    const provider = piConfig.profile.providerSlug;
    const modelIdSlash = modelRef.indexOf("/");
    const modelId = modelIdSlash >= 0 ? modelRef.slice(modelIdSlash + 1) : modelRef;
    const resolvedModel = `${provider}/${modelId}`;

    const defaultAgentDir = resolvePiAgentDir(opts.roomId, opts.member.id);
    const runtimeAgentDir = piConfig?.agentDir || defaultAgentDir;
    const sessionDir = opts.sessionDir ?? join(runtimeAgentDir, "sessions");
    mkdirSync(runtimeAgentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    if (!piConfig.profile) throw new Error(`No model credentials configured for ${resolvedModel}. Go to Settings → Model Credentials to add or import credentials.`);
    const authStorageCredentials = new ModelCredentialBinding(piConfig.profile);
    const runtime = await createDatabaseModelRuntime(authStorageCredentials, piConfig.profile.id);
    authStorageCredentials.attach(runtime);
    const modelRegistry = new ModelRegistry(runtime);
    const settingsManager = SettingsManager.create(opts.cwd, runtimeAgentDir);
    const foundModel = modelRegistry.find(provider, modelId);
    if (!foundModel) throw new Error(`Model not found: ${resolvedModel}`);
    const model = authStorageCredentials.bind(foundModel, piConfig.profile);
    const authCheck = await modelRegistry.getApiKeyAndHeaders(model);
    if (!authCheck.ok) throw new Error(`Credential projection failed for ${resolvedModel}: ${authCheck.error}`);
    if (!authCheck.apiKey && piConfig.profile?.authType !== "ambient") throw new Error(`Credential projection failed for ${resolvedModel}: no API key available for provider ${provider}`);

    let sessionManager: SessionManager;
    let appendConfiguredModelChange = false;
    if (opts.sessionManager) {
      // A provided manager must not be re-opened before the first append —
      // re-opening the file would restore the old leaf.
      sessionManager = opts.sessionManager as SessionManager;
    } else
    try {
      const resumeFile = opts.resumeSession?.sessionFile;
      if (resumeFile && existsSync(resumeFile)) {
        const resumed = SessionManager.open(resumeFile, sessionDir, opts.cwd);
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
        if (resumeFile) {
          logger.warn("runtime:pi-sdk", "saved session file missing, starting fresh", { agent: opts.member.name, sessionFile: resumeFile });
        }
        sessionManager = SessionManager.create(opts.cwd, sessionDir);
      }
    } catch (err) {
      logger.warn("runtime:pi-sdk", "session resume failed, starting fresh", { agent: opts.member.name, error: String(err) });
      sessionManager = SessionManager.create(opts.cwd, sessionDir);
    }

    const rolePrompt = opts.agentPrompt.trim();
    const appendBase = (opts.appendSystemPrompt && opts.appendSystemPrompt.length > 0
      ? opts.appendSystemPrompt
      : [opts.envPrompt, opts.rulesPrompt]
    ).filter((v): v is string => !!v && v.trim().length > 0);
    const promptSources = resolvePiSystemPromptSources({
      agentPrompt: opts.agentPrompt,
      appendSystemPrompt: appendBase,
    });
    const appendSystemPrompt = promptSources.appendSystemPrompt;
    // Batch 6 §1: member-owned assets join the loader paths — skills dir
    // (§1.1) and extensions dir (§1.3, directory present = loaded).
    const memberAssets = memberDirLoaderAssetPaths(opts.member.id);
    const skillPaths = [...opts.skillPaths.filter((p) => existsSync(p)), ...memberAssets.skills];
    const mcpSettings = resolveMcpRuntimeSettings({ roomId: opts.roomId, member: opts.member });
    let sessionObtained: AgentSession | null = null;
    try {
      // Managed extensions = member dir (unconditional) + platform packages on
      // the member's enable list (§1.3: list serves the two platform packs only).
      // Batch 7 closeout (fish 2026-09-04): the platform extension store is gone —
      // member-owned extensions/ dir entries are the only managed extensions.
      const managedExtensions = [...memberAssets.extensions];
      const extensionPaths = [...managedExtensions, ...(piConfig?.extensionPaths ?? [])];
      const activeExtensionPaths = extensionPaths;
      const mcpFactory = await loadDatabaseMcpFactory(mcpSettings.adapterPath!);
      const resourceLoader = new BossmodeResourceLoader({
        cwd: opts.cwd,
        agentDir: runtimeAgentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        additionalSkillPaths: skillPaths,
        additionalExtensionPaths: activeExtensionPaths,
        extensionFactories: [mcpFactory],
        systemPrompt: promptSources.systemPrompt,
        appendSystemPrompt,
      }, promptSources);
      await resourceLoader.reload();
      assertHostedMcpLoaded(resourceLoader);
      // DefaultResourceLoader.reload() reloads SettingsManager and clears its
      // in-memory overrides. Apply runtime transport afterwards, immediately
      // before the SDK session is created.
      const transportSettings = applyRuntimeTransportSettings(settingsManager);

      const customTools = createBossmodeSdkTools({
      roomId: opts.roomId,
      memberId: opts.member.id,
      scopeKind: opts.roomId.startsWith("dm:") ? "dm" : "room",
      ...(opts.resolveChatId ? { resolveChatId: opts.resolveChatId } : {}),
  });
      const baseTools = ["read", "edit", "write", ...customTools.map((t) => t.name)];
      // Omit `tools` allowlist so pi keeps extension/custom tools enabled (SDK docs:
      // when tools is provided it becomes a lifetime allowlist and strips extension
      // tools like web_search/fetch_content). MCP is loaded once through its
      // SQL-bound inline factory, not through the standalone file-storage entry.
      // Once the SDK session exists, any later failure (MCP bind or setModel)
      // must not leak it — dispose before rethrowing.
      const { session } = await createAgentSession({
        cwd: opts.cwd,
        agentDir: runtimeAgentDir,
        modelRuntime: runtime,
        model,
        thinkingLevel: (opts.member.thinkingLevel || "off") as any,
        resourceLoader,
        sessionManager,
        settingsManager,
        customTools,
        // Batch 7 P2: one-shot bash is retired — persistent shells replace it.
        excludeTools: ["bash"],
      });
      sessionObtained = session;

      authStorageCredentials.followSession(() => session.model);
      await bindMcpExtension(session, { configPath: mcpSettings.configPath, agent: opts.member.name });

      if (appendConfiguredModelChange) {
        await session.setModel(model);
      }

      const runtimeParams: AgentRuntimeParams = {
        model: resolvedModel,
        thinkingLevel: session.thinkingLevel || opts.member.thinkingLevel || "off",
        // Panel metadata: bossmode-composed segments only (never pi built-in text).
        systemPrompt: [rolePrompt, ...appendBase].filter(Boolean).join("\n\n"),
        skills: opts.skillNames ?? skillPaths,
        extensions: ["bossmode-sdk-tools", ...activeExtensionPaths, "pi-mcp-adapter"],
        credentialId: piConfig.profile?.id,
        credentialName: piConfig.profile?.name,
      };
      let handle: PiSdkAgentHandle;
      handle = new PiSdkAgentHandle(
        session,
        modelRegistry,
        authStorageCredentials,
        resourceLoader,
        settingsManager,
        extensionPaths,
        baseTools,
        runtimeParams,
        customTools.map((t) => t.name),
        { roomId: opts.roomId, agentName: opts.member.name, roomMembers: opts.roomMembers, memberId: opts.member.id },
        () => this.handles.delete(handle),
        opts.onSessionChanged,
        mcpSettings,
      );
      this.handles.set(handle, opts.member.id);
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
        mcpServers: mcpSettings.serverNames,
      });
      return handle;
    } catch (err) {
      const cleanupErrors = sessionObtained ? await shutdownSdkSession(sessionObtained) : [];
      try { mcpSettings.dispose(); } catch (error) { cleanupErrors.push(`MCP config cleanup: ${String(error)}`); }
      if (cleanupErrors.length) {
        const failure = new AggregateError([err, ...cleanupErrors.map(message => new Error(message))], "Runtime creation and cleanup failed");
        const failures = this.creationCleanupFailures.get(opts.member.id) ?? [];
        failures.push(failure); this.creationCleanupFailures.set(opts.member.id, failures);
        throw failure;
      }
      throw err;
    }
  }

  async shutdownMember(memberId: string): Promise<void> {
    const failures: unknown[] = [...(this.creationCleanupFailures.get(memberId) ?? [])];
    await Promise.all([...this.handles].filter(([,owner]) => owner === memberId).map(async ([handle]) => {
      try { await handle.destroyAndWait(); } catch (error) { failures.push(error); }
    }));
    if (failures.length) throw new AggregateError(failures, "Member runtime teardown incomplete");
  }

  async shutdownAll(): Promise<void> {
    // Concurrent callers share ONE settlement — a call landing mid-shutdown
    // awaits the same teardown instead of racing on an empty/cleared set.
    if (this.shutdownSettlement) return this.shutdownSettlement;
    const failures: unknown[] = [...this.creationCleanupFailures.values()].flat();
    const settlements: Promise<void>[] = [];
    for (const handle of this.handles.keys()) {
      settlements.push((handle as PiSdkAgentHandle).destroyAndWait().catch((err: unknown) => { failures.push(err); }));
    }
    this.shutdownSettlement = (async () => {
      await Promise.all(settlements);
      if (failures.length > 0) {
        throw new AggregateError(failures, `shutdownAll: ${failures.length} session teardown(s) incomplete`);
      }
    })().finally(() => {
      // Sharing only matters while a shutdown is in flight; once settled, a
      // later call rechecks retained failures; successful handles remove themselves.
      this.shutdownSettlement = null;
    });
    return this.shutdownSettlement;
  }
}
