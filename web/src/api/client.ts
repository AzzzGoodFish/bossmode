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

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    onUnauthorized?.();
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(body.error || `HTTP ${res.status}`);
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

export interface TeamSkillSummary {
  name: string;
  description?: string;
  usedBy: string[];
}



// -- Skills --

export interface SkillInfo {
  name: string;
  description: string;
  tags: string[];
}

export interface SkillDetail extends SkillInfo {
  content: string;
}

export async function getSkills(): Promise<SkillInfo[]> {
  return apiFetch("/api/skills");
}

export async function getSkill(name: string): Promise<SkillDetail> {
  return apiFetch(`/api/skills/${name}`);
}

export async function createSkill(name: string, content: string): Promise<SkillDetail> {
  return apiFetch("/api/skills", { method: "POST", body: JSON.stringify({ name, content }) });
}

export async function updateSkill(name: string, content: string): Promise<SkillDetail> {
  return apiFetch(`/api/skills/${name}`, { method: "PUT", body: JSON.stringify({ content }) });
}

export async function deleteSkill(name: string): Promise<void> {
  await apiFetch(`/api/skills/${name}`, { method: "DELETE" });
}

export async function getSkillTemplates(): Promise<SkillInfo[]> {
  return apiFetch("/api/skills/templates");
}

// -- Members --

export interface MemberInfo {
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

export async function getMember(id: string): Promise<MemberInfo> {
  return apiFetch(`/api/members/${id}`);
}

export async function createMember(data: Omit<MemberInfo, "id">): Promise<MemberInfo> {
  return apiFetch("/api/members", { method: "POST", body: JSON.stringify(data) });
}


export async function getRoomMembers(roomId: string): Promise<MemberInfo[]> {
  return apiFetch(`/api/rooms/${roomId}/members`);
}


export async function deleteMemberApi(id: string): Promise<void> {
  await apiFetch(`/api/members/${id}`, { method: "DELETE" });
}

export async function getMemberTokenUsage(id: string, roomId?: string): Promise<{ totalTokens: number }> {
  const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
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
  return apiFetch(`/api/members/${id}/stats?roomId=${encodeURIComponent(roomId)}`);
}

export interface AgentRuntimeParams {
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  skills?: string[];
}

export interface MemberInstanceInfo {
  roomId: string;
  roomName: string;
  status: "idle" | "working";
  runtime: string;
  runtimeParams?: AgentRuntimeParams;
  pid?: number;
  spawnArgs?: string[];
}

export async function getMemberStatus(id: string): Promise<{ instances: MemberInstanceInfo[] }> {
  return apiFetch(`/api/members/${id}/status`);
}

export async function restartMember(id: string, roomId?: string): Promise<void> {
  void roomId;
  // ① B5: member-level restart — the old room query is ignored.
  await memberAction(id, "restart");
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

export interface RefreshModelCredentialProfileResult {
  profile: PublicModelCredentialProfile;
  catalogSource: "remote" | "bundled";
  catalogMessage?: string;
}

export async function refreshModelCredentialProfileModels(id: string): Promise<RefreshModelCredentialProfileResult> {
  return apiFetch(`/api/model-credential-profiles/${id}/refresh-models`, { method: "POST" });
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

export async function startOAuthLoginJob(data: { profileId?: string; profile?: Partial<ModelCredentialProfileInput>; providerId?: string }): Promise<OAuthLoginJob> {
  return apiFetch("/api/model-credential-profiles/oauth-login/start", { method: "POST", body: JSON.stringify(data) });
}

export async function getOAuthConnectionJob(id: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth/${id}`);
}

export async function getOAuthLoginJob(id: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth-login/${id}`);
}

export async function submitOAuthConnectionInput(id: string, code: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth/${id}/input`, { method: "POST", body: JSON.stringify({ code }) });
}

export async function submitOAuthLoginJobInput(id: string, code: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth-login/${id}/input`, { method: "POST", body: JSON.stringify({ code }) });
}

export async function cancelOAuthConnection(id: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth/${id}/cancel`, { method: "POST" });
}

export async function cancelOAuthLoginJob(id: string): Promise<OAuthLoginJob> {
  return apiFetch(`/api/model-credential-profiles/oauth-login/${id}/cancel`, { method: "POST" });
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

/** Document summary from the list endpoint (no content). */
export interface KnowledgeEntryInfo {
  /** Document path, e.g. "bossmode/architecture/overview.md". Acts as the stable ID. */
  id: string;
  title: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** Full document returned from read/update endpoints. */
export interface KnowledgeEntry extends KnowledgeEntryInfo {
  content: string;
}

/** Directory tree node for the file-explorer UI. */
export interface KnowledgeTreeNode {
  path: string;
  name: string;
  kind: "file" | "folder";
  title?: string;
  children?: KnowledgeTreeNode[];
}

export async function getKnowledgeEntries(): Promise<KnowledgeEntryInfo[]> {
  return apiFetch(`/api/knowledge/entries`);
}

export async function getKnowledgeTree(): Promise<KnowledgeTreeNode> {
  return apiFetch(`/api/knowledge/tree`);
}

export async function getKnowledgeEntry(path: string): Promise<KnowledgeEntry> {
  return apiFetch(`/api/knowledge/entry?path=${encodeURIComponent(path)}`);
}

async function apiFetchBlob(path: string): Promise<Blob> {
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

export async function getKnowledgeRawBlob(path: string): Promise<Blob> {
  return apiFetchBlob(`/api/knowledge/raw?path=${encodeURIComponent(path)}`);
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
  return apiFetch(`/api/rooms/${roomId}/attachments/${encodeURIComponent(filename)}/preview`);
}

export async function getArtifactRawBlob(roomId: string, path: string): Promise<Blob> {
  return apiFetchBlob(`/api/rooms/${roomId}/artifact-raw?path=${encodeURIComponent(path)}`);
}

export async function getAttachmentRawBlob(roomId: string, filename: string): Promise<Blob> {
  return apiFetchBlob(`/api/rooms/${roomId}/attachments/${encodeURIComponent(filename)}`);
}

export async function addKnowledgeEntry(
  title: string, content: string, path?: string,
): Promise<KnowledgeEntry> {
  return apiFetch(`/api/knowledge/entries`, {
    method: "POST",
    body: JSON.stringify({ title, content, path }),
  });
}

export async function updateKnowledgeEntry(
  path: string, title: string, content: string,
): Promise<KnowledgeEntry> {
  return apiFetch(`/api/knowledge/entry?path=${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify({ title, content }),
  });
}

