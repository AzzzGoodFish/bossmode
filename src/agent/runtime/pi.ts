import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  VERSION as PI_SDK_VERSION,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { dispatchSdkExecution, type SdkExecutionAttempt } from "../scheduler.js";
import { logger } from "../../kernel/logger.js";
type PiTransportSetting="auto"|"websocket"|"websocket-cached"|"sse";
import { getModelCredentialProfile } from "../../config/models.js";
import { createDatabaseModelRuntime, refreshDatabaseModelRuntime, exportPiConfigForMember, resolvePiAgentDir } from "../../config/pi-adapt/credentials.js";
import { normalizeModelRef } from "../../config/models.js";
import { loadMcpFactory } from "./resources.js";
import { BossmodeResourceLoader, resolvePiSystemPromptSources, assertHostedMcpLoaded, bindMcpExtension, materializeMcpRuntimeSettings, type McpRuntimeSettings } from "./resources.js";
import { ModelCredentialBinding } from "../../config/pi-adapt/credentials.js";
import { createBossmodeSdkTools } from "./tools.js";
import { mapContextUsage, mapPiAgentEvent } from "./events.js";
import { shutdownSdkSession } from "./compaction.js";
import type { AgentRuntime, AgentHandle, AgentStreamEvent, CreateAgentOpts, ContextUsage, MemberActiveToolInfo, RuntimePromptOptions } from "../types.js";
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);
function classifyToolSource(name:string,bossmodeTools:ReadonlySet<string>,source?:{path?:string;source?:string;baseDir?:string}):string{
  if(BUILTIN_TOOL_NAMES.has(name))return "builtin";if(bossmodeTools.has(name))return "bossmode";
  const path=source?.path??source?.source??source?.baseDir??name;if(name==="mcp"||/mcp/i.test(path))return "mcp";
  return `extension:${path.split(/[/\\]/).filter(Boolean).pop()?.replace(/@.*$/,"")??name}`;
}

function splitModelRef(modelRef: string): { provider: string; modelId: string } {
  const normalized = normalizeModelRef(modelRef);
  const idx = normalized.indexOf("/");
  return idx > 0 ? { provider: normalized.slice(0, idx), modelId: normalized.slice(idx + 1) } : { provider: "anthropic", modelId: normalized };
}

