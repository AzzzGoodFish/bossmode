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

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  type: "rule" | "knowledge";
  createdAt: number;
  updatedAt: number;
}

// -- Room --

export interface Room {
  id: string;
  name: string;
  cwd: string;
  members: string[];
  createdAt: number;
  knowledgeBaseId?: string;
  ruleIds?: string[];
}

// -- Message --

export interface RoomMessage {
  id: string;
  sender: string; // member name or "user" (legacy) or "system"
  content: string;
  mentions: string[];
  ts: number;
}

// -- Agent Status --

export type AgentStatus = "inactive" | "idle" | "working";

export interface AgentStatusInfo {
  name: string;
  status: AgentStatus;
  roomId: string | null;
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

// -- WebSocket Events (server → client) --

export type WsServerEvent =
  | { type: "room:message"; roomId: string; message: RoomMessage }
  | { type: "agent:status"; roomId: string; agent: string; status: AgentStatus }
  | { type: "agent:event"; roomId: string; agent: string; event: unknown };

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
