const BASE_URL = "";

let authToken: string | null = localStorage.getItem("bossmode_token");
let authUsername: string | null = localStorage.getItem("bossmode_username");

/** Login name of the human user — powers the "@me" mention tier (`@<loginName>`, same judgement as unread mentioned). */
export function getUsername(): string | null {
  return authUsername;
}

export function setUsername(username: string): void {
  authUsername = username;
  localStorage.setItem("bossmode_username", username);
}

export function setToken(token: string): void {
  authToken = token;
  localStorage.setItem("bossmode_token", token);
}

export function clearToken(): void {
  authToken = null;
  localStorage.removeItem("bossmode_token");
  authUsername = null;
  localStorage.removeItem("bossmode_username");
}

export function getToken(): string | null {
  return authToken;
}

let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(cb: () => void): void {
  onUnauthorized = cb;
}

/** Keep HTTP status available to distinguish bad credentials from service failures. */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    if (path !== "/api/auth/login") onUnauthorized?.();
    throw new ApiError("Unauthorized", 401);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
  }

  return res.json();
}

// -- Auth --

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; expiresAt: number }> {
  const result = await apiFetch<{ token: string; expiresAt: number }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  setToken(result.token);
  setUsername(username);
  return result;
}

// -- Members --

export interface MemberInfo {
  avatarShape?: string | null;
  avatarColor?: string | null;
  id: string;
  name: string;
  agent: string;
  /** database title — the card field that replaces the template label. */
  title?: string | null;
  sourceAgent?: string;
  roomId?: string;
  model?: string | null;
  runtime?: "pi-cli";
  thinkingLevel: string;
  avatar?: string;
  contextLimit?: number;
  credentialId?: string | null;
  mcpServers?: string[];
  /** Enabled extension package names (default empty = none). */
  createdAt?: number;
}

/** Current contact identity returned by the member directory. */
export interface RoomContact {
  avatarShape?: string | null;
  avatarColor?: string | null;
  id: string;
  name: string;
  title?: string | null;
  avatar?: string;
}

export async function getMembers(): Promise<RoomContact[]> {
  const result = await apiFetch<{ members: RoomContact[] }>("/api/members");
  if (!Array.isArray(result.members)) throw new Error("Invalid member list response");
  return result.members;
}

export async function getRoomMembers(roomId: string): Promise<MemberInfo[]> {
  return apiFetch(`/api/rooms/${roomId}/members`);
}


export async function getMemberTokenUsage(id: string, roomId?: string): Promise<{ totalTokens: number }> {
  const query = roomId ? `?scope=${encodeURIComponent(`room:${roomId}`)}` : "";
  return apiFetch(`/api/members/${id}/token-usage${query}`);
}

export interface MemberStats {
  turns: number;
  toolCalls: number;
  activeMs: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cost: number;
  updatedAt?: number;
}

export async function getMemberStats(id: string, roomId: string): Promise<MemberStats> {
  return apiFetch(`/api/members/${id}/stats?scope=${encodeURIComponent(`room:${roomId}`)}`);
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
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;
  compat?: Record<string, unknown>;
  metadataSource?: ModelMetadataSource;
}

export interface ModelMetadataOverride {
  contextWindow?: number;
}

export interface ModelCredentialModelCustomizations {
  disabled?: string[];
  contextWindowOverride?: Record<string, number>;
  addedModels?: ModelDefinitionConfig[];
}

export interface PublicModelCredentialProfile {
  id: string;
  profileKind?: ModelCredentialProfileKind;
  name: string;
  providerSlug: string;
  protocol: ModelProtocol;
  baseUrl?: string;
  authType: ModelAuthType;
  oauthProviderId?: string;
  requestProfile: ModelRequestProfile;
  authHeader?: boolean;
  headers?: Record<string, string>;
  enabled: boolean;
  isDefault: boolean;
  models: ModelDefinitionConfig[];
  modelCustomizations?: ModelCredentialModelCustomizations;
  createdAt: number;
  updatedAt: number;
  hasSecret: boolean;
  modelRefs: string[];
  catalogModels?: ModelDefinitionConfig[];
  addedModels?: ModelDefinitionConfig[];
}

