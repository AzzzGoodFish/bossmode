// Pi SDK Runtime — in-process pi Agent SDK integration behind the legacy pi-cli storage key
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { logger } from "../../foundation/logger.js";
import { readConfig } from "../../shared/config.js";
import { ensureBossmodeMcpDirs, getBossmodeMcpConfigPath, getBossmodeMcpRuntimeDir, writeScopedMcpConfig } from "../../shared/mcp-settings.js";
import type { AgentMemberConfig, PiTransportSetting } from "../../shared/types.js";
import { getBossmodePiRuntimeRoot, exportPiConfigForMember, normalizeModelRef, createMemberCredentialStore } from "../model-credentials.js";
import { listInstalledExtensions, resolveMemberExtensionPaths } from "../../workspace/extension-store.js";
import { createBossmodeSdkTools } from "./bossmode-sdk-tools.js";
import { mapContextUsage, mapPiAgentEvent } from "./pi-events.js";
import type { AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts, RuntimeCapabilities, RuntimeDetectResult, ContextUsage, AgentRuntimeParams, ReloadAgentResourcesOpts, MemberActiveToolInfo } from "./types.js";

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);

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
    try {
      for (const ext of listInstalledExtensions()) {
        const markers = [ext.name, ...ext.extensionPaths, ...(ext.id ? [ext.id] : [])];
        if (markers.some((m) => m && haystack.includes(m))) {
          return `extension:${ext.name}`;
        }
      }
    } catch {
      /* ignore catalog errors — fall through */
    }
    // Path still looks like an extension even if not in catalog
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
  const defaults: RuntimeTransportSettings = { transport: "auto", websocketConnectTimeoutMs: 15000 };
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
  serverNames: string[];
}

function resolveVendorMcpAdapterPath(): string {
  return fileURLToPath(new URL("../../../vendor/pi-mcp-adapter/index.ts", import.meta.url));
}

