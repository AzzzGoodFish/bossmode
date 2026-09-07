// Pi SDK Runtime — in-process pi Agent SDK integration behind the legacy pi-cli storage key
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
import { ensureBossmodeMcpDirs, getBossmodeMcpRuntimeDir, writeMemberScopedMcpConfig } from "../../shared/mcp-settings.js";
import { memberExtensionsDir, memberSkillsDir } from "../../workspace/member-profile.js";
import type { AgentMemberConfig, PiTransportSetting } from "../../shared/types.js";
import { exportPiConfigForMember, normalizeModelRef, getModelCredentialProfile, resolvePiAgentDir } from "../model-credentials.js";
import { resolveOwningRoomId } from "../../workspace/topic-store.js";
import { ModelCredentialBinding } from "./model-credential-binding.js";
import { createBossmodeSdkTools } from "./bossmode-sdk-tools.js";
import { mapContextUsage, mapPiAgentEvent } from "./pi-events.js";
import type { AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts, RuntimeCapabilities, RuntimeDetectResult, ContextUsage, AgentRuntimeParams, ReloadAgentResourcesOpts, MemberActiveToolInfo } from "./types.js";

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


/**
 * Member extensions dir → loadable file entries (qa rc.14 finding ①).
 * pi's loader treats additionalExtensionPaths as module files; handing it the
 * directory itself fails with "Cannot find module". pi has an internal
 * discoverExtensionsInDir() for exactly this (private, not exported), so we
 * mirror its documented discovery rules:
 *   1. direct `extensions/*.ts` / `*.js` files
 *   2. subdirectory with `index.ts` / `index.js`
 *   3. subdirectory with `package.json` carrying a `pi.extensions` manifest
 * No recursion beyond one level.
 */
function resolveExtensionEntries(dir: string): string[] | null {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const declared = pkg?.pi?.extensions;
      if (Array.isArray(declared) && declared.length > 0) {
        const entries = declared
          .map((rel: string) => join(dir, String(rel)))
          .filter((p: string) => existsSync(p));
        if (entries.length > 0) return entries;
      }
    } catch { /* unreadable manifest → fall through */ }
  }
  for (const index of ["index.ts", "index.js"]) {
    const p = join(dir, index);
    if (existsSync(p)) return [p];
  }
  return null;
}