export interface ModelCredentialProfileInput extends Omit<PublicModelCredentialProfile, "id" | "createdAt" | "updatedAt" | "hasSecret" | "modelRefs"> {
  apiKey?: string;
  oauthCredentials?: Record<string, unknown>;
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

export async function getModelCredentialProfiles(): Promise<PublicModelCredentialProfile[]> {
  return apiFetch("/api/model-credential-profiles");
}

export async function getModelProviderCatalog(): Promise<PublicModelProvider[]> {
  return apiFetch("/api/model-provider-catalog");
}

export async function connectModelProviderApiKey(data: ConnectApiKeyRequest): Promise<PublicModelCredentialProfile> {
  return apiFetch("/api/model-credential-profiles/connect-api-key", { method: "POST", body: JSON.stringify(data) });
}

export async function createModelCredentialProfile(data: ModelCredentialProfileInput): Promise<PublicModelCredentialProfile> {
  return apiFetch("/api/model-credential-profiles", { method: "POST", body: JSON.stringify(data) });
}

export async function updateModelCredentialProfile(id: string, data: Partial<ModelCredentialProfileInput>): Promise<PublicModelCredentialProfile> {
  return apiFetch(`/api/model-credential-profiles/${id}`, { method: "PUT", body: JSON.stringify(data) });
}

export interface ModelCatalogStatus {
  source: "remote" | "bundled";
  fetchedAt: number | null;
  fetchedAtIso: string | null;
  modelCount: number;
  freshnessLabel: string;
  autoRefreshIntervalDays?: number;
  refreshDue?: boolean;
}

export async function getModelCatalogStatus(): Promise<ModelCatalogStatus> {
  return apiFetch("/api/model-catalog/status");
}

export async function updateModelCatalogSettings(settings: {
  autoRefreshIntervalDays: number;
}): Promise<{
  autoRefreshIntervalDays: number;
  refreshDue: boolean;
  status: ModelCatalogStatus;
}> {
  return apiFetch("/api/model-catalog/settings", { method: "PUT", body: JSON.stringify(settings) });
}

export async function refreshModelCatalog(): Promise<{
  source: "remote" | "bundled";
  error?: string;
  fetchedAt?: number | null;
  freshnessLabel: string;
  modelCount: number;
  triggered: boolean;
  reason: string;
}> {
  return apiFetch("/api/model-catalog/refresh", { method: "POST" });
}

export async function deleteModelCredentialProfile(id: string): Promise<void> {
  await apiFetch(`/api/model-credential-profiles/${id}`, { method: "DELETE" });
}

export interface ModelDiscoveryResult {
  models: ModelDefinitionConfig[];
  partial: boolean;
  warnings: string[];
}

export interface OAuthLoginJob {
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

export async function startOAuthConnection(data: StartOAuthConnectionRequest): Promise<OAuthLoginJob> {
  return apiFetch("/api/model-credential-profiles/oauth/start", { method: "POST", body: JSON.stringify(data) });
}

export async function getOAuthConnectionJob(id: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth/${id}`);
}

export async function submitOAuthConnectionInput(id: string, code: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth/${id}/input`, { method: "POST", body: JSON.stringify({ code }) });
}

export async function cancelOAuthConnection(id: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth/${id}/cancel`, { method: "POST" });
}

export async function discoverModelCredentialModels(data: Partial<ModelCredentialProfileInput> & { id?: string }): Promise<ModelDiscoveryResult> {
  return apiFetch("/api/model-credential-profiles/discover-models", { method: "POST", body: JSON.stringify(data) });
}

export async function getAvailableModels(): Promise<AvailableModelOption[]> {
  return apiFetch("/api/available-models");
}

export async function getConfiguredModels(): Promise<AvailableModelOption[]> {
  return getAvailableModels();
}

// -- Runtimes --

// -- Knowledge --
//
// 0.8.0: single global namespace. No KB container; every document is a path
// relative to ~/.bossmode/knowledge/docs/.

/** Directory tree node for the file-explorer UI. */
export interface KnowledgeTreeNode {
  path: string;
  name: string;
  kind: "file" | "folder";
  title?: string;
  children?: KnowledgeTreeNode[];
}

export async function apiFetchBlob(path: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (res.status === 401) {
    clearToken();
    onUnauthorized?.();
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.blob();
}

export interface ArtifactPreviewData {
  type: "md" | "html" | "image" | "text";
  originalPath: string;
  path: string;
  title: string;
  content: string;
}

export async function getArtifactPreview(roomId: string, path: string): Promise<ArtifactPreviewData> {
  return apiFetch(`/api/rooms/${roomId}/artifact-preview?path=${encodeURIComponent(path)}`);
}

export async function getAttachmentPreview(roomId: string, filename: string): Promise<ArtifactPreviewData> {
  return apiFetch(`/api/conversations/${encodeURIComponent(`room:${roomId}`)}/attachments/${encodeURIComponent(filename)}/preview`);
}

export async function getArtifactRawBlob(roomId: string, path: string): Promise<Blob> {
  return apiFetchBlob(`/api/rooms/${roomId}/artifact-raw?path=${encodeURIComponent(path)}`);
}

export async function getAttachmentRawBlob(roomId: string, filename: string): Promise<Blob> {
  return apiFetchBlob(`/api/conversations/${encodeURIComponent(`room:${roomId}`)}/attachments/${encodeURIComponent(filename)}`);
}

// -- Rooms --

export interface Room {
  id: string;
  name: string;
  /** ⑤: room description — shown in chat_info / the room settings dialog. */
  description?: string;
  members: string[];
  memberIds: string[];
  promptLeaderMemberId?: string;
  docsPath?: string;
  createdAt: number;
  /** Live status projection keyed by current member display name. */
  agentStatuses?: Record<string, string>;
}

export async function getRooms(): Promise<Room[]> {
  return apiFetch("/api/rooms");
}

export async function createRoom(
  name: string,
  memberIds: string[],
  leaderMemberId: string,
): Promise<Room> {
  return apiFetch("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name, memberIds, leaderMemberId }),
  });
}

export async function updateRoomSettings(
  id: string,
  patch: { name?: string; description?: string | null; promptLeaderMemberId?: string | null; docsPath?: string | null },
): Promise<Room> {
  return apiFetch(`/api/rooms/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getRoom(id: string): Promise<Room> {
  return apiFetch(`/api/rooms/${id}`);
}

export async function deleteRoom(id: string): Promise<void> {
  await apiFetch(`/api/rooms/${id}`, { method: "DELETE" });
}

export interface MemberActiveTool {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  /** builtin | bossmode | mcp | extension:<id> */
  source: string;
}

export interface MemberActiveToolsResponse {
  sessionActive: boolean;
  tools: MemberActiveTool[];
  message?: string;
}

// -- Messages --

export interface KnowledgeEventMeta {
  path: string;
  title: string;
  actor: string;
  tool: "write" | "edit";
  outsideRoomDocsPath?: boolean;
}

export type AttachmentPreviewType = "image" | "markdown" | "html" | "text" | "download";

export interface RoomMessageAttachment {
  id: string;
  storedFilename: string;
  originalFilename: string;
  size?: number;
  mime?: string;
  previewType: AttachmentPreviewType;
}

export interface MemberIdentity { id: string; name: string }

export async function getMemberIdentities(signal?: AbortSignal): Promise<MemberIdentity[]> {
  const result = await apiFetch<{members: unknown}>("/api/members/identities", {signal});
  if (!Array.isArray(result.members)) throw new Error("Invalid member identity response");
  const seen = new Set<string>();
  for (const value of result.members) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid member identity response");
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    if (keys.length !== 2 || keys[0] !== "id" || keys[1] !== "name"
      || typeof row.id !== "string" || !row.id || typeof row.name !== "string" || !row.name || seen.has(row.id)) {
      throw new Error("Invalid member identity response");
    }
    seen.add(row.id);
  }
  return result.members as MemberIdentity[];
}

export interface RoomMessage {
  id: string;
  seq?: number;
  sender: string;
  senderMemberId?: string;
  content: string;
  mentions: string[];
  mentionMemberIds?: string[];
  ts: number;
  type?: "task_event" | "knowledge_event" | "topic_event";
  /** Historical task_event payload (task feature retired 2026-09-11) — kept only so old messages still parse. */
  task_event_meta?: { action: string; taskId: string; taskTitle: string; newStatus?: string; actor: string; snippet?: string };
  knowledge_event_meta?: KnowledgeEventMeta;
  topic_event_meta?: TopicEventMeta;
  artifacts?: string[];
  attachments?: RoomMessageAttachment[];
  /** Quote reply target (plan-reply-to-v1): seq for display/jump, messageId the stable anchor. */
  replyTo?: { seq: number; messageId: string };
}

/** Historical topic_event payload (topic feature retired 2026-09-11) — kept only so old room cards still parse and render as plain text. */
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

export interface MessageSearchHit {
  id: string;
  seq?: number;
  sender: string;
  senderMemberId?: string;
  content: string;
  ts: number;
}
export interface MessageSearchResult {
  total: number;
  messages: MessageSearchHit[];
}

export async function searchMessages(
  roomId: string,
  opts: { query?: string; from?: string; fromMemberId?: string; after?: number; before?: number; limit?: number; offset?: number },
): Promise<MessageSearchResult> {
  const qs = new URLSearchParams();
  if (opts.query) qs.set("query", opts.query);
  if (opts.from) qs.set("from", opts.from);
  if (opts.fromMemberId) qs.set("fromMemberId", opts.fromMemberId);
  if (opts.after !== undefined) qs.set("after", String(opts.after));
  if (opts.before !== undefined) qs.set("before", String(opts.before));
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
  return apiFetch(`/api/conversations/${encodeURIComponent(`room:${roomId}`)}/messages/search?${qs}`);
}

export async function getMessages(
  roomId: string,
  opts?: { limit?: number; before?: string; around?: string },
): Promise<RoomMessage[]> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", opts.before);
  if (opts?.around) params.set("around", opts.around);
  const qs = params.toString();
  const result = await apiFetch<{ messages: RoomMessage[] }>(`/api/conversations/${encodeURIComponent(`room:${roomId}`)}/messages${qs ? `?${qs}` : ""}`);
  return result.messages;
}

