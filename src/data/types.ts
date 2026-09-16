/**
 * Data-layer record shapes (P7 types sink).
 *
 * Storage-facing interfaces used by both the data layer (repositories,
 * upgrade steps) and the member layer (registry, runtime state, workspaces,
 * stats). Behavior lives above; these declarations are the shared vocabulary
 * so data never has to import member.
 */

export interface MemberGlobalConfig {
  model?: string | null;
  credentialId?: string | null;
  thinkingLevel?: string | null;
  skills?: string[];
  mcpServers?: string[];
}

/** Diff-only overrides for a scope when unified* is false. Empty object / missing key = inherit global. */
export type MemberScopeOverride = Partial<MemberGlobalConfig>;

export interface MemberRecord {
  id: string;
  name: string;
  title?: string;
  agentTemplate: string;
  /** Default true — scope inherits global model/credential/thinking. */
  unifiedModel: boolean;
  /** Default true — scope inherits global extensions/skills/mcp. */
  unifiedExtensions: boolean;
  global: MemberGlobalConfig;
  /** Keys are ScopeId ("dm:<id>" | "room:<roomId>"). Values are diff-only. */
  scopeOverrides: Record<string, MemberScopeOverride>;
  createdAt: number;
  updatedAt: number;
}

export interface MountStale {
  since: number;
  /** Which mount field(s) changed (currently only "mcpServers"). */
  fields: string[];
}

export interface RuntimeStateEntry {
  /** sha1 of bossmode-core + environment-communication + tool schema — code-owned contract parts only. */
  contractFingerprint?: string;
  /** Member-facing contract version stored at last compile (drives the startup drift dialog). */
  contractVersion?: number;
  /** Last version the user was notified about (one-shot drift guard). */
  driftNotified?: number;
  /** Mount config changed since last reload/reset; instance still runs the old mounts. */
  staleMounts?: MountStale;
}

/** Member-id keyed map (all members with a checkpoint). */
export type RuntimeStateMap = Record<string, RuntimeStateEntry>;

export interface MemberStats {
  turns: number;
  toolCalls: number;
  /** Cumulative active work time in ms: sum of (agent_end.ts - agent_start.ts) per turn. */
  activeMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  updatedAt?: number;
}

export interface OriginalWorkspace {
  id: string;
  kind: "original";
  description: string;
  root: string;
  builtin: true;
}

export interface SshWorkspace {
  id: string;
  kind: "ssh";
  description: string;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  root: string;
  builtin?: false;
}

export type WorkspaceEntry = OriginalWorkspace | SshWorkspace;

export interface WorkspaceRegistry {
  active: string;
  workspaces: WorkspaceEntry[];
}
