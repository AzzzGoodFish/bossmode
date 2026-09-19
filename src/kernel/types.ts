// ============================================================================
// Bossmode Shared Types — Five Domain Architecture
// ============================================================================

// -- Config --

export type PiTransportSetting = "auto" | "websocket" | "websocket-cached" | "sse";

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
  mcp?: BossmodeMcpConfig;
  /** Model directory (pi.dev catalog) preferences. */
  catalog?: {
    /** Auto-refresh interval in days for the built-in provider catalog. Default 7. 0 = off. */
    autoRefreshIntervalDays?: number;
  };
}

// -- Skill Definition --



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
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
  compat?: Record<string, unknown>;
  metadataSource?: ModelMetadataSource;
}

export interface ModelCredentialModelCustomizations {
  disabled?: string[];
  contextWindowOverride?: Record<string, number>;
  /** User-added models not present in the built-in provider's pi catalog. */
  addedModels?: ModelDefinitionConfig[];
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
  addedModels?: ModelDefinitionConfig[];
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
  /** Per-level thinking-effort mapping when known (catalog models). Absent for
   * custom models without this metadata — callers must not infer levels then. */
  thinkingLevelMap?: ModelDefinitionConfig["thinkingLevelMap"];
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
  /** database title — UI card chip (replaces template label). */
  title?: string;
  /** Optional member-level model override. When omitted, runtime uses the agent definition model. */
  model?: string;
  runtime: AgentRuntimeName;
  skills?: string[];         // override agent's default skills
  thinkingLevel: string;
  contextLimit?: number;     // max messages per activation (default 50)
  credentialId?: string;     // optional Model Credential Profile override
  mcpServers?: string[];     // room-member scoped MCP server allowlist
  createdAt?: number;        // room member since (present for room-backed members)
}

// -- Message --

/** Attachment metadata travels structurally; the canonical shape and preview
 * classification live in files/attachments.ts. This aggregate is retired with
 * kernel/types in the target tree, and kernel may not import files/ directly. */
export interface MessageAttachmentRecord {
  id: string;
  storedFilename: string;
  originalFilename: string;
  size?: number;
  mime?: string;
  previewType: "image" | "markdown" | "html" | "text" | "download";
}

export interface RoomMessage {
  id: string;
  /** Room-scoped monotonically increasing sequence number, assigned at append time.
   * Backfilled for pre-existing messages by the message-seq-v1 migration; absent only
   * on legacy data that has not yet been migrated (readers must tolerate undefined). */
  seq?: number;
  sender: string; // member name snapshot or "user" (legacy) or "system"
  senderMemberId?: string;
  content: string;
  mentions: string[]; // member name snapshots (@ targets — unread/highlight share one list)
  mentionMemberIds?: string[];
  ts: number;
  type?: "task_event" | "knowledge_event" | "topic_event";
  /** Historical task_event payload (task feature retired 2026-09-11) — kept only so old stored messages still type-check. */
  task_event_meta?: { action: string; taskId: string; taskTitle: string; newStatus?: string; commentId?: string; actor: string; snippet?: string };
  knowledge_event_meta?: KnowledgeEventMeta;
  topic_event_meta?: TopicEventMeta;
  /** Message-level deliverable/document references previewable through artifact-preview. */
  artifacts?: string[];
  /** Structured attachment metadata. Public tool input remains attachments?: string[]. */
  attachments?: MessageAttachmentRecord[];
  /**
   * Captured reply-target labels; stable IDs take precedence when present.
   * Omitted/empty = FYI (no reply debt). User posts omit this; user @ always debts.
   */
  needResponse?: string[];
  /** Stable reply-obligation targets, captured when the message is sent. */
  needResponseMemberIds?: string[];
  /**
   * Retained reference to another message in the same scope.
   * seq for display/jump; messageId is the stable anchor.
   */
  replyTo?: { seq: number; messageId: string };
  /**
   * ⑤ B/C: member↔member chat activity notice — a system message in the
   * RECEIVER's DM scope. The user opens `scopeId` read-only; members never see
   * the notice itself (system notices are hidden from member reads).
   */
  member_chat_meta?: { scopeId: string; fromMemberId: string; toMemberId: string };
}

// -- Agent Status --

export type AgentStatus = "inactive" | "idle" | "working";

export interface ContextUsage {
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  model: string;
  /** True during the post-compact interval where SDK token counts are temporarily unavailable. */
  compacted?: boolean;
}

// -- Retired topic lifecycle cards (fish #19358): stored history only — the room
// stream keeps these two cards, rendered plain-text, never written again. --

export interface TopicEventMeta {
  action: "opened" | "closed";
  topicId: string;
  title: string;
  anchorSeq?: number;
  anchorMessageId?: string;
  anchorExcerpt?: string;
  actor: string;
  /** Closed cards carry the auto summary (batch 4 writes it). */
  summary?: string;
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
  | { type: "member:profile"; memberId: string; name: string; title: string | null }
  | { type: "room:message"; roomId: string; message: RoomMessage }
  | { type: "agent:status"; roomId: string; agent: string; memberId?: string; status: AgentStatus }
  | { type: "agent:event"; roomId: string; agent: string; memberId?: string; event: unknown }
  | { type: "agent:context_usage"; roomId: string; agent: string; memberId?: string; usage: ContextUsage | null };

// -- WebSocket Commands (client → server) --

export type WsClientCommand =
  | { type: "subscribe:room"; roomId: string }
  | { type: "unsubscribe:room"; roomId: string }
  | { type: "subscribe:agent"; roomId: string; agent: string; memberId?: string }
  | { type: "unsubscribe:agent"; roomId: string; agent: string; memberId?: string };