export async function sendMessage(
  roomId: string,
  content: string,
  attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>,
  replyTo?: { seq: number },
): Promise<RoomMessage> {
  const result = await apiFetch<{ message: RoomMessage }>(`/api/conversations/${encodeURIComponent(`room:${roomId}`)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, attachments, ...(replyTo ? { replyTo } : {}) }),
  });
  return result.message;
}

export interface PaginatedEvents {
  events: unknown[];
  total: number;
  hasMore: boolean;
  scopeId: string;
  memberId: string;
}

export async function getConversationEvents(scopeId: string, memberId: string, limit: number, before?: number): Promise<PaginatedEvents> {
  const params = new URLSearchParams({ memberId, limit: String(limit) });
  if (before !== undefined) params.set("before", String(before));
  return apiFetch(`/api/conversations/${encodeURIComponent(scopeId)}/events?${params}`);
}

export interface ActivityEventsPage {
  events: unknown[];
  hasMore: boolean;
  nextBeforeSeq: number | null;
}

/**
 * Index-backed Activity pagination (0.19.1 S3). Newest-first pages via the
 * SQLite activity index + O(1) byte-offset line fetch; `beforeSeq` is the seq
 * cursor returned as `nextBeforeSeq`. `types` filters to indexed event types.
 */
export async function getMemberActivityEvents(
  roomId: string,
  ref: string,
  limit: number,
  beforeSeq?: number,
  types?: string[],
): Promise<ActivityEventsPage> {
  const qs = new URLSearchParams({ scope: `room:${roomId}`, limit: String(limit) });
  if (beforeSeq !== undefined) qs.set("beforeSeq", String(beforeSeq));
  if (types && types.length) qs.set("types", types.join(","));
  return apiFetch(`/api/members/${encodeURIComponent(ref)}/events?${qs}`);
}

/** ① B5: stop/compact/reset/restart target the member directly — no chat scope
 *  in the interface; the same call works from any chat or the member panel. */
export async function memberAction(
  memberId: string,
  action: "compact" | "reset" | "restart",
): Promise<{ ok?: boolean; action?: string; message?: string }> {
  return apiFetch(`/api/members/${encodeURIComponent(memberId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function abortMember(memberId: string): Promise<{ ok: boolean; action: string }> {
  return apiFetch(`/api/members/${encodeURIComponent(memberId)}/stop`, { method: "POST" });
}

// -- Context Usage --

export interface ContextUsageData {
  supported: boolean;
  unavailable?: boolean;
  totalTokens?: number;
  rawMaxTokens?: number;
  percentage?: number;
  model?: string;
  compacted?: boolean;
  contextReset?: boolean;
}

export type ConversationContextUsageInfo = ContextUsageData & { scopeId: string };

export async function getAgentContextUsage(roomId: string, memberId: string): Promise<ConversationContextUsageInfo> {
  return apiFetch(`/api/conversations/${encodeURIComponent(`room:${roomId}`)}/context-usage?memberId=${encodeURIComponent(memberId)}`);
}

// -- Usage (token stats) --

export interface UsageKpis {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRate: number;
  turns: number;
}
export interface UsageModelBucket {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
}
export interface UsageSeriesPoint {
  date: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  byModel: Record<string, UsageModelBucket>;
  byAgent: Record<string, number>;
}
export interface UsageBreakdownRow {
  memberId: string;
  memberName?: string;
  agent?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
export interface UsageAgentRow {
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
export interface UsageRoomRow {
  roomId: string;
  roomName?: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}
export interface UsageResponse {
  kpis: UsageKpis;
  series: UsageSeriesPoint[];
  breakdown: UsageBreakdownRow[];
  byAgent: UsageAgentRow[];
  byRoom?: UsageRoomRow[];
}

/** Platform-wide usage (all rooms). Optional agent/model filters. */
export async function getPlatformUsage(params?: {
  from?: string;
  to?: string;
  agent?: string;
  model?: string;
}): Promise<UsageResponse> {
  const q = new URLSearchParams();
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  if (params?.agent) q.set("agent", params.agent);
  if (params?.model) q.set("model", params.model);
  const qs = q.toString();
  return apiFetch(`/api/usage${qs ? `?${qs}` : ""}`);
}

/** Single-room usage. */
export async function getRoomUsage(
  roomId: string,
  params?: { from?: string; to?: string; member?: string; agent?: string; model?: string },
): Promise<UsageResponse> {
  const q = new URLSearchParams();
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  if (params?.member) q.set("member", params.member);
  if (params?.agent) q.set("agent", params.agent);
  if (params?.model) q.set("model", params.model);
  const qs = q.toString();
  return apiFetch(`/api/rooms/${roomId}/usage${qs ? `?${qs}` : ""}`);
}

// -- 0.20: Contacts / Members / DM / Chats (member-global model) --

export interface ContactEntry {
  memberId: string;
  name: string;
  agentTemplate: string;
  /** database title — the card field that replaces the template chip. */
  title?: string | null;
  status: "idle" | "working" | "error";
  activeScopes: string[];
  model: string | null;
  contextPct: number | null;
  tokensToday: number;
  tokensTotal: number;
}

export async function getContacts(): Promise<{ contacts: ContactEntry[] }> {
  const result = await apiFetch<{ members: ContactEntry[] }>("/api/members");
  return { contacts: result.members };
}

export interface MemberGlobalConfig {
  model: string | null;
  credentialId: string | null;
  thinkingLevel: string | null;
  skills: string[];
  extensions: string[];
  mcpServers: string[];
}

export interface MemberDetail {
  avatarShape?: string | null;
  avatarColor?: string | null;
  memberId: string;
  name: string;
  agentTemplate: string;
  /** database (batch-1 identity rework): card field, editable in settings. */
  title?: string;
  global?: MemberGlobalConfig;
  createdAt?: number;
  updatedAt?: number;
}

/** persona.md read outlet (batch-2 §2.2 + architect 2026-08-26): the persona
 * file is the panel's single memory asset. Write endpoints answer 410. */
export interface MemberProfileDoc {
  path: string;
  exists: boolean;
  body: string;
  charCount: number;
  overBudget: boolean;
}

export async function getMemberProfile(id: string): Promise<MemberProfileDoc> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}/profile`);
}

/** Current SDK prompt state. No running instance is a normal empty state. */
export type MemberSystemPromptDoc =
  | {
      available: true;
      text: string;
      charCount: number;
      scopeId: string | null;
      contractFingerprint: string;
    }
  | {
      available: false;
      reason: "instance_not_running";
      scopeId: string | null;
    };

export async function getMemberSystemPrompt(id: string, scope: string): Promise<MemberSystemPromptDoc> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}/system-prompt?scope=${encodeURIComponent(scope)}`);
}

/** The member's own skills/ directory, read-only for the panel (batch-2 §2.2). */
export interface MemberSkillEntry {
  name: string;
  path: string;
  description: string;
}

export async function getMemberSkills(id: string): Promise<{ skills: MemberSkillEntry[] }> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}/skills`);
}

/** Member-owned asset listing (batch 6: presence = enabled — the member's own
 * mcp.json / extensions/ / skills/ directories, read-only for the panel). */
export interface MemberWorkspaceEntry {
  id: string;
  kind: string;
  description?: string;
  root: string;
  active: boolean;
  host?: string;
  user?: string;
}

export interface MemberExtensionAsset {
  name: string;
  /** absolute configured package dir or standalone file, never abbreviated server-side */
  path: string;
  /** resolved symlink target; null if inaccessible/missing */
  realPath: string | null;
  /** existing module entry files, configured paths (extension-inventory contract 2026-09-08) */
  entryPoints: string[];
  source: "member" | "builtin";
  /** filesystem/manifest diagnostics, not runtime load errors */
  issues: string[];
}

export interface MemberAssets {
  mcpServers: Array<{ name: string; toolCount?: number }>;
  extensions: MemberExtensionAsset[];
  skills: MemberSkillEntry[];
  workspaces: MemberWorkspaceEntry[];
  sshPublicKey: string | null;
}

export async function getMemberAssets(id: string): Promise<MemberAssets> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}/assets`);
}

