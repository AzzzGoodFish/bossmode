// ============================================================================
// Agent Runtime Abstraction Layer V2 — CLI-Only Design
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
  agentPrompt: string;       // Layer 1 (agent def) + Layer 4 (knowledge). Empty if no system prompt.
  envPrompt: string;         // Layer 5 (environment info). Always present.
  skillPaths: string[];      // Layer 2: skill directory paths
  rulesPrompt?: string;      // Layer 3: rules from knowledge base

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

export interface AgentHandle {
  prompt(message: string): Promise<void>;
  steer(message: string): void;
  abort(): void;
  destroy(): void;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;

  // Metadata for status reporting
  readonly pid?: number;
  readonly runtimeName?: string;
  readonly spawnArgs?: string[];

  // Optional — check runtime.capabilities before calling
  setModel?(model: string): void;
  setThinkingLevel?(level: string): void;
  getContextUsage?(): Promise<ContextUsage | null>;
}

// -- Unified event model --

export type AgentStreamEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start" }
  | { type: "message_update"; text?: string; thinking?: string }
  | { type: "message_end"; text: string; usage?: TokenUsage }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_update"; toolName: string; toolCallId: string; partialResult: unknown }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "cli:stdout"; text: string }
  | { type: "cli:stderr"; text: string }
  // Emitted exactly once per handle when the CLI process exits.
  // `unexpected` is true for crashes / startup failures / parse errors;
  // false only when triggered by handle.destroy() (normal shutdown).
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
