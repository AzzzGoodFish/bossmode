// ============================================================================
// Agent Runtime Abstraction Layer V2 — CLI-Only Design
// ============================================================================

import type { KnowledgeEntry } from "../../shared/types.js";

// -- Member config --

export interface MemberConfig {
  id: string;
  name: string;              // user-defined display name, e.g. "arch-sonnet"
  agent: string;             // references agent definition name, e.g. "architect"
  model: string;
  runtime: "pi-cli" | "claude-cli";
  thinkingLevel: string;
  avatar?: string;
  contextLimit?: number;     // max messages per activation (default 50)
}

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
}

// -- Agent creation --

export interface CreateAgentOpts {
  cwd: string;
  roomId: string;              // bossmode room ID (for tool callbacks)
  member: MemberConfig;

  // Layered prompt content
  agentPrompt: string;       // Layer 1: agent definition body
  skillPaths: string[];      // Layer 2: skill directory paths
  rulesPrompt?: string;      // Layer 3: rules from knowledge base

  roomMembers: string[];
  callbacks: AgentCallbacks;

  // Session resume
  resumeSession?: { sessionId?: string; sessionFile?: string };
  onSessionCreated?: (session: { sessionId?: string; sessionFile?: string }) => void;
}

export interface AgentCallbacks {
  onChat: (message: string) => Promise<void>;
  onMention: (target: string, message: string) => Promise<void>;
  onSaveKnowledge?: (title: string, content: string) => Promise<void>;
  onQueryKnowledge?: (query?: string) => Promise<KnowledgeEntry[]>;
}

// -- Agent handle --

export interface AgentHandle {
  prompt(message: string): Promise<void>;
  steer(message: string): void;
  abort(): void;
  destroy(): void;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;
  readonly isWorking: boolean;

  // Metadata for status reporting
  readonly pid?: number;
  readonly runtimeName?: string;
  readonly spawnArgs?: string;

  // Optional — check runtime.capabilities before calling
  setModel?(model: string): void;
  setThinkingLevel?(level: string): void;
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
  | { type: "tool_end"; toolName: string; toolCallId: string; result: unknown; isError: boolean };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

// -- Runtimes config --

export interface RuntimesConfig {
  runtimes: Record<string, { enabled: boolean; cliPath?: string }>;
}
