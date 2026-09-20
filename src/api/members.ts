import { archiveMember, createMember, updateMember } from "../app/member-actions.js";
import { readMemberProfile, InvalidProfileError } from "../member/profile.js";
/**
 * 0.20 Members / Contacts / DM REST surface (WS-A).
 * Contract §2.1 / §2.2 partial (global member ids on rooms stamped by migration).
 */
import { addRoute, HttpError, sendJson, parseBody } from "./http.js";
import { listMemberIdentityDirectory, listMembers, getMember, MemberNameTakenError, MemberNotFoundError, type MemberRecord } from "../member/identity.js";
import { getMcpServerNames, readMcpStatusCache, readMemberMcpConfig } from "../member/mcp.js";
import { listMemberExtensions } from "../member/extensions.js";
import { listMemberSkills } from "../member/skills.js";
import { readWorkspaces } from "../member/workspaces.js";
import { readMemberSshPublicKey } from "../member/workspaces.js";
import { assertMemberScopeAccess } from "../chat/conversations.js";
import { getMemberActiveScopes } from "../agent/controls.js";
import * as roomStore from "../chat/conversations.js";

function publicMember(m: MemberRecord, live = false) {
  const base = { memberId: m.id, id: m.id, name: m.name, title: m.title ?? null, agentTemplate: m.agentTemplate,
    global: m.global, createdAt: m.createdAt, updatedAt: m.updatedAt };
  if (!live) return base;
  const activeScopes = [
    `dm:${m.id}`,
    ...roomStore.listRoomsForMember(m.id).map(room => `room:${room.id}`),
    ...roomStore.listMmScopesForMember(m.id),
  ];
  const workingScopes = getMemberActiveScopes(m.id);
  return { ...base, status: workingScopes.length ? "working" : "idle",
    activeScopes, workingScopes, model: m.global.model ?? null,
    contextPct: null, tokensToday: 0, tokensTotal: 0 };
}

function requireMember(id: string): MemberRecord {
  const member = getMember(id);
  if (!member) throw new HttpError(404, "not_found", "Member not found");
  return member;
}
function errCode(err: unknown): { status: number; error: string; message: string } {
  if (err instanceof HttpError) return { status: err.status, error: err.code, message: err.message };
  if (err instanceof InvalidProfileError) return { status: 400, error: err.code, message: err.message };
  if (err instanceof MemberNameTakenError) {
    return { status: 409, error: "name_taken", message: err.message };
  }
  if (err instanceof MemberNotFoundError) {
    return { status: 404, error: "not_found", message: err.message };
  }
  const msg = String((err as any)?.message || err);
  if (msg === "confirm_required") return { status: 400, error: "confirm_required", message: "confirm: true required" };
  if (msg === "reserved_member_name") return { status: 400, error: msg, message: "all, user and system are reserved for group mentions, the human user and system messages." };
  if (msg === "invalid_member_name") return { status: 400, error: "invalid_member_name", message: msg };
  if (msg === "invalid_model") return { status: 400, error: msg, message: "model must be a non-empty model reference; omit the field to leave it unchanged" };
  if (msg === "invalid_binding") return { status: 400, error: msg, message: "A complete model + credentialId pair is required (model cannot be paired with an empty credential)." };
  if ((err as { name?: string })?.name === "MemberModelSwitchConflictError") return { status: 409, error: "switch_in_progress", message: msg };
  if (msg === "scope_not_found") return { status: 400, error: "scope_not_found", message: msg };
  if (msg === "archive_not_found") return { status: 404, error: "archive_not_found", message: msg };
  return { status: 500, error: "internal", message: msg };
}
function memberError(error: unknown): never {
  const mapped = errCode(error);
  throw new HttpError(mapped.status, mapped.error, mapped.message);
}

// ── Members CRUD ──

addRoute("GET", "/api/members", async (_req, res) => {
  sendJson(res, 200, { members: listMembers().map(member => publicMember(member, true)) });
});

/** Retained id/name directory for projecting historical message authors. */
addRoute("GET", "/api/members/identities", async (_req, res) => {
  sendJson(res, 200, { members: listMemberIdentityDirectory() });
});

addRoute("POST", "/api/members", async (req, res) => {
  try {
    const body = (await parseBody(req)) as {
      name?: string;
      model?: string | null;
      credentialId?: string | null;
      thinkingLevel?: string | null;
      skills?: string[];
      mcpServers?: string[];
    };
    // Batch-1 one-click create: name optional → "New Member" (+ suffix).
    const member = createMember({
      name: body.name,
      model: body.model,
      credentialId: body.credentialId,
      thinkingLevel: body.thinkingLevel,
      skills: body.skills,
      mcpServers: body.mcpServers,
      title: (body as { title?: string }).title,
    });
    sendJson(res, 200, { member: publicMember(member) });
  } catch (error) { memberError(error); }
});

