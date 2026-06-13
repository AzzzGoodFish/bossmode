const BASE_URL = "";

let authToken: string | null = localStorage.getItem("bossmode_token");

export function setToken(token: string): void {
  authToken = token;
  localStorage.setItem("bossmode_token", token);
}

export function clearToken(): void {
  authToken = null;
  localStorage.removeItem("bossmode_token");
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
  return result;
}

// -- Agents --

export interface AgentInfo {
  name: string;
  model: string;
  description: string;
  skills: string[];
  tags: string[];
  avatar?: string;
}

export interface AgentDetail extends AgentInfo {
  systemPrompt: string;
}

export async function getAgents(): Promise<AgentInfo[]> {
  return apiFetch("/api/agents");
}

export async function getAgent(name: string): Promise<AgentDetail> {
  return apiFetch(`/api/agents/${name}`);
}

export async function createAgent(name: string, content: string): Promise<AgentDetail> {
  return apiFetch("/api/agents", { method: "POST", body: JSON.stringify({ name, content }) });
}

export async function updateAgent(name: string, content: string): Promise<AgentDetail> {
  return apiFetch(`/api/agents/${name}`, { method: "PUT", body: JSON.stringify({ content }) });
}

export async function deleteAgent(name: string): Promise<void> {
  await apiFetch(`/api/agents/${name}`, { method: "DELETE" });
}

export async function getAgentTemplates(): Promise<AgentInfo[]> {
  return apiFetch("/api/agents/templates");
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
  model?: string | null;
  runtime?: "pi-cli";
  thinkingLevel: string;
  avatar?: string;
  contextLimit?: number;
  credentialId?: string | null;
}

export async function getMembers(): Promise<MemberInfo[]> {
  return apiFetch("/api/members");
}

export async function getMember(id: string): Promise<MemberInfo> {
  return apiFetch(`/api/members/${id}`);
}

export async function createMember(data: Omit<MemberInfo, "id">): Promise<MemberInfo> {
  return apiFetch("/api/members", { method: "POST", body: JSON.stringify(data) });
}

export async function updateMember(id: string, data: Partial<MemberInfo>): Promise<MemberInfo> {
  return apiFetch(`/api/members/${id}`, { method: "PUT", body: JSON.stringify(data) });
}

export async function deleteMemberApi(id: string): Promise<void> {
  await apiFetch(`/api/members/${id}`, { method: "DELETE" });
}

export async function getMemberTokenUsage(id: string): Promise<{ totalTokens: number }> {
  return apiFetch(`/api/members/${id}/token-usage`);
}

