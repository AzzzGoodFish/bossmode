export type AgentStatus="inactive"|"idle"|"working";
export interface AgentMemberConfig {
  id:string;name:string;agent:string;title?:string;model?:string;
  skills?:string[];thinkingLevel:string;credentialId?:string;
}
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
export interface AgentMemberSnapshot {
  config: AgentMemberConfig;
  prompt: AgentPromptSnapshot;
  resources: AgentResourceSnapshot;
  workspaceRoot: string;
  resumeSession?: CreateAgentOpts["resumeSession"];
}
export interface AgentRuntime {
  readonly name: string;
  createAgent(opts: CreateAgentOpts): Promise<AgentHandle>;
  shutdownMember(memberId: string): Promise<void>;
  shutdownAll(): Promise<void>;
}
export interface CreateAgentOpts {
  cwd: string;
  member: AgentMemberConfig;
  resolveSourceRef: () => string | null;
  resources: AgentResourceSnapshot;
  agentPrompt: string;
  appendSystemPrompt: string[];
  resumeSession?: { sessionId?: string; sessionFile?: string };
  sessionDir?: string;
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
  beforeDispatch?: (event: RuntimePromptDispatch) => void;
}
export interface AgentHandle {
  prompt(message: string, options?: RuntimePromptOptions): Promise<void>;
  compact(): Promise<{ aborted: boolean }>;
  abort(options?: { preserveCompaction?: boolean }): void;
  destroy(): void;
  destroyAndWait(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;
  readonly runtimeName: string;
  readonly runtimeParams: AgentRuntimeParams;
  setModel(model: string, credentialId: string): void | Promise<void>;
  refreshModelRegistry(opts?: { allowNetwork?: boolean }): void | Promise<void>;
  setThinkingLevel(level: string): void;
  getContextUsage(): Promise<ContextUsage | null>;
  refreshPrompt(opts: { agentPrompt: string; appendSystemPrompt: string[] }): void;
  getActiveTools(): MemberActiveToolInfo[];
}
export interface MemberActiveToolInfo {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  source: string;
}
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