function applyRuntimeTransportSettings(settingsManager:SettingsManager){
  settingsManager.applyOverrides({transport:"auto",websocketConnectTimeoutMs:15_000} as any);
  return {transport:settingsManager.getTransport() as PiTransportSetting,websocketConnectTimeoutMs:settingsManager.getWebSocketConnectTimeoutMs()??15_000,httpIdleTimeoutMs:settingsManager.getHttpIdleTimeoutMs()};
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

export class PiSdkAgentHandle implements AgentHandle {
  private modelRef:string;private credentialId:string;
  private listeners = new Set<(event: AgentStreamEvent) => void>();
  private mcpConfig?:McpRuntimeSettings;
  private unsubscribeSession: (() => void) | undefined;
  private promptAttempt: SdkExecutionAttempt | null = null;
  /** Outlives SDK preflight, where Agent.abort() has no active controller yet. */
  private promptAbortIntent: { aborted: boolean } | null = null;
  private compactAttempts = new Set<SdkExecutionAttempt>();
  private manualCompactionOutcome: { aborted: boolean } | null = null;
  private destroyed = false;
  private destroyPromise: Promise<void> | null = null;
  /** Called once only after every SDK teardown surface succeeded. */
  private onTeardownSuccess: (() => void) | undefined;
  private sessionReferencePublished = false;
  /** Live set of bossmode custom tool names (from createBossmodeSdkTools) — sole source for "bossmode" classification. */
  private bossmodeToolNames: Set<string>;
  private executionOwner: { memberId: string; resolveSourceRef: () => string | null };

  constructor(
    private session: AgentSession,
    private modelRegistry: ModelRegistry,
    private credentials: ModelCredentialBinding,
    private resourceLoader: BossmodeResourceLoader,
    modelRef:string,credentialId:string,
    bossmodeToolNames: Iterable<string>,
    executionOwner: { memberId: string; resolveSourceRef: () => string | null },
    onTeardownSuccess?: () => void,
    private onSessionMaterialized?: (session: { sessionId?: string; sessionFile?: string }) => void,
    initialMcpConfig?: McpRuntimeSettings,
  ) {
    this.mcpConfig=initialMcpConfig;
    this.modelRef=modelRef;this.credentialId=credentialId;
    this.onTeardownSuccess = onTeardownSuccess;
    this.bossmodeToolNames = new Set(bossmodeToolNames);
    this.executionOwner = executionOwner;
    this.unsubscribeSession = session.subscribe((raw) => {
      this.observeExecutionEvidence(raw);
      this.publishSessionReferenceIfMaterialized();
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

  private dispatchExecution(operation: "input" | "external", reference: string, beforeDispatch?: (attemptId: string) => void): SdkExecutionAttempt {
    return dispatchSdkExecution(this.executionOwner.memberId, this.executionOwner.resolveSourceRef(), operation, reference, beforeDispatch);
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
    const attempt = this.dispatchExecution("external", "pi-sdk:session.compact");
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
  private async promptInternal(message:string,options?:RuntimePromptOptions):Promise<void>{
    this.promptAbortIntent={aborted:false};
    try{
      if(options?.beforeDispatch?.constructor.name==="AsyncFunction")throw new Error("SDK beforeDispatch hook must be synchronous; promises are not allowed");
      const attempt=this.dispatchExecution("input","pi-sdk:session.prompt",options?.beforeDispatch?attemptId=>options.beforeDispatch!({attemptId,dispatchIndex:0,message}):undefined);
      this.promptAttempt=attempt;if(this.promptAbortIntent.aborted||this.destroyed)attempt.interrupt("Runtime abort requested before SDK preflight");
      await attempt.run(()=>this.session.prompt(message,{source:"external" as any})).catch(error=>{this.emit({type:"message_end",text:"",stopReason:"error",errorMessage:error.message||String(error)});throw error;});
    }finally{this.promptAttempt=null;this.promptAbortIntent=null;this.publishSessionReferenceIfMaterialized();}
  }

  abort(options?: { preserveCompaction?: boolean }): void {
    if (this.promptAbortIntent) this.promptAbortIntent.aborted = true;
    this.interruptAttempts("Runtime abort requested", !options?.preserveCompaction);
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
    try{this.mcpConfig?.dispose();}catch(error){errors.push(`MCP config cleanup: ${String(error)}`);}this.mcpConfig=undefined;
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
  }

  refreshModelRegistry(_opts?: { allowNetwork?: boolean }): Promise<void> {
    return this.trackResourceOperation(()=>this.refreshModelRegistryInternal());
  }
  private async refreshModelRegistryInternal(): Promise<void> {
    // Catalog network refresh belongs to the application service; the SDK consumes SQL snapshots.
    const profileId = this.credentialId;
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
    this.modelRef = normalizeModelRef(modelRef);
    this.credentialId = profile.id;
  }

  setThinkingLevel(level: string): void {
    if (this.destroyed) throw new Error("Runtime instance is destroyed");
    try {
      this.session.setThinkingLevel(level as any);
    }
    catch (err) { logger.warn("runtime:pi-sdk", "setThinkingLevel failed", { level, error: String(err) }); }
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    try {
      const raw=await this.session.getContextUsage();
      return mapContextUsage(raw, this.modelRef);
    } catch (err) {
      logger.warn("runtime:pi-sdk", "getContextUsage failed", { error: String(err) });
      return null;
    }
  }

  isDestroyed(): boolean { return this.destroyed; }

  async readSystemPrompt(): Promise<string | null> {
    // Yield before the read so teardown requested in the same turn wins. The
    // public SDK getter is the sole prompt authority; never rebuild its text.
    await Promise.resolve();
    if (this.destroyed) return null;
    const text = this.session.systemPrompt;
    return this.destroyed ? null : text;
  }

  getActiveTools(): MemberActiveToolInfo[] {
    if (this.destroyed) return [];
    try {
      const session = this.session as any;
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
        const def=session.getToolDefinition(t.name);
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
    if (this.promptOperation || this.manualCompactionOutcome || this.session.isStreaming || this.session.isCompacting) {
      throw new Error("Prompt refresh requires an idle pre-prompt boundary");
    }
    const sources = resolvePiSystemPromptSources(opts);
    this.resourceLoader.setPromptSources(sources);
    // Supported SDK API rebuilds its base prompt from the resource loader.
    // Retain the exact active tools, session history, resources, and credentials.
    this.session.setActiveToolsByName(this.session.getActiveToolNames());
  }

  private resourceOperations = new Set<Promise<unknown>>();
  private trackResourceOperation<T>(operation:()=>Promise<T>):Promise<T>{
    if(this.destroyed)return Promise.reject(new Error("Runtime instance is destroyed"));
    let pending:Promise<T>;try{pending=operation();}catch(error){pending=Promise.reject(error);}
    this.resourceOperations.add(pending);return pending.finally(()=>this.resourceOperations.delete(pending));
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
  private handles = new Map<PiSdkAgentHandle, string>();
  private creationCleanupFailures = new Map<string, Error[]>();
  /** Shared shutdown settlement: concurrent shutdownAll calls await the same teardown. */
  private shutdownSettlement: Promise<void> | null = null;

  async createAgent(opts: CreateAgentOpts): Promise<AgentHandle> {
    // Session creation happens before a chat batch owns the instance. Durable
    // input attempts are recorded when the scheduler dispatches the first batch.
    return this.createAgentInternal(opts);
  }

  private async createAgentInternal(opts: CreateAgentOpts): Promise<PiSdkAgentHandle> {
    if (!opts.member.model || !opts.member.credentialId) {
      throw new Error(`Member "${opts.member.name}" hasn't selected a model yet. Open the member card to choose a model and credential.`);
    }
    const modelRef = opts.member.model;
    const piConfig = exportPiConfigForMember({
      memberId: opts.member.id,
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

    const runtimeAgentDir=piConfig.agentDir||resolvePiAgentDir(opts.member.id);
    const sessionDir = opts.sessionDir ?? join(runtimeAgentDir, "sessions");
    mkdirSync(runtimeAgentDir, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

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
    if (!authCheck.apiKey && piConfig.profile.authType !== "ambient") throw new Error(`Credential projection failed for ${resolvedModel}: no API key available for provider ${provider}`);

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

    const promptSources=resolvePiSystemPromptSources(opts);
    const skillPaths = opts.resources.skillPaths.filter((path) => existsSync(path));
    const mcpSettings = materializeMcpRuntimeSettings(opts.resources.mcp);
    let sessionObtained: AgentSession | null = null;
    try {
      // Managed extensions = member dir (unconditional) + platform packages on
      // the member's enable list (§1.3: list serves the two platform packs only).
      // Batch 7 closeout (fish 2026-09-04): the platform extension store is gone —
      // member-owned extensions/ dir entries are the only managed extensions.
      const activeExtensionPaths=[...opts.resources.extensionPaths,...(piConfig.extensionPaths??[])];
      const mcpFactory = await loadMcpFactory(mcpSettings.adapterPath!);
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
        appendSystemPrompt:promptSources.appendSystemPrompt,
      }, promptSources);
      await resourceLoader.reload();
      assertHostedMcpLoaded(resourceLoader);
      // DefaultResourceLoader.reload() reloads SettingsManager and clears its
      // in-memory overrides. Apply runtime transport afterwards, immediately
      // before the SDK session is created.
      const transportSettings = applyRuntimeTransportSettings(settingsManager);

      const customTools = createBossmodeSdkTools({
        memberId: opts.member.id,
        resolveSourceRef: opts.resolveSourceRef,
      });
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


      let handle: PiSdkAgentHandle;
      handle = new PiSdkAgentHandle(
        session,
        modelRegistry,
        authStorageCredentials,
        resourceLoader,
        resolvedModel,piConfig.profile.id,
        customTools.map((t) => t.name),
        { memberId: opts.member.id, resolveSourceRef: opts.resolveSourceRef },
        () => this.handles.delete(handle),
        opts.onSessionChanged,
        mcpSettings,
      );
      this.handles.set(handle, opts.member.id);
      logger.info("runtime:pi-sdk", "createAgent", {
        agent: opts.member.name,
        model: resolvedModel,
        thinking: session.thinkingLevel || opts.member.thinkingLevel || "off",
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
