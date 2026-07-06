// ============================================================================
// Bossmode Shared Types — Five Domain Architecture
// ============================================================================

// -- Config --

export type PiTransportSetting = "auto" | "websocket" | "websocket-cached" | "sse";

export interface BossmodeRuntimeConfig {
  sessionResume: boolean;
  /** pi SDK transport override. Defaults to "auto" when omitted. */
  codexTransport?: PiTransportSetting;
  /** WebSocket connect timeout passed to pi SDK. Bossmode default: 15000. */
  websocketConnectTimeoutMs?: number;
  /** HTTP idle timeout passed to pi SDK when set. */
  httpIdleTimeoutMs?: number;
}

export interface BossmodeMcpConfig {
  enabled: boolean;
}

export type McpServerAvailabilityStatus = "unchecked" | "checking" | "available" | "unavailable" | "auth-required" | "invalid-config";

export interface McpServerAvailability {
  name: string;
  status: McpServerAvailabilityStatus;
  checkedAt?: number;
  toolCount?: number;
  resourceCount?: number;
  error?: string;
}

export interface McpServerSummary {
  name: string;
  transport: "http" | "stdio" | "invalid";
  assignedCount?: number;
  availability?: McpServerAvailability;
}

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
  runtime?: BossmodeRuntimeConfig;
  mcp?: BossmodeMcpConfig;
  integrations?: {
    linear?: {
      apiKey?: string;
    };
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

// -- Model Credentials --

export type ModelProtocol =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "azure-openai-responses"
  | "google-generative-ai"
  | "google-gemini-cli"
  | "google-vertex"
  | "bedrock-converse-stream"
  | "mistral-conversations";

export type ModelAuthType = "api_key" | "oauth" | "none" | "ambient";
export type ModelCredentialProfileKind = "builtin_provider" | "custom_endpoint" | "trusted_adapter";
export type ModelRequestProfile = "standard" | "openai_codex_subscription";

export type ModelMetadataSource = "endpoint" | "pi_catalog" | "unknown";

export interface ModelDefinitionConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
  compat?: Record<string, unknown>;
  metadataSource?: ModelMetadataSource;
}

export interface ModelMetadataOverride {
  contextWindow?: number;
}

export interface ModelCredentialModelCustomizations {
  disabled?: string[];
  contextWindowOverride?: Record<string, number>;
}

export interface ModelCredentialProfile {
  id: string;
  profileKind?: ModelCredentialProfileKind;
  name: string;
  providerSlug: string;
  protocol: ModelProtocol;
  baseUrl?: string;
  authType: ModelAuthType;
  apiKey?: string;
  oauthProviderId?: string;
  oauthCredentials?: Record<string, unknown>;
  requestProfile: ModelRequestProfile;
  authHeader?: boolean;
  headers?: Record<string, string>;
  enabled: boolean;
  isDefault: boolean;
  models: ModelDefinitionConfig[];
  modelCustomizations?: ModelCredentialModelCustomizations;
  createdAt: number;
  updatedAt: number;
}

export type ModelCredentialProfileInput = Omit<ModelCredentialProfile, "id" | "createdAt" | "updatedAt">;

export interface PublicModelCredentialProfile extends Omit<ModelCredentialProfile, "apiKey" | "oauthCredentials"> {
  hasSecret: boolean;
  modelRefs: string[];
  catalogModels?: ModelDefinitionConfig[];
}

export interface PublicModelProvider {
  providerSlug: string;
  displayName: string;
  authModes: Array<"api_key" | "oauth">;
  defaultAuthMode: "api_key" | "oauth";
  modelCount: number;
  sampleModels: string[];
  protocol?: ModelProtocol;
  logoKey?: string;
}

export interface ConnectApiKeyRequest {
  providerSlug: string;
  apiKey: string;
  name?: string;
  baseUrlOverride?: string;
  requestProfile?: ModelRequestProfile;
  isDefault?: boolean;
}

export type OAuthLoginJobStatus = "starting" | "awaiting_input" | "awaiting_device" | "completed" | "failed" | "cancelled";

export interface OAuthDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
}

export interface OAuthSelectPrompt {
  message: string;
  options: Array<{ id: string; label: string }>;
}