addRoute("GET", "/api/members/:id", async (_req, res, params) => {
  const m = requireMember(params.id);
  sendJson(res, 200, { member: publicMember(m) });
});

export type MemberSystemPromptRead =
  | { available: true; text: string; contractFingerprint: string }
  | { available: false; reason: "instance_not_running" };
export interface MemberHttpActions {
  readCurrentPrompt(memberId: string): Promise<MemberSystemPromptRead> | MemberSystemPromptRead;
  readStats(memberId: string): unknown;
  readTokenTotal(memberId: string, sourceRef?: string): number;
  readActivity(memberId: string, options: { sourceRef?: string; beforeSeq?: number; limit?: number; types?: string[] }): unknown;
  stop(memberId: string): Promise<unknown> | unknown;
  compact(memberId: string): Promise<unknown> | unknown;
  reset(memberId: string): Promise<unknown> | unknown;
  restart(memberId: string): Promise<unknown> | unknown;
}
let memberHttpActions: MemberHttpActions | undefined;
export function connectMemberHttpActions(actions: MemberHttpActions): () => void {
  memberHttpActions = actions;
  return () => { if (memberHttpActions === actions) memberHttpActions = undefined; };
}
function connectedMemberActions(): MemberHttpActions {
  if (!memberHttpActions) throw new Error("Member HTTP actions are not connected");
  return memberHttpActions;
}

/** Current SDK system prompt; a member without a live instance is a normal empty state. */
addRoute("GET", "/api/members/:id/system-prompt", async (req, res, params) => {
  try {
    const sourceRef = sourceQuery(req);
    const member = authorizedMember(params.id, sourceRef);
    const prompt = await connectedMemberActions().readCurrentPrompt(member.id);
    if (!prompt.available) {
      sendJson(res, 200, { available: false, reason: prompt.reason, scopeId: sourceRef ?? null });
      return;
    }
    sendJson(res, 200, {
      available: true,
      text: prompt.text,
      charCount: prompt.text.length,
      scopeId: sourceRef ?? null,
      contractFingerprint: prompt.contractFingerprint,
    });
  } catch (error) { memberError(error); }
});

addRoute("PATCH", "/api/members/:id", async (request, response, params) => {
  let switchRequested = false;
  try {
    const body = await parseBody(request) as {
      name?: string; title?: string | null; model?: string | null; credentialId?: string | null;
      thinkingLevel?: string | null; skills?: string[]; mcpServers?: string[];
    };
    switchRequested = body.model !== undefined || body.credentialId !== undefined;
    const result = await updateMember(params.id, body);
    sendJson(response, 200, { member: publicMember(result.member) });
  } catch (error) {
    const mapped = errCode(error);
    if (switchRequested && mapped.status === 500) throw new HttpError(400, "model_switch_failed", mapped.message);
    memberError(error);
  }
});

addRoute("DELETE", "/api/members/:id", async (req, res, params) => {
  try {
    const body = (await parseBody(req)) as { confirm?: boolean };
    const m = requireMember(params.id);
    const result = await archiveMember(m.id, { confirm: !!body.confirm });
    sendJson(res, 200, result);
  } catch (error) { memberError(error); }
});

addRoute("GET", "/api/members/:id/scopes", async (_req, res, params) => {
  const m = requireMember(params.id);
  const scopes: Array<{ scopeId: string; kind: string; label: string; status: string; lastActiveAt: number | null }> = [
    { scopeId: `dm:${m.id}`, kind: "dm", label: "Direct message", status: "idle", lastActiveAt: null },
  ];
  for (const room of roomStore.listRoomsForMember(m.id)) scopes.push({
    scopeId: `room:${room.id}`, kind: "room", label: room.name,
    status: "idle", lastActiveAt: null,
  });
  for (const scopeId of roomStore.listMmScopesForMember(m.id)) {
    const peerId = roomStore.parseMmScopeId(scopeId)?.find(id => id !== m.id);
    scopes.push({
      scopeId, kind: "mm", label: `Private chat with ${peerId ? getMember(peerId)?.name ?? peerId : "member"}`,
      status: "idle", lastActiveAt: null,
    });
  }
  sendJson(res, 200, { scopes });
});