function resolveMcpRuntimeSettings(args: { roomId: string; member: AgentMemberConfig }): McpRuntimeSettings {
  const globalConfigPath = getBossmodeMcpConfigPath();
  const runtimeDir = getBossmodeMcpRuntimeDir();
  let enabled = false;
  try {
    enabled = readConfig().mcp?.enabled === true;
  } catch {
    enabled = false;
  }
  const assignedServers = Array.isArray(args.member.mcpServers) ? args.member.mcpServers : [];
  if (!enabled || assignedServers.length === 0) return { enabled: false, configPath: globalConfigPath, runtimeDir, serverNames: [] };

  const adapterPath = resolveVendorMcpAdapterPath();
  if (!existsSync(adapterPath)) {
    throw new Error(`MCP adapter not found at ${adapterPath}. Run git submodule update --init --recursive.`);
  }
  ensureBossmodeMcpDirs();
  const scoped = writeScopedMcpConfig({ roomId: args.roomId, memberId: args.member.id, serverNames: assignedServers });
  if (scoped.serverNames.length === 0) {
    logger.warn("runtime:pi-sdk", "mcp scoped config has no valid assigned servers", { roomId: args.roomId, member: args.member.name, assignedServers });
    return { enabled: false, configPath: scoped.configPath, runtimeDir, serverNames: [] };
  }
  process.env.MCP_DIRECT_TOOLS = "__none__";
  process.env.BOSSMODE_MCP_CONFIG_STRICT = "1";
  process.env.PI_CODING_AGENT_DIR = runtimeDir;
  process.env.MCP_OAUTH_DIR = join(runtimeDir, "oauth");
  return { enabled: true, adapterPath, configPath: scoped.configPath, runtimeDir, serverNames: scoped.serverNames };
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

class PiSdkAgentHandle implements AgentHandle {
  readonly runtimeName = "pi-cli";
  readonly runtimeParams: AgentRuntimeParams;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private unsubscribeSession: (() => void) | undefined;
  private currentRun: Promise<void> | null = null;
  private compactionWatchdogRun: CompactionWatchdogRun | null = null;
  private watchdogTurn: WatchdogTurnState | null = null;
  private manualCompactionBridge: { rawStartSeen: boolean; rawEndSeen: boolean; syntheticStartEmitted: boolean; syntheticEndEmitted: boolean } | null = null;
  private destroyed = false;
  /** Live set of bossmode custom tool names (from createBossmodeSdkTools) — sole source for "bossmode" classification. */
  private bossmodeToolNames: Set<string>;
  private toolAssembly: { roomId: string; agentName: string; roomMembers: string[] };

  constructor(
    private session: AgentSession,
    private modelRegistry: ModelRegistry,
    private resourceLoader: DefaultResourceLoader,
    private baseExtensionPaths: string[],
    private baseToolNames: string[],
    runtimeParams: AgentRuntimeParams,
    bossmodeToolNames: Iterable<string>,
    toolAssembly: { roomId: string; agentName: string; roomMembers: string[] },
  ) {
    this.runtimeParams = runtimeParams;
    this.bossmodeToolNames = new Set(bossmodeToolNames);
    this.toolAssembly = toolAssembly;
    this.unsubscribeSession = session.subscribe((raw) => {
      this.observeCompactionWatchdog(raw);
      const bridge = this.manualCompactionBridge;
      const rawEvent = raw as any;
      if (bridge && rawEvent?.reason === "manual") {
        if (rawEvent?.type === "compaction_start") {
          bridge.rawStartSeen = true;
          if (bridge.syntheticStartEmitted) return;
        }
        if (rawEvent?.type === "compaction_end") {
          bridge.rawEndSeen = true;
          if (bridge.syntheticEndEmitted) return;
        }
      }
      const mapped = mapPiAgentEvent(raw);
      if (mapped) this.emit(mapped);
    });
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
    // The run ended right after a watchdog abort: repair dangling tool calls
    // NOW (synchronously), before the SDK's own post-run compaction check
    // summarizes the branch — a tool_use without tool_result breaks that request.
    if (raw?.type === "agent_end" && run.interventionRequested) {
      this.synthesizeDanglingToolResults("watchdog-abort");
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
      void this.session.abort().catch((err) => {
        logger.error("runtime:pi-sdk", "compaction watchdog: abort failed", { error: String(err) });
      });
    }
  }

  /**
   * Append failure tool results for tool calls the aborted run never executed
   * (the agent loop's abort path only finalizes in-flight calls). Mirrors the
   * SDK's failToolCallsFromTruncatedMessage precedent. Writes both the session
   * branch (summarization input) and live agent state (next request input).
   */
  private synthesizeDanglingToolResults(trigger: string): number {
    try {
      const messages = (this.session as any).state?.messages as any[] | undefined;
      const sessionManager = (this.session as any).sessionManager;
      if (!Array.isArray(messages) || typeof sessionManager?.appendMessage !== "function") return 0;
      let assistantIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        const role = messages[i]?.role;
        if (role === "assistant") { assistantIdx = i; break; }
        if (role === "user") break; // turn boundary — nothing dangling from this turn
      }
      if (assistantIdx < 0) return 0;
      const assistant = messages[assistantIdx];
      const toolCalls = Array.isArray(assistant.content) ? assistant.content.filter((c: any) => c?.type === "toolCall") : [];
      if (toolCalls.length === 0) return 0;
      const answered = new Set<string>();
      for (let i = assistantIdx + 1; i < messages.length; i++) {
        const m = messages[i];
        if (m?.role === "toolResult" && m.toolCallId) answered.add(m.toolCallId);
      }
      let synthesized = 0;
      for (const tc of toolCalls) {
        if (!tc?.id || answered.has(tc.id)) continue;
        const resultMessage = {
          role: "toolResult",
          toolCallId: tc.id,
          toolName: tc.name,
          content: [{ type: "text", text: `Tool call "${tc.name}" was not executed: the turn was interrupted for automatic context compaction. Re-issue the tool call.` }],
          isError: true,
          timestamp: Date.now(),
        };
        sessionManager.appendMessage(resultMessage);
        messages.push(resultMessage);
        synthesized++;
      }
      if (synthesized > 0) {
        logger.warn("runtime:pi-sdk", "compaction watchdog: synthesized failure results for dangling tool calls", { count: synthesized, trigger });
      }
      return synthesized;
    } catch (err) {
      logger.error("runtime:pi-sdk", "compaction watchdog: dangling tool result synthesis failed", { error: String(err) });
      return 0;
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
      await this.session.compact();
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

  async prompt(message: string): Promise<void> {
    if (message === "/compact") return this.compact();
    this.watchdogTurn = { interventions: 0, emptyRetries: 0 };
    try {
      let next: string | null = message;
      while (next !== null) {
        this.startCompactionWatchdogRun();
        const run = this.session.prompt(next, { source: "external" as any }).catch((err) => {
          this.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: err.message || String(err) });
          throw err;
        }).finally(() => {
          if (this.currentRun === run) this.currentRun = null;
        });
        this.currentRun = run;
        let settled: CompactionWatchdogRun | null = null;
        try {
          await run;
        } finally {
          settled = this.finishCompactionWatchdogRun();
        }
        next = await this.afterWatchdogRun(settled);
      }
    } finally {
      this.watchdogTurn = null;
    }
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

  async refreshModelRegistry(opts?: { allowNetwork?: boolean }): Promise<void> {
    // Prefer a disk-only reload: models.json is written by exportPiConfigForMember
    // right before switch, and network catalog fetches can hang (fish 2026-07-30).
    const allowNetwork = opts?.allowNetwork ?? false;
    const runtime = (this.modelRegistry as any).runtime;
    if (runtime && typeof runtime.refresh === "function") {
      await runtime.refresh({ allowNetwork });
      return;
    }
    await this.modelRegistry.refresh();
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

  async reloadResources(opts: ReloadAgentResourcesOpts): Promise<void> {
    if (this.destroyed) throw new Error("Runtime instance is destroyed");
    await this.waitForIdle();
    const mcpSettings = resolveMcpRuntimeSettings({ roomId: opts.roomId, member: opts.member });
    // Re-resolve member-enabled extensions on every reload (install/uninstall + toggles).
    const managedExtensions = resolveMemberExtensionPaths(opts.member.extensions);
    const activeExtensionPaths = mcpSettings.enabled && mcpSettings.adapterPath
      ? [...managedExtensions, ...this.baseExtensionPaths.filter((p) => !managedExtensions.includes(p)), mcpSettings.adapterPath]
      : [...managedExtensions, ...this.baseExtensionPaths.filter((p) => !managedExtensions.includes(p))];
    const loader = this.resourceLoader as any;
    loader.systemPromptSource = opts.agentPrompt.trim() || undefined;
    loader.appendSystemPromptSource = (opts.appendSystemPrompt || []).filter((v) => v && v.trim().length > 0);
    loader.additionalSkillPaths = opts.skillPaths;
    loader.additionalExtensionPaths = activeExtensionPaths;

    if (typeof (this.session as any).reload === "function") await (this.session as any).reload();
    else await this.resourceLoader.reload();
    if (mcpSettings.enabled) await bindMcpExtension(this.session, { configPath: mcpSettings.configPath, agent: opts.member.name });
    // Refresh bossmode tool name set from the same factory that builds customTools (leader gate, new tools).
    this.toolAssembly = {
      roomId: opts.roomId,
      agentName: opts.member.name,
      roomMembers: this.toolAssembly.roomMembers,
    };
    const customTools = createBossmodeSdkTools({
      roomId: opts.roomId,
      agentName: opts.member.name,
      roomMembers: this.toolAssembly.roomMembers,
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

    this.runtimeParams.systemPrompt = [opts.agentPrompt, ...(opts.appendSystemPrompt || [])].filter(Boolean).join("\n\n");
    this.runtimeParams.skills = opts.skillNames ?? opts.skillPaths;
    this.runtimeParams.extensions = ["bossmode-sdk-tools", ...activeExtensionPaths];
    logger.info("runtime:pi-sdk", "reloaded resources", { agent: opts.member.name, skills: opts.skillPaths.length, mcpEnabled: mcpSettings.enabled, mcpServers: mcpSettings.serverNames });
  }

  private async compact(): Promise<void> {
    this.emit({ type: "agent_start" });
    const bridge = { rawStartSeen: false, rawEndSeen: false, syntheticStartEmitted: false, syntheticEndEmitted: false };
    this.manualCompactionBridge = bridge;
    const emitSyntheticStartIfNeeded = () => {
      if (bridge.rawStartSeen || bridge.syntheticStartEmitted) return;
      bridge.syntheticStartEmitted = true;
      this.emit({ type: "compaction_start", reason: "manual" });
    };
    const emitSyntheticEndIfNeeded = (event: { aborted: boolean; willRetry: boolean; errorMessage?: string; tokensBefore?: number; result?: unknown }) => {
      if (bridge.rawEndSeen || bridge.syntheticEndEmitted) return;
      bridge.syntheticEndEmitted = true;
      this.emit({ type: "compaction_end", reason: "manual", ...event });
    };
    try {
      const compactRun = this.session.compact();
      await Promise.resolve();
      emitSyntheticStartIfNeeded();
      const result = await compactRun;
      const tokensBefore = Number((result as any)?.tokensBefore);
      emitSyntheticEndIfNeeded({
        aborted: false,
        willRetry: false,
        ...(Number.isFinite(tokensBefore) ? { tokensBefore } : {}),
        ...(result !== undefined ? { result } : {}),
      });
    } catch (err: any) {
      emitSyntheticStartIfNeeded();
      emitSyntheticEndIfNeeded({ aborted: false, willRetry: false, errorMessage: err.message || String(err), result: { error: err.message || String(err) } });
    } finally {
      this.manualCompactionBridge = null;
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

    const safeRoom = safeSegment(opts.roomId);
    const safeMember = safeSegment(opts.member.id);
    const runtimeAgentDir = piConfig?.agentDir || join(getBossmodePiRuntimeRoot(), safeRoom, safeMember);
    const sessionDir = join(getBossmodePiRuntimeRoot(), safeRoom, safeMember, "sessions");
    mkdirSync(runtimeAgentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    if (!piConfig.profile) throw new Error(`No model credentials configured for ${resolvedModel}. Go to Settings → Model Credentials to add or import credentials.`);
    // Live-read the member's current credential binding on every request so a
    // mid-session credential switch takes effect on the next model call.
    const authStorageCredentials = createMemberCredentialStore(opts.roomId, opts.member.id);
    const runtime = await ModelRuntime.create({ credentials: authStorageCredentials, modelsPath: join(runtimeAgentDir, "models.json"), allowModelNetwork: false });
    const modelRegistry = new ModelRegistry(runtime);
    const settingsManager = SettingsManager.create(opts.cwd, runtimeAgentDir);
    const transportSettings = applyRuntimeTransportSettings(settingsManager);
    const model = modelRegistry.find(provider, modelId);
    if (!model) throw new Error(`Model not found: ${resolvedModel}`);
    const authCheck = await modelRegistry.getApiKeyAndHeaders(model);
    if (!authCheck.ok) throw new Error(`Credential projection failed for ${resolvedModel}: ${authCheck.error}`);
    if (!authCheck.apiKey && piConfig.profile?.authType !== "ambient") throw new Error(`Credential projection failed for ${resolvedModel}: no API key available for provider ${provider}`);

    let sessionManager: SessionManager;
    let appendConfiguredModelChange = false;
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
    const appendSystemPrompt = (opts.appendSystemPrompt && opts.appendSystemPrompt.length > 0
      ? opts.appendSystemPrompt
      : [opts.envPrompt, opts.rulesPrompt]
    ).filter((v): v is string => !!v && v.trim().length > 0);
    const skillPaths = opts.skillPaths.filter((p) => existsSync(p));
    const mcpSettings = resolveMcpRuntimeSettings({ roomId: opts.roomId, member: opts.member });
    // Only extensions explicitly enabled on this member (default empty = none).
    const managedExtensions = resolveMemberExtensionPaths(opts.member.extensions);
    const extensionPaths = [...managedExtensions, ...(piConfig?.extensionPaths ?? [])];
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
    const baseTools = ["read", "bash", "edit", "write", ...customTools.map((t) => t.name)];
    // Omit `tools` allowlist so pi keeps extension/custom tools enabled (SDK docs:
    // when tools is provided it becomes a lifetime allowlist and strips extension
    // tools like web_search/fetch_content). MCP is gated by whether its adapter
    // is in additionalExtensionPaths, not by a create-time name list.
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
    const handle = new PiSdkAgentHandle(
      session,
      modelRegistry,
      resourceLoader,
      extensionPaths,
      baseTools,
      runtimeParams,
      customTools.map((t) => t.name),
      { roomId: opts.roomId, agentName: opts.member.name, roomMembers: opts.roomMembers },
    );
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
      mcpServers: mcpSettings.serverNames,
    });
    return handle;
  }

  async shutdownAll(): Promise<void> {
    for (const handle of this.handles) handle.destroy();
    this.handles.clear();
  }
}