export async function getMemberDetail(id: string): Promise<MemberDetail> {
  const res = await apiFetch<{ member: MemberDetail }>(`/api/members/${encodeURIComponent(id)}`);
  return res.member;
}

// DM messages share the exact RoomMessage shape (dm-message-store writes the same
// structure): sender is the member name snapshot for member messages, "user" for
// the human. One contract, no divergence.
export type DmMessage = RoomMessage;

export async function getDmMessages(memberId: string, params?: { before?: number | string; limit?: number; around?: string }): Promise<{ messages: DmMessage[] }> {
  const q = new URLSearchParams();
  if (params?.before !== undefined) q.set("before", String(params.before));
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.around) q.set("around", params.around);
  const qs = q.toString();
  return apiFetch(`/api/conversations/${encodeURIComponent(`dm:${memberId}`)}/messages${qs ? `?${qs}` : ""}`);
}

export async function sendDmMessage(
  memberId: string,
  text: string,
  attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>,
  replyTo?: { seq: number },
): Promise<DmMessage> {
  const res = await apiFetch<{ message: DmMessage }>(`/api/conversations/${encodeURIComponent(`dm:${memberId}`)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: text, ...(attachments?.length ? { attachments } : {}), ...(replyTo ? { replyTo } : {}) }),
  });
  return res.message;
}

export interface ConversationSessionInfo {
  scopeId: string;
  memberId: string;
  memberName: string;
  status: string;
  busy: { busy: boolean; reason?: string };
  contextUsage: ContextUsageData | null;
}

export type DmSession = ConversationSessionInfo;

export async function getDmSession(memberId: string): Promise<DmSession> {
  return apiFetch(`/api/conversations/${encodeURIComponent(`dm:${memberId}`)}/session`);
}

export interface ChatEntry {
  scopeId: string;
  kind: "dm" | "room" | "mm";
  title: string;
  memberId?: string;
  roomId?: string;
  lastMessage?: { sender: string; senderMemberId?: string; text: string; ts: number } | null;
  unreadCount: number;
  mentioned: boolean;
  status?: string;
}

export async function getChats(): Promise<{ chats: ChatEntry[] }> {
  const res = await apiFetch<{ chats: ChatEntry[] }>("/api/chats");
  // Server sends only ConversationRef scopeId — derive memberId/roomId from it.
  for (const c of res.chats) {
    const idx = c.scopeId.indexOf(":");
    if (idx > 0) {
      const id = c.scopeId.slice(idx + 1);
      if (c.kind === "dm") c.memberId = id;
      else c.roomId = id;
    }
  }
  return res;
}

// -- 0.20: member creation --

export interface CreateMemberInput {
  /** Omit for one-click birth — the backend assigns "New Member N" (auto-increment). */
  name?: string;
  model?: string;
  credentialId?: string;
  thinkingLevel?: string;
}

export async function createGlobalMember(input: CreateMemberInput): Promise<{ member: MemberDetail }> {
  return apiFetch("/api/members", { method: "POST", body: JSON.stringify(input) });
}

// -- 0.20: member scopes + fire --

export interface MemberScopeInfo {
  scopeId: string;
  kind: "dm" | "room";
  label: string;
  status: string;
  lastActiveAt: number | null;
}

export async function getMemberScopes(id: string): Promise<{ scopes: MemberScopeInfo[] }> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}/scopes`);
}

