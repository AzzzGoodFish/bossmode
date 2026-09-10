// ============================================================================
// Agent Runtime Abstraction Layer V2
// ============================================================================

import type { AgentMemberConfig } from "../../shared/types.js";

// Re-export AgentMemberConfig as the member config type for runtimes
export type { AgentMemberConfig };

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
  roomId: string;              // bossmode room ID (for tool callbacks)
  member: AgentMemberConfig;

  // Layered prompt content
  agentPrompt: string;       // Source agent role prompt only. Empty for builtin/general.
  envPrompt?: string;        // Legacy compatibility: Bossmode overlay. Prefer appendSystemPrompt.
  appendSystemPrompt?: string[]; // Bossmode core + prompt assets (principles/mainline).
  skillPaths: string[];      // Skill directory paths
  skillNames?: string[];     // Resolved skill names for status display
  rulesPrompt?: string;      // Legacy compatibility; ignored by new prompt compiler.

  roomMembers: string[];
  callbacks: AgentCallbacks;

  // Session resume
  resumeSession?: { sessionId?: string; sessionFile?: string };
  /** Member-owned directory for a newly created main session. Ignored on resume. */
  sessionDir?: string;
  /** A just-forked main-session manager. It must not be re-opened before first append. */
  sessionManager?: unknown;
  // SDK session id when the runtime exposes one (background runner records it;
  // live sessions report identity through onSessionChanged instead).
  readonly sessionId?: string;
  // Called whenever runtime reports session identity (initial + later changes after compact/fork)
  onSessionChanged?: (session: { sessionId?: string; sessionFile?: string }) => void;

  /** Background task child session variant. Same assembly path and prompt
   *  sources as a live member session; differences: the session writes into the
   *  task directory, scope-posting/background-start tools are rejected at
   *  execution time, and member session state is not overwritten. */
  background?: {
    sessionDir: string;
    /** Pre-built child session manager (fork mode): the runner forks the parent
     *  prefix, applies the cut in memory, and hands the manager over so the
     *  child continues from the cut leaf — the branch move only persists on
     *  the next append, so re-opening the file would lose it. */
    sessionManager?: import("@earendil-works/pi-coding-agent").SessionManager;
  };
}

export interface AgentCallbacks {
  onChat: (message: string) => Promise<void>;
  onMention: (target: string, message: string) => Promise<void>;
}

// -- Agent handle --

export interface ReloadAgentResourcesOpts {
  roomId: string;
  member: AgentMemberConfig;
  agentPrompt: string;
  appendSystemPrompt?: string[];
  skillPaths: string[];
  skillNames?: string[];
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

export interface AgentHandle {
  prompt(message: string): Promise<void>;
  /** Manual compaction (conversation action). Emits the full event bridge
   * (agent_start / compaction_start / compaction_end / agent_end) and reports
   * whether the operation was aborted (e.g. by an explicit Stop). */
  compact(): Promise<{ aborted: boolean }>;
  /** Abort the run. Message delivery preserves compaction; explicit Stop cancels it. */
  abort(options?: { preserveCompaction?: boolean }): void;
  destroy(): void;
  /** Awaitable teardown for background children: waits for the extension
   *  session_shutdown emission AND runs the SDK's synchronous dispose
   *  (resource cleanups) to completion — a confirmed end of cleanup, not just
   *  an issued request. Throws when shutdown or dispose fails. */
  destroyAndWait?(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;
  /** Snapshot the live session for a background fork: current session file plus
   *  the entries of the CURRENT legal branch (read-only; never opens or writes
   *  the parent file through SDK APIs). Optional — background fork only. */
  forkSnapshot?(): { sessionFile: string; branchEntries: unknown[] } | null;

  // Metadata for status reporting
  readonly pid?: number; // deprecated: CLI rollback metadata
  readonly runtimeName?: string;
  readonly spawnArgs?: string[]; // deprecated: CLI rollback metadata
  readonly runtimeParams?: AgentRuntimeParams;

  // Optional — check runtime.capabilities before calling
  setModel?(model: string, credentialId: string): void | Promise<void>;
  refreshModelRegistry?(opts?: { allowNetwork?: boolean }): void | Promise<void>;
  setThinkingLevel?(level: string): void;
  getContextUsage?(): Promise<ContextUsage | null>;
  reloadResources?(opts: ReloadAgentResourcesOpts): Promise<void>;
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