/** persona.md read-only panel surface (identity batch-2 / designer contract). */
addRoute("GET", "/api/members/:id/profile", async (_req, res, params) => {
  try {
    const m = requireMember(params.id);
    const profile = readMemberProfile(m.id);
    sendJson(res, 200, {
      path: profile.path,
      body: profile.body,
      charCount: profile.body.length,
      overBudget: profile.overBudget,
      exists: profile.exists,
    });
  } catch (error) { memberError(error); }
});

/** Batch 6 §4 read outlet: member-owned asset inventory (designer's Assets tab).
 * mcpServers come from the member's own mcp.json (toolCount only when the
 * availability cache has one — counting tools requires a live connection);
 * extensions use the runtime discovery rules; skills come from the member folder. */
addRoute("GET", "/api/members/:id/assets", async (_req, res, params) => {
  const m = requireMember(params.id);
  const config = readMemberMcpConfig(m.id);
  const names = config ? getMcpServerNames(config) : [];
  let cache: Record<string, { toolCount?: number }> = {};
  try {
    cache = readMcpStatusCache() as Record<string, { toolCount?: number }>;
  } catch {
    cache = {};
  }
  const mcpServers = names.map((name) => ({
    name,
    toolCount: typeof cache[name]?.toolCount === "number" ? cache[name].toolCount : null,
  }));

  const extensions = listMemberExtensions(m.id);

  const skills = listMemberSkills(m.id)
    .filter((s) => !s.platform)
    .map((s) => ({ name: s.name, path: s.path, description: s.description }));

  const wsRegistry = readWorkspaces(m.id);
  const active = wsRegistry.active;
  const workspaces = wsRegistry.workspaces.map((w) => ({
    id: w.id,
    kind: w.kind,
    description: w.description,
    root: w.root,
    active: w.id === active,
    ...(w.kind === "ssh" ? { host: w.host, user: w.user } : {}),
  }));
  const sshPublicKey = readMemberSshPublicKey(m.id);

  sendJson(res, 200, { mcpServers, extensions, skills, workspaces, sshPublicKey });
});

/** Member skills/ directory list (reuses skill-catalog scan rules). */
addRoute("GET", "/api/members/:id/skills", async (_req, res, params) => {
  try {
    const m = requireMember(params.id);
    sendJson(res, 200, { skills: listMemberSkills(m.id) });
  } catch (error) { memberError(error); }
});

// ── Member runtime reads and controls (member-owned; source is an optional filter) ──

function sourceQuery(request: { url?: string }): string | undefined {
  return new URL(request.url || "", "http://localhost").searchParams.get("scope") || undefined;
}
function authorizedMember(memberId: string, sourceRef?: string): MemberRecord {
  const member = requireMember(memberId);
  if (sourceRef) {
    try { assertMemberScopeAccess(member.id, sourceRef); }
    catch (error) { invalidScope(error); }
  }
  return member;
}
function invalidScope(error: unknown): never {
  if (error instanceof HttpError) throw error;
  throw new HttpError(400, "invalid_scope", error instanceof Error ? error.message : String(error));
}

addRoute("GET", "/api/members/:id/token-usage", async (request, response, params) => {
  try {
    const sourceRef = sourceQuery(request);
    const member = authorizedMember(params.id, sourceRef);
    sendJson(response, 200, { totalTokens: connectedMemberActions().readTokenTotal(member.id, sourceRef) });
  } catch (error) { invalidScope(error); }
});
addRoute("GET", "/api/members/:id/stats", async (request, response, params) => {
  try {
    const sourceRef = sourceQuery(request);
    const member = authorizedMember(params.id, sourceRef);
    sendJson(response, 200, connectedMemberActions().readStats(member.id));
  } catch (error) { invalidScope(error); }
});
addRoute("GET", "/api/members/:id/events", async (request, response, params) => {
  try {
    const sourceRef = sourceQuery(request);
    const member = authorizedMember(params.id, sourceRef);
    const url = new URL(request.url || "", "http://localhost");
    const beforeSeq = url.searchParams.has("beforeSeq") ? Number(url.searchParams.get("beforeSeq")) : undefined;
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 500));
    const types = url.searchParams.get("types")?.split(",").map((value) => value.trim()).filter(Boolean);
    sendJson(response, 200, connectedMemberActions().readActivity(member.id, { sourceRef, beforeSeq, limit, types }));
  } catch (error) { invalidScope(error); }
});
for (const action of ["stop", "compact", "reset", "restart"] as const) {
  addRoute("POST", `/api/members/:id/${action}`, async (_request, response, params) => {
    const member = requireMember(params.id);
    try { sendJson(response, 200, await connectedMemberActions()[action](member.id)); }
    catch (error) { sendJson(response, 400, { error: `${action}_failed`, message: error instanceof Error ? error.message : String(error) }); }
  });
}