export async function uploadKnowledgePng(path: string, file: File): Promise<KnowledgeEntry> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return apiFetch(`/api/knowledge/upload`, {
    method: "POST",
    body: JSON.stringify({ path, contentType: file.type || "image/png", dataBase64: btoa(binary) }),
  });
}

export async function deleteKnowledgeEntry(path: string): Promise<void> {
  await apiFetch(`/api/knowledge/entry?path=${encodeURIComponent(path)}`, { method: "DELETE" });
}

export interface MoveKnowledgeResult {
  ok: boolean;
  from: string;
  to: string;
  type: "file" | "folder";
}

export async function moveKnowledgeEntry(from: string, to: string): Promise<MoveKnowledgeResult> {
  return apiFetch(`/api/knowledge/move`, {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

export async function deleteKnowledgeFolder(path: string): Promise<void> {
  await apiFetch(`/api/knowledge/entry?path=${encodeURIComponent(path)}`, { method: "DELETE" });
}

export async function batchMoveKnowledge(paths: string[], destination: string): Promise<{ moved: number; failed: string[] }> {
  return apiFetch(`/api/knowledge/batch-move`, {
    method: "POST",
    body: JSON.stringify({ paths, destination }),
  });
}

export async function batchDeleteKnowledge(paths: string[]): Promise<{ deleted: number; failed: string[] }> {
  return apiFetch(`/api/knowledge/batch-delete`, {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
}

// -- Rooms --

export interface RoomMemberRecord {
  id: string;
  roomId?: string;
  name: string;
  sourceAgent: string;
  sourceMemberId?: string;
  avatar?: string;
  config?: {
    model?: string;
    credentialId?: string;
    thinkingLevel?: string;
    contextLimit?: number;
    skills?: string[];
    mcpServers?: string[];
  };
  createdAt: number;
  updatedAt: number;
}

export interface Room {
  id: string;
  name: string;
  /** ⑤: room description — shown in chat_info / the room settings dialog. */
  description?: string;
  cwd: string;
  members: string[];
  /** 0.20: authoritative member composition — join via useGlobalMembers(). */
  globalMemberIds?: string[];
  promptLeaderMemberId?: string;
  docsPath?: string;
  createdAt: number;
  /** Legacy. No longer injected into prompts or shown in Room Settings. */
  ruleDocs?: string[];
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

export async function updateRoomBindings(
  id: string,
  patch: { ruleDocs?: string[] },
): Promise<Room> {
  return apiFetch(`/api/rooms/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function updateRoomSettings(
  id: string,
  patch: { name?: string; description?: string | null; ruleDocs?: string[]; promptLeaderMemberId?: string | null; docsPath?: string | null },
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

export async function renameRoom(id: string, name: string): Promise<Room> {
  return apiFetch(`/api/rooms/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
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

export async function getMemberActiveTools(roomId: string, memberRef: string): Promise<MemberActiveToolsResponse> {
  return apiFetch(`/api/rooms/${roomId}/members/${encodeURIComponent(memberRef)}/tools`);
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
  const result = await apiFetch<{members: MemberIdentity[]}>("/api/members/identities", {signal});
  if (!Array.isArray(result.members)) throw new Error("Invalid member identity response");
  return result.members;
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

export interface MessageSearchResult {
  total: number;
  messages: RoomMessage[];
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
  return apiFetch(`/api/rooms/${roomId}/messages/search?${qs}`);
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
  return apiFetch(`/api/rooms/${roomId}/messages${qs ? `?${qs}` : ""}`);
}

export async function sendMessage(
  roomId: string,
  content: string,
  attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>,
  replyTo?: { seq: number },
): Promise<RoomMessage> {
  return apiFetch(`/api/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content, attachments, ...(replyTo ? { replyTo } : {}) }),
  });
}

export async function resetAgentSession(
  roomId: string,
  agentName: string,
): Promise<{ ok: true; message: string }> {
  return apiFetch(`/api/rooms/${roomId}/agents/${agentName}/reset-session`, {
    method: "POST",
  });
}

// ── Mount-stale info ──

export interface StaleInfo {
  mounts?: { since: number; fields: string[] };
  contract?: boolean;
}

export async function getAgentEvents(roomId: string, agentName: string): Promise<unknown[]> {
  return apiFetch(`/api/rooms/${roomId}/agents/${agentName}/events`);
}

export interface PaginatedEvents {
  events: unknown[];
  total: number;
  hasMore: boolean;
}

export async function getAgentEventsPaginated(roomId: string, agentName: string, limit: number, before?: number): Promise<PaginatedEvents> {
  const params = before !== undefined ? `?limit=${limit}&before=${before}` : `?limit=${limit}`;
  return apiFetch(`/api/rooms/${roomId}/agents/${agentName}/events${params}`);
}

/** Scope-addressed events (dm:<id> / room:<id>). */
export async function getConversationEvents(scopeId: string, member: string, limit: number, before?: number): Promise<PaginatedEvents> {
  const qs = new URLSearchParams({ member, limit: String(limit) });
  if (before !== undefined) qs.set("before", String(before));
  return apiFetch(`/api/conversations/${encodeURIComponent(scopeId)}/events?${qs}`);
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
  const qs = new URLSearchParams({ limit: String(limit) });
  if (beforeSeq !== undefined) qs.set("beforeSeq", String(beforeSeq));
  if (types && types.length) qs.set("types", types.join(","));
  return apiFetch(`/api/rooms/${roomId}/members/${encodeURIComponent(ref)}/events?${qs}`);
}

/** ① B5: stop/compact/reset/restart target the member directly — no chat scope
 *  in the interface; the same call works from any chat or the member panel. */
export async function memberAction(
  memberId: string,
  action: "abort" | "compact" | "reset" | "restart",
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
}

export async function getAgentContextUsage(roomId: string, agentName: string): Promise<ContextUsageData> {
  return apiFetch(`/api/rooms/${roomId}/agents/${agentName}/context-usage`);
}

// -- Attachments --

export interface UploadResult {
  filename: string;
  originalFilename: string;
  /** Stored filename, kept as `path` for legacy caller compatibility. Never an absolute path. */
  path: string;
  size: number;
  url: string;
  previewType?: AttachmentPreviewType;
}

export async function uploadFile(roomId: string, file: File): Promise<UploadResult> {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(
    `${BASE_URL}/api/rooms/${roomId}/upload?filename=${encodeURIComponent(file.name)}`,
    { method: "POST", headers, body: file },
  );

  if (res.status === 401) {
    clearToken();
    onUnauthorized?.();
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export type McpAvailabilityStatus = "unchecked" | "checking" | "available" | "unavailable" | "auth-required" | "invalid-config";

export interface McpServerAvailability {
  name: string;
  status: McpAvailabilityStatus;
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

export interface McpSettings {
  enabled: boolean;
  configPath: string;
  configText: string;
  serverCount: number;
  servers?: McpServerSummary[];
  availability?: Record<string, McpServerAvailability>;
  sources?: Array<{ id: string; label: string; path: string; exists: boolean; serverCount: number }>;
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

export async function getMcpSettings(): Promise<McpSettings> {
  return apiFetch("/api/settings/mcp");
}

export async function updateMcpSettings(settings: { enabled?: boolean; configText?: string }): Promise<McpSettings> {
  return apiFetch("/api/settings/mcp", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function checkMcpServers(server?: string, timeoutMs?: number): Promise<McpSettings & { results: McpServerAvailability[] }> {
  return apiFetch("/api/settings/mcp/check", {
    method: "POST",
    body: JSON.stringify({ ...(server ? { server } : {}), ...(timeoutMs ? { timeoutMs } : {}) }),
  });
}


// -- Filesystem --

export interface FsDirEntry {
  name: string;
  path: string;
}

export interface FsListDirsResult {
  path: string;
  parent: string | null;
  segments: FsDirEntry[];
  dirs: FsDirEntry[];
  truncated: boolean;
}

export async function listDirs(path: string): Promise<FsListDirsResult> {
  return apiFetch(`/api/fs/list-dirs?path=${encodeURIComponent(path)}`);
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
  return apiFetch("/api/contacts");
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

/** The member's fully-assembled system prompt for a scope (fish 2026-09-02
 * item 5). Byte-identical to the activation-time injection — same compiler. */
export interface MemberSystemPromptDoc {
  text: string;
  charCount: number;
  scopeId: string;
  contractFingerprint: string;
}

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
  return apiFetch(`/api/dm/${encodeURIComponent(memberId)}/messages${qs ? `?${qs}` : ""}`);
}

export async function sendDmMessage(
  memberId: string,
  text: string,
  attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>,
  replyTo?: { seq: number },
): Promise<DmMessage> {
  const res = await apiFetch<{ message: DmMessage }>(`/api/dm/${encodeURIComponent(memberId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text, ...(attachments?.length ? { attachments } : {}), ...(replyTo ? { replyTo } : {}) }),
  });
  return res.message;
}

export interface DmSession {
  status: string;
  contextPct?: number | null;
  working?: boolean;
}

export async function getDmSession(memberId: string): Promise<DmSession> {
  return apiFetch(`/api/dm/${encodeURIComponent(memberId)}/session`);
}

export interface ChatEntry {
  scopeId: string;
  kind: "dm" | "room";
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


export interface ConversationSessionInfo {
  scopeId: string;
  memberId: string;
  status: string;
  busy: boolean;
  contextPct: number | null;
  contextUsage?: ContextUsageData;
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

export interface ConversationToolsInfo {
  scopeId: string;
  memberId: string;
  live: { sessionActive: boolean; tools: MemberActiveTool[]; message?: string } | null;
  status: string;
}

export async function getConversationTools(scopeId: string, memberId: string): Promise<ConversationToolsInfo> {
  return apiFetch(`/api/conversations/${encodeURIComponent(scopeId)}/tools?memberId=${encodeURIComponent(memberId)}`);
}

export async function conversationMemberAction(
  scopeId: string,
  memberId: string,
  action: "abort" | "reset-session" | "reload" | "compact",
): Promise<{ ok?: boolean; action?: string; message?: string; reloaded?: boolean }> {
  void scopeId;
  // ① B5: kept as a thin member-level shim for older callers; new code uses
  // memberAction directly.
  if (action === "reset-session") return memberAction(memberId, "reset");
  if (action === "reload") return { ok: false, message: "Reload retired — activation recompiles the latest prompt" };
  return memberAction(memberId, action);
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

export async function removeRoomMember(roomId: string, memberRef: string): Promise<Room> {
  return apiFetch(`/api/rooms/${roomId}/members/${encodeURIComponent(memberRef)}`, { method: "DELETE" });
}
