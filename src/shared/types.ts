// ============================================================================
// Bossmode Shared Types
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
  model: string;
  description: string;
  systemPrompt: string;
  // v2
  skills: string[];
  avatar?: string;
  tags: string[];
}

// -- Skill Definition --

export interface SkillDefinition {
  name: string;
  description: string;
  tags: string[];
  content: string;
  source?: string; // directory this skill was loaded from
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
  sender: string; // "user" or agent name
  content: string;
  mentions: string[];
  ts: number;
}

// -- Agent Status --

export type AgentStatus = "inactive" | "idle" | "working";

export interface AgentStatusInfo {
  name: string;
  status: AgentStatus;
  roomId: string | null; // which room the agent is active in
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