export function discoverMemberExtensionEntries(extDir: string): string[] {
  if (!existsSync(extDir)) return [];
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(extDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(extDir, entry.name);
    if ((entry.isFile() || entry.isSymbolicLink()) && /\.(ts|js)$/.test(entry.name)) {
      out.push(entryPath);
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const resolved = resolveExtensionEntries(entryPath);
      if (resolved) out.push(...resolved);
    }
  }
  return out;
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

function resolveVendorMcpAdapterPath(): string {
  return fileURLToPath(new URL("../../../vendor/pi-mcp-adapter/index.ts", import.meta.url));
}

function resolveMcpRuntimeSettings(args: { roomId: string; member: AgentMemberConfig }): McpRuntimeSettings {
  // Batch 6 §1.2+§1.4: members/<id>/mcp.json is the sole source (file present
  // = enabled); the adapter is platform infrastructure, always bound — an
  // empty config is harmless.
  const runtimeDir = getBossmodeMcpRuntimeDir();
  const adapterPath = resolveVendorMcpAdapterPath();
  if (!existsSync(adapterPath)) {
    throw new Error(`MCP adapter not found at ${adapterPath}. Run git submodule update --init --recursive.`);
  }
  ensureBossmodeMcpDirs();
  const mcpRoomId = args.roomId.startsWith("topic:") ? resolveOwningRoomId(args.roomId) : args.roomId;
  const scoped = writeMemberScopedMcpConfig({ roomId: mcpRoomId, memberId: args.member.id });
  if (scoped.serverNames.length > 0) {
    process.env.MCP_DIRECT_TOOLS = "__none__";
    process.env.BOSSMODE_MCP_CONFIG_STRICT = "1";
    process.env.PI_CODING_AGENT_DIR = runtimeDir;
    process.env.MCP_OAUTH_DIR = join(runtimeDir, "oauth");
  }
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

export class PiSdkAgentHandle implements AgentHandle {
  readonly runtimeName = "pi-cli";
  readonly runtimeParams: AgentRuntimeParams;
  /** SDK session id (background runner records it; live path reports via onSessionChanged). */
  readonly sessionId: string | undefined;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private unsubscribeSession: (() => void) | undefined;
  private currentRun: Promise<void> | null = null;
  private compactionWatchdogRun: CompactionWatchdogRun | null = null;
  private watchdogTurn: WatchdogTurnState | null = null;
  private manualCompactionOutcome: { aborted: boolean } | null = null;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  /** Called once only after every SDK teardown surface succeeded. */
  private onTeardownSuccess: (() => void) | undefined;
  /** Live set of bossmode custom tool names (from createBossmodeSdkTools) — sole source for "bossmode" classification. */
  private bossmodeToolNames: Set<string>;
  private toolAssembly: { roomId: string; agentName: string; roomMembers: string[]; memberId?: string };

  constructor(
    private session: AgentSession,
    private modelRegistry: ModelRegistry,
    private credentials: ModelCredentialBinding,
    private resourceLoader: DefaultResourceLoader,
    private settingsManager: SettingsManager,
    private baseExtensionPaths: string[],
    private baseToolNames: string[],
    runtimeParams: AgentRuntimeParams,
    bossmodeToolNames: Iterable<string>,
    toolAssembly: { roomId: string; agentName: string; roomMembers: string[]; memberId?: string },
    onTeardownSuccess?: () => void,
  ) {
    this.runtimeParams = runtimeParams;
    this.sessionId = session.sessionId;
    this.onTeardownSuccess = onTeardownSuccess;
    this.bossmodeToolNames = new Set(bossmodeToolNames);
    this.toolAssembly = toolAssembly;
    this.unsubscribeSession = session.subscribe((raw) => {
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

  abort(options?: { preserveCompaction?: boolean }): void {
    // The SDK owns aborted messages and tool results. Never patch session history.
    this.session.abort().catch(() => {});
    if (options?.preserveCompaction) return;
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
      this.destroyPromise = this.runTeardown();
    }
    return this.destroyPromise;
  }

  private async runTeardown(): Promise<void> {
    const errors: string[] = [];
    // The SDK's AgentSession.abort() awaits waitForIdle itself — awaiting ITS
    // promise here is the awaitable run-end, unlike the void handle.abort().
    try {
      await this.session.abort();
    } catch (err: any) {
      errors.push(`abort: ${err?.message || String(err)}`);
    }
    try {
      if (this.manualCompactionOutcome) this.manualCompactionOutcome.aborted = true;
      this.session.abortCompaction();
      this.session.abortBranchSummary();
    } catch {}
    const runner: any = this.session.extensionRunner;
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
    try { this.unsubscribeSession?.(); } catch {}
    // Always runs, even when earlier stages failed. dispose() is synchronous
    // and throws AggregateError when a registered resource cleanup fails.
    try {
      this.session.dispose();
    } catch (err: any) {
      const detail = err instanceof AggregateError && Array.isArray(err.errors)
        ? err.errors.map((e: any) => e?.message || String(e)).join(", ")
        : err?.message || String(err);
      errors.push(`dispose: ${detail}`);
    }
    this.listeners.clear();
    if (errors.length > 0) {
      throw new Error(`teardown incomplete (${errors.length}): ${errors.join("; ")}`);
    }
    // A completed background task must not retain its full PiSdkAgentHandle
    // (and session) until service shutdown. Failed teardown stays registered so
    // shutdownAll can surface it rather than pretending cleanup succeeded.
    this.onTeardownSuccess?.();
  }

  async waitForIdle(): Promise<void> {
    if (this.currentRun) await this.currentRun.catch(() => {});
  }

  forkSnapshot(): { sessionFile: string; branchEntries: unknown[] } | null {
    try {
      const sm = (this.session as any).sessionManager;
      const sessionFile: string | undefined = this.session.sessionFile ?? sm?.getSessionFile?.();
      if (!sessionFile) return null;
      const branchEntries: unknown[] = typeof sm?.getBranch === "function" ? sm.getBranch() : [];
      return { sessionFile, branchEntries };
    } catch {
      return null;
    }
  }

  async refreshModelRegistry(opts?: { allowNetwork?: boolean }): Promise<void> {
    await this.session.modelRuntime.refresh({ allowNetwork: opts?.allowNetwork ?? false });
  }

  async setModel(modelRef: string, credentialId: string): Promise<void> {
    const { provider, modelId } = splitModelRef(modelRef);
    const profile = getModelCredentialProfile(credentialId);
    if (!profile || !profile.enabled || profile.providerSlug !== provider) {
      throw new Error(`Invalid credential binding for ${modelRef}`);
    }
    await this.credentials.runProfile(profile, () => this.session.modelRuntime.refresh({ allowNetwork: false }));
    const found = this.modelRegistry.find(provider, modelId);
    if (!found) throw new Error(`Model not found: ${modelRef}`);
    const model = this.credentials.bind(found, profile);
    await this.credentials.run(model, () => this.session.setModel(model));
    this.runtimeParams.model = resolveModelLabel(modelRef);
    this.runtimeParams.credentialId = profile.id;
    this.runtimeParams.credentialName = profile.name;
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
    // Batch 6 §1: member dir assets re-resolved on every reload.
    const memberAssets = memberDirLoaderAssetPaths(opts.member.id);
    // Batch 7 closeout (fish 2026-09-04): the platform extension store is gone —
    // member-owned extensions/ dir entries are the only managed extensions.
    const managedExtensions = [...memberAssets.extensions];
    const activeExtensionPaths = [
      ...managedExtensions,
      ...this.baseExtensionPaths.filter((p) => !managedExtensions.includes(p)),
      mcpSettings.adapterPath!,
    ];
    const loader = this.resourceLoader as any;
    const appendBase = (opts.appendSystemPrompt || []).filter((v) => v && v.trim().length > 0);
    const promptSources = resolvePiSystemPromptSources({
      agentPrompt: opts.agentPrompt,
      appendSystemPrompt: appendBase,
    });
    loader.systemPromptSource = promptSources.systemPrompt;
    loader.appendSystemPromptSource = promptSources.appendSystemPrompt;
    loader.additionalSkillPaths = [...opts.skillPaths.filter((p) => existsSync(p)), ...memberAssets.skills];
    loader.additionalExtensionPaths = activeExtensionPaths;

    if (typeof (this.session as any).reload === "function") await (this.session as any).reload();
    else await this.resourceLoader.reload();
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
    await bindMcpExtension(this.session, { configPath: mcpSettings.configPath, agent: opts.member.name });
    // Refresh bossmode tool name set from the same factory that builds customTools (leader gate, new tools).
    this.toolAssembly = {
      roomId: opts.roomId,
      agentName: opts.member.name,
      roomMembers: this.toolAssembly.roomMembers,
      memberId: this.toolAssembly.memberId ?? opts.member.id,
    };
    const customTools = createBossmodeSdkTools({
      roomId: opts.roomId,
      agentName: opts.member.name,
      roomMembers: this.toolAssembly.roomMembers,
      scopeKind: opts.roomId.startsWith("dm:") ? "dm" : "room",
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
    this.runtimeParams.extensions = ["bossmode-sdk-tools", ...activeExtensionPaths];
    logger.info("runtime:pi-sdk", "reloaded resources", { agent: opts.member.name, skills: opts.skillPaths.length, mcpEnabled: mcpSettings.enabled, mcpServers: mcpSettings.serverNames });
  }

  async compact(): Promise<{ aborted: boolean }> {
    const outcome = { aborted: false };
    this.manualCompactionOutcome = outcome;
    this.emit({ type: "agent_start" });
    try {
      // The supported SDK emits compaction_start/end itself, then rejects on
      // cancellation or failure. Never manufacture replacement events.
      await this.session.compact();
    } catch (err) {
      if (!outcome.aborted) throw err;
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

  private handles = new Set<PiSdkAgentHandle>();
  /** Shared shutdown settlement: concurrent shutdownAll calls await the same teardown. */
  private shutdownSettlement: Promise<void> | null = null;

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

    const defaultAgentDir = resolvePiAgentDir(opts.roomId, opts.member.id);
    const runtimeAgentDir = piConfig?.agentDir || defaultAgentDir;
    const sessionDir = opts.background?.sessionDir ?? join(runtimeAgentDir, "sessions");
    mkdirSync(runtimeAgentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    if (!piConfig.profile) throw new Error(`No model credentials configured for ${resolvedModel}. Go to Settings → Model Credentials to add or import credentials.`);
    const authStorageCredentials = new ModelCredentialBinding(piConfig.profile);
    const runtime = await ModelRuntime.create({ credentials: authStorageCredentials, modelsPath: join(runtimeAgentDir, "models.json"), allowModelNetwork: false });
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
    if (opts.background?.sessionManager) {
      // Fork mode: the runner already forked the parent prefix, applied the
      // cut, and hands the manager over. Never re-open the file — the branch
      // move only persists on the next append.
      sessionManager = opts.background.sessionManager;
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
    // Managed extensions = member dir (unconditional) + platform packages on
    // the member's enable list (§1.3: list serves the two platform packs only).
    // Batch 7 closeout (fish 2026-09-04): the platform extension store is gone —
    // member-owned extensions/ dir entries are the only managed extensions.
    const managedExtensions = [...memberAssets.extensions];
    const extensionPaths = [...managedExtensions, ...(piConfig?.extensionPaths ?? [])];
    const activeExtensionPaths = [...extensionPaths, mcpSettings.adapterPath!];
    const resourceLoader = new DefaultResourceLoader({
      cwd: opts.cwd,
      agentDir: runtimeAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      additionalSkillPaths: skillPaths,
      additionalExtensionPaths: activeExtensionPaths,
      systemPrompt: promptSources.systemPrompt,
      appendSystemPrompt,
    });
    await resourceLoader.reload();
    // DefaultResourceLoader.reload() reloads SettingsManager and clears its
    // in-memory overrides. Apply runtime transport afterwards, immediately
    // before the SDK session is created.
    const transportSettings = applyRuntimeTransportSettings(settingsManager);

    const customTools = createBossmodeSdkTools({
      roomId: opts.roomId,
      agentName: opts.member.name,
      roomMembers: opts.roomMembers,
      scopeKind: opts.roomId.startsWith("dm:") ? "dm" : "room",
      execution: opts.background ? "background" : "live",
    });
    const baseTools = ["read", "edit", "write", ...customTools.map((t) => t.name)];
    // Omit `tools` allowlist so pi keeps extension/custom tools enabled (SDK docs:
    // when tools is provided it becomes a lifetime allowlist and strips extension
    // tools like web_search/fetch_content). MCP is gated by whether its adapter
    // is in additionalExtensionPaths, not by a create-time name list.
    // Once the SDK session exists, any later failure (MCP bind or setModel)
    // must not leak it — dispose before rethrowing.
    let sessionObtained: AgentSession | null = null;
    try {
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

      if (!opts.background) {
        opts.onSessionChanged?.({ sessionId: session.sessionId, sessionFile: session.sessionFile });
      }

      const runtimeParams: AgentRuntimeParams = {
        model: resolvedModel,
        thinkingLevel: session.thinkingLevel || opts.member.thinkingLevel || "off",
        // Panel metadata: bossmode-composed segments only (never pi built-in text).
        systemPrompt: [rolePrompt, ...appendBase].filter(Boolean).join("\n\n"),
        skills: opts.skillNames ?? skillPaths,
        extensions: ["bossmode-sdk-tools", ...activeExtensionPaths],
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
    } catch (err) {
      if (sessionObtained) {
        try { sessionObtained.dispose(); } catch (disposeErr: any) {
          logger.error("runtime:pi-sdk", "post-failure session dispose also failed", {
            agent: opts.member.name,
            error: disposeErr?.message || String(disposeErr),
          });
        }
      }
      throw err;
    }
  }

  async shutdownAll(): Promise<void> {
    // Concurrent callers share ONE settlement — a call landing mid-shutdown
    // awaits the same teardown instead of racing on an empty/cleared set.
    if (this.shutdownSettlement) return this.shutdownSettlement;
    const failures: unknown[] = [];
    const settlements: Promise<void>[] = [];
    for (const handle of this.handles) {
      settlements.push((handle as PiSdkAgentHandle).destroyAndWait().catch((err: unknown) => { failures.push(err); }));
    }
    this.handles.clear();
    this.shutdownSettlement = (async () => {
      await Promise.all(settlements);
      if (failures.length > 0) {
        throw new AggregateError(failures, `shutdownAll: ${failures.length} session teardown(s) incomplete`);
      }
    })().finally(() => {
      // Sharing only matters while a shutdown is in flight; once settled, a
      // later call starts fresh (the handle set is already cleared).
      this.shutdownSettlement = null;
    });
    return this.shutdownSettlement;
  }
}