export async function deleteGlobalMember(id: string): Promise<void> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: true }),
  });
}


export async function getConversationSession(scopeId: string, memberId: string): Promise<ConversationSessionInfo> {
  return apiFetch(`/api/conversations/${encodeURIComponent(scopeId)}/session?memberId=${encodeURIComponent(memberId)}`);
}

// ── 0.20 flagship ②: scope-addressed panel data (room:<id> | dm:<memberId>) ──

export async function getMemberScopedStats(id: string, scope: string): Promise<MemberStats> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}/stats?scope=${encodeURIComponent(scope)}`);
}

export async function getMemberScopedActivityEvents(
  id: string,
  scope: string,
  limit: number,
  beforeSeq?: number,
  types?: string[],
): Promise<ActivityEventsPage> {
  const qs = new URLSearchParams({ scope, limit: String(limit) });
  if (beforeSeq !== undefined) qs.set("beforeSeq", String(beforeSeq));
  if (types && types.length) qs.set("types", types.join(","));
  return apiFetch(`/api/members/${encodeURIComponent(id)}/events?${qs}`);
}

export interface ConversationToolsInfo extends MemberActiveToolsResponse {
  scopeId: string;
  memberId: string;
}

export async function getConversationTools(scopeId: string, memberId: string): Promise<ConversationToolsInfo> {
  return apiFetch(`/api/conversations/${encodeURIComponent(scopeId)}/tools?memberId=${encodeURIComponent(memberId)}`);
}

export async function patchGlobalMember(id: string, patch: Record<string, unknown>): Promise<{ member: MemberDetail }> {
  return apiFetch(`/api/members/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function postConversationRead(scopeId: string): Promise<void> {
  await apiFetch(`/api/conversations/${encodeURIComponent(scopeId)}/read`, { method: "POST" });
}

// -- 0.20: room membership management (memberId form) --

export async function inviteRoomMember(roomId: string, memberId: string): Promise<Room> {
  return apiFetch(`/api/rooms/${roomId}/members`, {
    method: "POST",
    body: JSON.stringify({ memberId }),
  });
}

export async function removeRoomMember(roomId: string, memberId: string): Promise<Room> {
  return apiFetch(`/api/rooms/${roomId}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
}