export interface OAuthLoginJobPublic {
  id: string;
  status: OAuthLoginJobStatus;
  providerId: string;
  authUrl?: string;
  userCode?: string;
  deviceCode?: OAuthDeviceCodeInfo;
  selectPrompt?: OAuthSelectPrompt;
  prompt: string;
  error?: string;
  profileId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StartOAuthConnectionRequest {
  providerId: string;
  profileId?: string;
  name?: string;
  requestProfile?: ModelRequestProfile;
}

export interface ModelOption {
  ref: string;
  providerSlug: string;
  modelId: string;
  displayName?: string;
  profileId: string;
  profileName: string;
  profileBaseUrl?: string;
  protocol: ModelProtocol;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  metadataSource?: ModelMetadataSource;
  credentialStatus: "configured" | "missing" | "no_auth" | "ambient";
}

export interface AvailableModelOption extends ModelOption {
  provider: string;
  providerDisplayName?: string;
  images: boolean;
}

// -- Member --

export interface MemberBase {
  id: string;
  name: string;
  type: "human" | "agent";
  avatar?: string;
}

export type AgentRuntimeName = "pi-cli";

export interface AgentMemberConfig extends MemberBase {
  type: "agent";
  agent: string;             // references agent definition name
  /** Optional member-level model override. When omitted, runtime uses the agent definition model. */
  model?: string;
  runtime: AgentRuntimeName;
  skills?: string[];         // override agent's default skills
  thinkingLevel: string;
  contextLimit?: number;     // max messages per activation (default 50)
  credentialId?: string;     // optional Model Credential Profile override
  mcpServers?: string[];     // room-member scoped MCP server allowlist
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
  model?: string;
  runtime: AgentRuntimeName | "claude-cli";
  thinkingLevel: string;
  avatar?: string;
  contextLimit?: number;
  credentialId?: string;
  mcpServers?: string[];
  type?: "agent";
  skills?: string[];
}

// -- Knowledge --
//
// 0.8.0: KnowledgeBase (per-project container) is removed. All documents live
// in a single global tree: ~/.bossmode/knowledge/docs/. Users organize projects
// by top-level folders (e.g. docs/bossmode/..., docs/freeu/...). Rooms pick
// Legacy rooms may still preserve selected document paths in `ruleDocs`, but
// Prompt Supplements v1 no longer injects them into agent prompts automatically.

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

/** Lightweight tree node for UI document browsing. */
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

// -- Prompt Supplements --

export interface PromptSupplementMeta {
  revision: number;
  contentHash: string;
  contentLength: number;
  updatedAt?: number;
  updatedBy?: "user" | "member";
  updatedByMemberId?: string;
  updatedByName?: string;
}

export interface PromptSupplement extends PromptSupplementMeta {
  content: string;
}

// -- Room --

export interface RoomLinearIntegration {
  teamId: string;
  teamName: string;
  teamKey?: string;
  projectId?: string;
  projectName?: string;
  enabled: boolean;
  lastSyncAt?: number;
  lastSyncError?: string;
  syncCount?: number;
}

export interface RoomMemberConfig {
  model?: string;
  credentialId?: string;
  thinkingLevel?: string;
  contextLimit?: number;
  skills?: string[];
  mcpServers?: string[];
}

export interface RoomMemberRecord {
  /** Hidden stable globally unique room-member identity. */
  id: string;
  /** Owning room id. Persisted for API clarity; parent room remains authoritative. */
  roomId?: string;
  /** User-facing member name, unique inside the owning room, used for @ mentions. */
  name: string;
  /** Read-only source role/template name. */
  sourceAgent: string;
  /** Legacy/global member id this room member was migrated/created from, when available. */
  sourceMemberId?: string;
  avatar?: string;
  config?: RoomMemberConfig;
  createdAt: number;
  updatedAt: number;
  migratedFrom?: { memberName: string; memberId?: string };
}

export interface RoomMemberOverride extends RoomMemberConfig {}

export interface Room {
  id: string;
  name: string;
  cwd: string;
  /** Compatibility/derived member names. v0.14 identity lives in roomMembers. */
  members: string[];
  /** Room leader room-member id. Rename-stable; may be absent for legacy rooms. */
  promptLeaderMemberId?: string;
  /** Default docs subtree prefix relative to ~/.bossmode/knowledge/docs/, e.g. "bossmode/". */
  docsPath?: string;
  /** Authoritative room-local members for v0.14+. */
  roomMembers?: RoomMemberRecord[];
  createdAt: number;
  /**
   * Legacy selected document paths (relative to ~/.bossmode/knowledge/docs/).
   * Preserved for migration/cascade compatibility; no longer prompt-injected.
   */
  ruleDocs?: string[];
  /** Legacy room-scoped overrides keyed by member name. Read as migration source only. */
  memberOverrides?: Record<string, RoomMemberOverride>;
  integrations?: {
    linear?: RoomLinearIntegration;
  };
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

import type { RoomMessageAttachment } from "./attachments.js";

export interface RoomMessage {
  id: string;
  sender: string; // member name snapshot or "user" (legacy) or "system"
  senderMemberId?: string;
  content: string;
  mentions: string[]; // member name snapshots
  mentionMemberIds?: string[];
  ts: number;
  type?: "summary" | "task_event" | "knowledge_event";
  summary_meta?: SummaryMeta;
  task_event_meta?: TaskEventMeta;
  knowledge_event_meta?: KnowledgeEventMeta;
  /** Message-level deliverable/document references previewable through artifact-preview. */
  artifacts?: string[];
  /** Structured attachment metadata. Public tool input remains attachments?: string[]. */
  attachments?: RoomMessageAttachment[];
}

// -- Agent Status --

export type AgentStatus = "inactive" | "idle" | "working";

export interface AgentStatusInfo {
  name: string;
  memberId?: string;
  status: AgentStatus;
  roomId: string | null;
}

export interface ContextUsage {
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  /** True during the post-compact interval where SDK token counts are temporarily unavailable. */
  compacted?: boolean;
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

export interface TaskComment {
  id: string;
  author: string;
  content: string;
  createdAt: number;
}

export interface Task {
  id: string;
  roomId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee?: string;       // member name snapshot
  assigneeMemberId?: string;
  description?: string;   // markdown stable spec / acceptance criteria
  references?: string[];   // soft links to knowledge docs or URLs
  subscribers?: string[];  // passive watchers; never activates members
  subscriberMemberIds?: string[];
  comments?: TaskComment[];
  linearIssueId?: string;
  linearIssueUrl?: string;
  linearIssueIdentifier?: string;
  linearSyncedAt?: number;
  linearSyncError?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskListItem extends Omit<Task, "comments"> {
  commentCount: number;
}

export interface TaskEventMeta {
  action: "created" | "updated" | "status_changed" | "commented" | "deleted";
  taskId: string;
  taskTitle: string;
  newStatus?: TaskStatus;
  commentId?: string;
  actor: string;
  /** Short excerpt of the task description / comment body, surfaced inline in chat. */
  snippet?: string;
}

// -- Knowledge activity (agent doc writes surfaced into chat) --

export interface KnowledgeEventMeta {
  /** Path relative to knowledge docs root, e.g. "bossmode/architecture/x.md" */
  path: string;
  /** Doc title (frontmatter title, first heading, or filename) */
  title: string;
  /** Acting member name */
  actor: string;
  /** Which tool produced the write */
  tool: "write" | "edit";
  /** True when the doc write is outside the room's configured docsPath. */
  outsideRoomDocsPath?: boolean;
}

// -- WebSocket Events (server → client) --

export type WsServerEvent =
  | { type: "room:message"; roomId: string; message: RoomMessage }
  | { type: "agent:status"; roomId: string; agent: string; memberId?: string; status: AgentStatus }
  | { type: "agent:event"; roomId: string; agent: string; memberId?: string; event: unknown }
  | { type: "agent:context_usage"; roomId: string; agent: string; memberId?: string; usage: ContextUsage | null }
  | { type: "task:created"; roomId: string; task: Task }
  | { type: "task:updated"; roomId: string; task: Task }
  | { type: "task:deleted"; roomId: string; taskId: string };

// -- WebSocket Commands (client → server) --

export type WsClientCommand =
  | { type: "subscribe:room"; roomId: string }
  | { type: "unsubscribe:room"; roomId: string }
  | { type: "subscribe:agent"; roomId: string; agent: string; memberId?: string }
  | { type: "unsubscribe:agent"; roomId: string; agent: string; memberId?: string };

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