export interface AgentRuntimeParams {
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  skills?: string[];
  extensions?: string[];
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

export async function restartMember(id: string, roomId: string): Promise<void> {
  await apiFetch(`/api/members/${id}/restart?roomId=${roomId}`, { method: "POST" });
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

export async function refreshModelCredentialProfileModels(id: string): Promise<PublicModelCredentialProfile> {
  return apiFetch(`/api/model-credential-profiles/${id}/refresh-models`, { method: "POST" });
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

export interface Room {
  id: string;
  name: string;
  cwd: string;
  members: string[];
  createdAt: number;
  /** Document paths injected into agents' system prompts as rules. */
  ruleDocs?: string[];
  agentStatuses?: Record<string, string>;
}

export async function getRooms(): Promise<Room[]> {
  return apiFetch("/api/rooms");
}

export async function createRoom(
  name: string,
  cwd: string,
  members: string[],
  ruleDocs?: string[],
): Promise<Room> {
  return apiFetch("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name, cwd, members, ruleDocs }),
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
  patch: { name?: string; cwd?: string; ruleDocs?: string[] },
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

// -- Messages --

export interface SummaryMeta {
  title: string;
  covered_range: {
    from_id: string;
    to_id: string;
    count: number;
  };
  time_range: {
    from: number;
    to: number;
  };
  participants: string[];
}

export interface TaskEventMeta {
  action: "created" | "updated" | "status_changed" | "commented" | "deleted";
  taskId: string;
  taskTitle: string;
  newStatus?: string;
  actor: string;
  snippet?: string;
}

export interface KnowledgeEventMeta {
  path: string;
  title: string;
  actor: string;
  tool: "write" | "edit";
}

export type GateStatus = "pending" | "approved" | "rejected";

export interface Gate {
  id: string;
  roomId: string;
  title: string;
  summary: string;
  artifacts: string[];
  requestedBy: string;
  handoffTo?: string;
  status: GateStatus;
  decisionNote?: string;
  createdAt: number;
  decidedAt?: number;
}

export interface GateEventMeta {
  action: "requested" | "approved" | "rejected";
  gateId: string;
  gateTitle: string;
  requestedBy: string;
  handoffTo?: string;
  summary?: string;
  artifacts?: string[];
  decisionNote?: string;
}

export async function decideGate(
  roomId: string,
  gateId: string,
  action: "approve" | "reject",
  note?: string,
): Promise<Gate> {
  return apiFetch(`/api/rooms/${roomId}/gates/${gateId}/decision`, {
    method: "POST",
    body: JSON.stringify({ action, note }),
  });
}

export interface RoomMessage {
  id: string;
  sender: string;
  content: string;
  mentions: string[];
  ts: number;
  type?: "summary" | "task_event" | "knowledge_event" | "gate_event";
  summary_meta?: SummaryMeta;
  task_event_meta?: TaskEventMeta;
  knowledge_event_meta?: KnowledgeEventMeta;
  gate_event_meta?: GateEventMeta;
}

export interface MessageSearchResult {
  total: number;
  messages: RoomMessage[];
}

export async function searchMessages(
  roomId: string,
  opts: { query?: string; from?: string; after?: number; before?: number; limit?: number; offset?: number },
): Promise<MessageSearchResult> {
  const qs = new URLSearchParams();
  if (opts.query) qs.set("query", opts.query);
  if (opts.from) qs.set("from", opts.from);
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
): Promise<RoomMessage> {
  return apiFetch(`/api/rooms/${roomId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export async function addMember(roomId: string, agent: string): Promise<Room> {
  return apiFetch(`/api/rooms/${roomId}/members`, {
    method: "POST",
    body: JSON.stringify({ agent }),
  });
}

// -- Private Chat / Steer --

export async function steerAgent(
  roomId: string,
  agentName: string,
  content: string,
): Promise<void> {
  await apiFetch(`/api/rooms/${roomId}/agents/${agentName}/steer`, {
    method: "POST",
    body: JSON.stringify({ content }),
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

export async function abortAgent(roomId: string, agentName: string): Promise<{ ok: boolean; action: string }> {
  return apiFetch(`/api/rooms/${roomId}/agents/${agentName}/abort`, { method: "POST" });
}

// -- Context Usage --

export interface ContextUsageData {
  supported: boolean;
  unavailable?: boolean;
  totalTokens?: number;
  rawMaxTokens?: number;
  percentage?: number;
  model?: string;
}

export async function getAgentContextUsage(roomId: string, agentName: string): Promise<ContextUsageData> {
  return apiFetch(`/api/rooms/${roomId}/agents/${agentName}/context-usage`);
}

// -- Attachments --

export interface UploadResult {
  filename: string;
  originalFilename: string;
  path: string;
  size: number;
  url: string;
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

// -- Summarize --

export interface SummarizeStatus {
  available: boolean;
  toSummarize: number;
  toKeep: number;
  isSummarizing: boolean;
}

export async function getSummarizeStatus(roomId: string, keepCount?: number): Promise<SummarizeStatus> {
  const params = keepCount ? `?keepCount=${keepCount}` : "";
  return apiFetch(`/api/rooms/${roomId}/summarize/status${params}`);
}

export async function summarizeRoom(roomId: string, keepCount?: number): Promise<{ ok: boolean; message: string }> {
  return apiFetch(`/api/rooms/${roomId}/summarize`, {
    method: "POST",
    body: JSON.stringify({ keepCount }),
  });
}

export async function getMessageRange(roomId: string, fromId: string, toId: string): Promise<RoomMessage[]> {
  return apiFetch(`/api/rooms/${roomId}/messages/range?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`);
}

// -- Summary Settings --

export interface SummarySettings {
  autoEnabled: boolean;
  threshold: number;
  keepCount: number;
}

export interface RuntimeSettings {
  sessionResume: boolean;
}

export interface TeamUpdateCandidate {
  category: "agent" | "skill" | "rule";
  relativePath: string;
  name: string;
  status: "new" | "updated" | "modified";
}

export interface TeamUpdateCheckResult {
  hasUpdates: boolean;
  currentVersion: string;
  installedVersion: string;
  candidates: TeamUpdateCandidate[];
  dismissed: boolean;
}

export interface TeamUpdateSettings {
  dismissPermanent: boolean;
  installedVersion: string;
}

export async function getSummarySettings(): Promise<SummarySettings> {
  return apiFetch("/api/settings/summary");
}

export async function updateSummarySettings(settings: Partial<SummarySettings>): Promise<SummarySettings> {
  return apiFetch("/api/settings/summary", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  return apiFetch("/api/settings/runtime");
}

export async function updateRuntimeSettings(sessionResume: boolean): Promise<RuntimeSettings> {
  return apiFetch("/api/settings/runtime", {
    method: "PUT",
    body: JSON.stringify({ sessionResume }),
  });
}

export interface LinearIntegrationStatus {
  connected: boolean;
  viewer?: { id: string; name: string };
  error?: string;
}

export async function getLinearIntegrationStatus(): Promise<LinearIntegrationStatus> {
  return apiFetch("/api/integrations/linear");
}

export async function connectLinearIntegration(apiKey: string): Promise<LinearIntegrationStatus> {
  return apiFetch("/api/integrations/linear", { method: "PUT", body: JSON.stringify({ apiKey }) });
}

export async function disconnectLinearIntegration(): Promise<{ ok: true; clearedRooms: number }> {
  return apiFetch("/api/integrations/linear", { method: "DELETE" });
}

// -- Tasks --

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
  assignee?: string;
  description?: string;
  references?: string[];
  subscribers?: string[];
  comments?: TaskComment[];
  commentCount?: number;
  linearIssueId?: string;
  linearIssueUrl?: string;
  linearIssueIdentifier?: string;
  linearSyncedAt?: number;
  linearSyncError?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Only present in listAllTasks results */
  roomName?: string;
}

export async function listAllTasks(opts: { status?: TaskStatus; query?: string } = {}): Promise<Task[]> {
  const qs = new URLSearchParams();
  if (opts.status) qs.set("status", opts.status);
  if (opts.query) qs.set("query", opts.query);
  return apiFetch(`/api/tasks${qs.toString() ? `?${qs}` : ""}`);
}

export async function listRoomTasks(roomId: string): Promise<Task[]> {
  return apiFetch(`/api/rooms/${roomId}/tasks`);
}

export async function getTask(roomId: string, taskId: string): Promise<Task> {
  return apiFetch(`/api/rooms/${roomId}/tasks/${taskId}`);
}

export async function createTask(
  roomId: string,
  input: { title: string; createdBy: string; status?: TaskStatus; priority?: TaskPriority; assignee?: string; description?: string; references?: string[]; subscribers?: string[] },
): Promise<Task> {
  return apiFetch(`/api/rooms/${roomId}/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export async function updateTask(
  roomId: string,
  taskId: string,
  patch: { title?: string; status?: TaskStatus; priority?: TaskPriority; assignee?: string | null; description?: string; references?: string[]; subscribers?: string[]; updatedBy?: string },
): Promise<Task> {
  return apiFetch(`/api/rooms/${roomId}/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export async function commentTask(
  roomId: string,
  taskId: string,
  input: { author: string; comment: string },
): Promise<Task> {
  return apiFetch(`/api/rooms/${roomId}/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify(input) });
}

export async function deleteTaskApi(roomId: string, taskId: string, deletedBy?: string): Promise<void> {
  await apiFetch(`/api/rooms/${roomId}/tasks/${taskId}`, { method: "DELETE", body: JSON.stringify({ deletedBy }) });
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

// -- Built-in Team Updates --

export async function checkTeamUpdates(): Promise<TeamUpdateCheckResult> {
  return apiFetch("/api/team-updates/check");
}

export async function applyTeamUpdates(paths: string[]): Promise<{ applied: string[]; skipped: string[]; errors: string[] }> {
  return apiFetch("/api/team-updates/apply", {
    method: "POST",
    body: JSON.stringify({ paths }),
  });
}

export async function dismissTeamUpdate(type: "version" | "permanent", version?: string): Promise<void> {
  await apiFetch("/api/team-updates/dismiss", {
    method: "POST",
    body: JSON.stringify({ type, version }),
  });
}

export async function getTeamUpdateSettings(): Promise<TeamUpdateSettings> {
  return apiFetch("/api/team-updates/settings");
}

export async function updateTeamUpdateSettings(dismissPermanent: boolean): Promise<TeamUpdateSettings> {
  return apiFetch("/api/team-updates/settings", {
    method: "POST",
    body: JSON.stringify({ dismissPermanent }),
  });
}
