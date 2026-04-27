// ============================================================================
// Bossmode Shared Types — Five Domain Architecture
// ============================================================================

// -- Config --

export interface BossmodeConfig {
  auth: {
    username: string;
    passwordHash: string;
  };
  apiKeys: Record<string, string>; // provider → key
  defaults: {
    host: string;
    port: number;
  };
  summary?: {
    autoEnabled: boolean;
    threshold: number;  // message count to trigger auto-summary
    keepCount: number;  // keep latest N messages unsummarized
  };
  runtime?: {
    sessionResume: boolean;
  };
}

// -- Agent Definition --

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  avatar?: string;
  tags: string[];
  // Kept for backward compatibility — new agents may omit these.
  // Member config takes precedence when present.
  model?: string;
  skills?: string[];
}

// -- Skill Definition --

export interface SkillDefinition {
  name: string;
  description: string;
  tags: string[];
  content: string;
  source?: string; // directory this skill was loaded from
}

// -- Member --

export interface MemberBase {
  id: string;
  name: string;
  type: "human" | "agent";
  avatar?: string;
}

export interface AgentMemberConfig extends MemberBase {
  type: "agent";
  agent: string;             // references agent definition name
  model: string;
  runtime: "pi-cli" | "claude-cli";
  skills?: string[];         // override agent's default skills
  thinkingLevel: string;
  contextLimit?: number;     // max messages per activation (default 50)
}

export interface HumanMemberConfig extends MemberBase {
  type: "human";
}

export type MemberConfig = AgentMemberConfig | HumanMemberConfig;

// Backward-compatible type for legacy members.json without type field
export interface LegacyMemberConfig {
  id: string;
  name: string;
  agent: string;
  model: string;
  runtime: "pi-cli" | "claude-cli";
  thinkingLevel: string;
  avatar?: string;
  contextLimit?: number;
  type?: "agent";
  skills?: string[];
}

// -- Knowledge --
//
// 0.8.0: KnowledgeBase (per-project container) is removed. All documents live
// in a single global tree: ~/.bossmode/knowledge/docs/. Users organize projects
// by top-level folders (e.g. docs/bossmode/..., docs/freeu/...). Rooms pick
// which docs to inject as rules via `ruleDocs: string[]`.

export interface KnowledgeEntry {
  /** Document path relative to KB docs root, e.g. "architecture/overview.md". Acts as stable ID. */
  id: string;
  /** Human-readable title (from frontmatter, falls back to filename). */
  title: string;
  /** Markdown body (frontmatter stripped). */
  content: string;
  /** Creator identity (from frontmatter). Values: "user", agent name, etc. */
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** Lightweight tree node for UI and agent context injection. */
export interface KnowledgeTreeNode {
  /** File or folder path relative to docs root. */
  path: string;
  /** Display name (filename or folder name). */
  name: string;
  /** "file" or "folder". */
  kind: "file" | "folder";
  /** Title for files (derived from frontmatter or filename). */
  title?: string;
  /** Children for folders. */
  children?: KnowledgeTreeNode[];
}

// -- Room --

export interface Room {
  id: string;
  name: string;
  cwd: string;
  members: string[];
  createdAt: number;
  /**
   * Document paths (relative to ~/.bossmode/knowledge/docs/) injected into
   * agents' system prompts as rules.
   */
  ruleDocs?: string[];
}

// -- Message --

export interface SummaryMeta {
  title: string;
  covered_range: {
    from_id: string;
    to_id: string;
    count: number;
  };
  time_range: {
    from: number; // timestamp
    to: number;
  };
  participants: string[];
}

export interface RoomMessage {
  id: string;
  sender: string; // member name or "user" (legacy) or "system"
  content: string;
  mentions: string[];
  ts: number;
  type?: "summary" | "task_event";
  summary_meta?: SummaryMeta;
  task_event_meta?: TaskEventMeta;
}

// -- Agent Status --

export type AgentStatus = "inactive" | "idle" | "working";

export interface AgentStatusInfo {
  name: string;
  status: AgentStatus;
  roomId: string | null;
}

export interface ContextUsage {
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
}

// -- Cursors --

export type CursorMap = Record<string, string | null>; // agentName → last seen message id

// -- Archive --

export interface ArchiveSummary {
  summary: string;
  archivedCount: number;
  range: [string, string]; // [firstId, lastId]
  ts: number;
}

// -- Task Board --

export type TaskStatus = "todo" | "in-progress" | "review" | "done";
export type TaskPriority = "P0" | "P1" | "P2";

export interface Task {
  id: string;
  roomId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;       // member name
  description?: string;   // markdown
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEventMeta {
  action: "created" | "updated" | "status_changed" | "deleted";
  taskId: string;
  taskTitle: string;
  newStatus?: TaskStatus;
  actor: string;
}

// -- WebSocket Events (server → client) --

export type WsServerEvent =
  | { type: "room:message"; roomId: string; message: RoomMessage }
  | { type: "agent:status"; roomId: string; agent: string; status: AgentStatus }
  | { type: "agent:event"; roomId: string; agent: string; event: unknown }
  | { type: "agent:context_usage"; roomId: string; agent: string; usage: ContextUsage | null }
  | { type: "task:created"; roomId: string; task: Task }
  | { type: "task:updated"; roomId: string; task: Task }
  | { type: "task:deleted"; roomId: string; taskId: string };

// -- WebSocket Commands (client → server) --

export type WsClientCommand =
  | { type: "subscribe:room"; roomId: string }
  | { type: "unsubscribe:room"; roomId: string }
  | { type: "subscribe:agent"; roomId: string; agent: string }
  | { type: "unsubscribe:agent"; roomId: string; agent: string };

// -- API Responses --

export interface ApiError {
  error: string;
}

// -- Session --

export interface SessionToken {
  token: string;
  expiresAt: number;
}

// -- Agent Session (persisted) --

export interface AgentSession {
  runtime: string;
  sessionId?: string;
  sessionFile?: string;
}
