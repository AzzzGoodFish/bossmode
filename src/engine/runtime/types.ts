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
  appendSystemPrompt?: string[]; // Bossmode core + prompt supplements.
  skillPaths: string[];      // Skill directory paths
  skillNames?: string[];     // Resolved skill names for status display
  rulesPrompt?: string;      // Legacy compatibility; ignored by new prompt compiler.

  roomMembers: string[];
  callbacks: AgentCallbacks;

  // Session resume
  resumeSession?: { sessionId?: string; sessionFile?: string };
  // Called whenever runtime reports session identity (initial + later changes after compact/fork)
  onSessionChanged?: (session: { sessionId?: string; sessionFile?: string }) => void;
}

export interface AgentCallbacks {
  onChat: (message: string) => Promise<void>;
  onMention: (target: string, message: string) => Promise<void>;
}

// -- Agent handle --

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
  steer(message: string): void;
  abort(): void;
  destroy(): void;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;

  // Metadata for status reporting
  readonly pid?: number; // deprecated: CLI rollback metadata
  readonly runtimeName?: string;
  readonly spawnArgs?: string[]; // deprecated: CLI rollback metadata
  readonly runtimeParams?: AgentRuntimeParams;

  // Optional — check runtime.capabilities before calling
  setModel?(model: string): void | Promise<void>;
  refreshModelRegistry?(): void | Promise<void>;
  setThinkingLevel?(level: string): void;
  getContextUsage?(): Promise<ContextUsage | null>;
}

// -- Unified event model --

export type AgentStreamEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start" }
  | { type: "message_update"; text?: string; thinking?: string }
  | { type: "message_end"; text: string; usage?: TokenUsage; stopReason?: string; errorMessage?: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_update"; toolName: string; toolCallId: string; partialResult: unknown }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: unknown; isError: boolean }
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
}

// -- Runtimes config --

export interface RuntimesConfig {
  runtimes: Record<string, { enabled: boolean; cliPath?: string }>;
}
