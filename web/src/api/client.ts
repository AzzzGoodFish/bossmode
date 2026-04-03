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
  model: string;
  runtime: "pi-cli" | "claude-cli";
  thinkingLevel: string;
  avatar?: string;
  contextLimit?: number;
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

export interface MemberInstanceInfo {
  roomId: string;
  roomName: string;
  status: "idle" | "working";
  runtime: string;
  pid?: number;
  spawnArgs?: string;
}

export async function getMemberStatus(id: string): Promise<{ instances: MemberInstanceInfo[] }> {
  return apiFetch(`/api/members/${id}/status`);
}

export async function restartMember(id: string, roomId: string): Promise<void> {
  await apiFetch(`/api/members/${id}/restart?roomId=${roomId}`, { method: "POST" });
}

// -- Runtimes --

export interface RuntimeInfo {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  capabilities: Record<string, boolean>;
}

export async function getRuntimes(): Promise<RuntimeInfo[]> {
  return apiFetch("/api/runtimes");
}

// -- Knowledge --

export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

export interface KnowledgeEntryInfo {
  id: string;
  title: string;
  content: string;
  source: string;
  type: "rule" | "knowledge";
  createdAt: number;
  updatedAt: number;
}

export async function getKnowledgeBases(): Promise<KnowledgeBaseInfo[]> {
  return apiFetch("/api/knowledge");
}

export async function createKnowledgeBase(name: string, description: string): Promise<KnowledgeBaseInfo> {
  return apiFetch("/api/knowledge", { method: "POST", body: JSON.stringify({ name, description }) });
}

export async function deleteKnowledgeBase(id: string): Promise<void> {
  await apiFetch(`/api/knowledge/${id}`, { method: "DELETE" });
}

export async function getKnowledgeEntries(kbId: string): Promise<KnowledgeEntryInfo[]> {
  return apiFetch(`/api/knowledge/${kbId}/entries`);
}

export async function addKnowledgeEntry(kbId: string, title: string, content: string, type: "rule" | "knowledge" = "knowledge"): Promise<KnowledgeEntryInfo> {
  return apiFetch(`/api/knowledge/${kbId}/entries`, { method: "POST", body: JSON.stringify({ title, content, type }) });
}

export async function updateKnowledgeEntry(kbId: string, entryId: string, title: string, content: string): Promise<KnowledgeEntryInfo> {
  return apiFetch(`/api/knowledge/${kbId}/entries/${entryId}`, { method: "PUT", body: JSON.stringify({ title, content }) });
}

export async function deleteKnowledgeEntry(kbId: string, entryId: string): Promise<void> {
  await apiFetch(`/api/knowledge/${kbId}/entries/${entryId}`, { method: "DELETE" });
}

// -- Rooms --

export interface Room {
  id: string;
  name: string;
  cwd: string;
  members: string[];
  createdAt: number;
  knowledgeBaseId?: string;
  ruleIds?: string[];
  agentStatuses?: Record<string, string>;
}

export async function getRooms(): Promise<Room[]> {
  return apiFetch("/api/rooms");
}

export async function createRoom(
  name: string,
  cwd: string,
  members: string[],
  knowledgeBaseId?: string,
  ruleIds?: string[],
): Promise<Room> {
  return apiFetch("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ name, cwd, members, knowledgeBaseId, ruleIds }),
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

export interface RoomMessage {
  id: string;
  sender: string;
  content: string;
  mentions: string[];
  ts: number;
}

export async function getMessages(
  roomId: string,
  opts?: { limit?: number; before?: string },
): Promise<RoomMessage[]> {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.before) params.set("before", opts.before);
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

export async function getAgentEvents(roomId: string, agentName: string): Promise<unknown[]> {
  return apiFetch(`/api/rooms/${roomId}/agents/${agentName}/events`);
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

// -- Archives --

export interface ArchiveInfo {
  timestamp: number;
  summary: string | null;
  archivedCount: number | null;
  range: [string, string] | null;
}

export async function archiveRoom(roomId: string): Promise<{
  archivedCount: number;
  keptCount: number;
  summary: string;
}> {
  return apiFetch(`/api/rooms/${roomId}/archive`, { method: "POST" });
}

export async function getArchives(roomId: string): Promise<ArchiveInfo[]> {
  return apiFetch(`/api/rooms/${roomId}/archives`);
}

export async function getArchiveMessages(
  roomId: string,
  timestamp: number,
): Promise<{ messages: RoomMessage[]; summary: any }> {
  return apiFetch(`/api/rooms/${roomId}/archives/${timestamp}`);
}
