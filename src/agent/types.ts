// ============================================================================
// Agent runtime contracts — inputs, member snapshot config, handle, events,
// tool info. Owned by the agent capability; no chat-kind branches here.
// ============================================================================

import { logger } from "../kernel/logger.js";
import type { AgentMemberConfig } from "../kernel/types.js";

// The member config type consumed by runtimes (name kept for existing callers).
export type { AgentMemberConfig };

/** Build material for a member session, assembled outside the agent core.
 *  The app layer reads member state; agent code consumes only this snapshot. */
export interface AgentPromptSnapshot {
  agentPrompt: string;
  appendSystemPrompt: string[];
  contractFingerprint: string;
}

export interface AgentResourceSnapshot {
  skillNames: string[];
  skillPaths: string[];
  extensionPaths: string[];
  mcp: {
    adapterPath: string;
    runtimeDir: string;
    config: Record<string, unknown>;
    serverNames: string[];
  };
}

/** Immutable build material captured by app before the agent core assembles a
 * session. Chat source and roster are deliberately absent: one member runtime
 * serves every conversation. */
export interface AgentMemberSnapshot {
  config: AgentMemberConfig;
  prompt: AgentPromptSnapshot;
  resources: AgentResourceSnapshot;
  workspaceRoot: string;
  resumeSession?: CreateAgentOpts["resumeSession"];
}

// -- Runtime interface --

export interface AgentRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;

  detect(): Promise<RuntimeDetectResult>;
  createAgent(opts: CreateAgentOpts): Promise<AgentHandle>;
  /** Await every owned handle, including detached instances and failed teardown attempts. */
  shutdownMember(memberId: string): Promise<void>;
  shutdownAll(): Promise<void>;
}

export interface RuntimeDetectResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface RuntimeCapabilities {
  streaming: boolean;
  toolEvents: boolean;
  thinking: boolean;
  usage: boolean;
  dynamicModel: boolean;
  dynamicThinking: boolean;
  permissionControl: boolean;
  sessionResume: boolean;
  contextUsage: boolean;  // supports get_context_usage control_request
}

// -- Agent creation --

export interface CreateAgentOpts {
  cwd: string;
  member: AgentMemberConfig;
  /** Opaque source currently being executed. It is set by the scheduler for
   * each durable batch and must never be interpreted by the runtime adapter. */
  resolveSourceRef: () => string | null;
  resources: AgentResourceSnapshot;

  // Layered prompt content
  agentPrompt: string;       // Source agent role prompt only. Empty for builtin/general.
  appendSystemPrompt: string[];
  skillPaths: string[];      // Skill directory paths
  skillNames?: string[];     // Resolved skill names for status display
  // Session resume
  resumeSession?: { sessionId?: string; sessionFile?: string };
  /** Member-owned directory for a newly created main session. Ignored on resume. */
  sessionDir?: string;
  // Called whenever runtime reports session identity (initial + later changes after compact/fork)
  onSessionChanged?: (session: { sessionId?: string; sessionFile?: string }) => void;
}

export interface AgentRuntimeParams {
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  skills?: string[];
  extensions?: string[];
  credentialId?: string;
  credentialName?: string;
}

export interface RuntimePromptDispatch {
  attemptId: string;
  dispatchIndex: number;
  message: string;
}

export interface RuntimePromptOptions {
  /** Runs synchronously in the SDK dispatch transaction, before external IO, for every iteration. */
  beforeDispatch?: (event: RuntimePromptDispatch) => void;
}

export interface AgentHandle {
  prompt(message: string, options?: RuntimePromptOptions): Promise<void>;
  /** Manual compaction (conversation action). Emits the full event bridge
   * (agent_start / compaction_start / compaction_end / agent_end) and reports
   * whether the operation was aborted (e.g. by an explicit Stop). */
  compact(): Promise<{ aborted: boolean }>;
  /** Abort the run. Message delivery preserves compaction; explicit Stop cancels it. */
  abort(options?: { preserveCompaction?: boolean }): void;
  destroy(): void;
  /** Awaitable teardown: waits for the extension session_shutdown emission
   *  AND runs the SDK's synchronous dispose (resource cleanups) to completion —
   *  a confirmed end of cleanup, not just an issued request. Throws when
   *  shutdown or dispose fails. */
  destroyAndWait?(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;

  // Metadata for status reporting
  readonly runtimeName?: string;
  readonly runtimeParams?: AgentRuntimeParams;

  // Optional — check runtime.capabilities before calling
  setModel?(model: string, credentialId: string): void | Promise<void>;
  refreshModelRegistry?(opts?: { allowNetwork?: boolean }): void | Promise<void>;
  setThinkingLevel?(level: string): void;
  getContextUsage?(): Promise<ContextUsage | null>;
  /** Refresh only prompt metadata at the next safe pre-prompt boundary. */
  refreshPrompt?(opts: { agentPrompt: string; appendSystemPrompt: string[] }): void;
  /** Active tools currently exposed to the model (session-live). */
  getActiveTools?(): MemberActiveToolInfo[];
}

export interface MemberActiveToolInfo {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  /** builtin | bossmode | mcp | extension:<id> */
  source: string;
}

// -- Unified event model --

export type AgentStreamEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry?: boolean }
  | { type: "message_start" }
  | { type: "message_update"; text?: string; thinking?: string }
  | { type: "message_end"; text: string; usage?: TokenUsage; stopReason?: string; errorMessage?: string; model?: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_update"; toolName: string; toolCallId: string; partialResult: unknown }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "compaction_start"; reason?: "manual" | "threshold" | "overflow" | string }
  | { type: "compaction_end"; reason?: "manual" | "threshold" | "overflow" | string; aborted: boolean; willRetry: boolean; errorMessage?: string; tokensBefore?: number; result?: unknown }
  | { type: "cli:stdout"; text: string }
  | { type: "cli:stderr"; text: string }
  // Emitted when a runtime ends unexpectedly or during normal shutdown.
  // `unexpected` is true for crashes / startup failures / parse errors.
  | { type: "runtime_exit"; code: number | null; signal: string | null; stderrTail?: string; unexpected: boolean };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface ContextUsage {
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  compacted?: boolean;
}

// -- Runtimes config --

export interface RuntimesConfig {
  runtimes: Record<string, { enabled: boolean; cliPath?: string }>;
}

// Runtime registry — runtime adapters register from composition (app/wire);
// the agent core only consumes the registry through assembly.
export class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>();

  async init(config: RuntimesConfig): Promise<void> {
    for (const [name, conf] of Object.entries(config.runtimes)) {
      if (!conf.enabled) continue;

      // Runtimes are registered externally via register()
      const runtime = this.runtimes.get(name);
      if (runtime) {
        const result = await runtime.detect();
        if (result.available) {
          logger.info("runtime", `${name}: detected`, { version: result.version, path: result.path });
        } else {
          logger.warn("runtime", `${name}: not available`, { error: result.error });
          this.runtimes.delete(name);
        }
      }
    }
  }

  register(runtime: AgentRuntime): void {
    this.runtimes.set(runtime.name, runtime);
  }

  get(name: string): AgentRuntime | undefined {
    return this.runtimes.get(name);
  }

  getAll(): AgentRuntime[] {
    return Array.from(this.runtimes.values());
  }

  getCapabilities(): Record<string, { capabilities: AgentRuntime["capabilities"]; name: string }> {
    const result: Record<string, { capabilities: AgentRuntime["capabilities"]; name: string }> = {};
    for (const [name, rt] of this.runtimes) {
      result[name] = { name: rt.name, capabilities: rt.capabilities };
    }
    return result;
  }
}
