import { activateDmMember, archiveMember, createMember, getMemberActiveScopes, getScopeLiveStatus } from "../app/member-actions.js";
import { readMemberProfile, updateProfileForMember, InvalidProfileError } from "../member/profile.js";
import { memberProfilePath } from "../files/layout.js";
/**
 * 0.20 Members / Contacts / DM REST surface (WS-A).
 * Contract §2.1 / §2.2 partial (global member ids on rooms stamped by migration).
 */
import { addRoute, sendJson, parseBody } from "./http.js";
import { logger } from "../kernel/logger.js";
import { listMembers, listMemberIdentities, getMember, updateMember, resolveMemberRef, getMemberConfiguration, MemberNameTakenError, MemberNotFoundError, type MemberRecord } from "../member/identity.js";
import { getMcpServerNames, readMcpStatusCache, readMemberMcpConfig } from "../member/mcp.js";
import { listMemberExtensions } from "../member/extensions.js";
import {
  deleteSkillDefinition,
  listMemberSkills,
  loadSkillDefinition,
  loadSkillDefinitionsStrict,
  loadSkillTemplates,
  saveSkillDefinition,
} from "../member/skills.js";
import { readWorkspaces } from "../member/workspaces.js";
import { readMemberSshPublicKey } from "../member/workspaces.js";
import { assertMemberScopeAccess, scopeIdOf } from "../chat/conversations.js";
import { switchMemberModel, switchMemberThinkingLevel } from "../agent/controls.js";
import * as roomStore from "../chat/conversations.js";

function publicMember(m: MemberRecord) {
  return {
    memberId: m.id,
    id: m.id,
    name: m.name,
    /** Card field from database (identity batch-1; description retired batch-5). */
    title: m.title ?? null,
    agentTemplate: m.agentTemplate,
    global: m.global,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

function errCode(err: unknown): { status: number; error: string; message: string } {
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
  if (msg === "scope_not_found") return { status: 400, error: "scope_not_found", message: msg };
  if (msg === "archive_not_found") return { status: 404, error: "archive_not_found", message: msg };
  return { status: 500, error: "internal", message: msg };
}

// ── Contacts (directory) ──

addRoute("GET", "/api/contacts", async (_req, res) => {
  try {
    const rooms = roomStore.listRooms();
    const contacts = listMembers().map((m) => {
      const membershipScopes: string[] = [];
      // Membership from globalMemberIds (authority); legacy name match only if no global ids on room
      for (const room of rooms) {
        const inGlobal = room.globalMemberIds?.includes(m.id);
        const inLegacy = (!room.globalMemberIds || room.globalMemberIds.length === 0)
          && roomStore.getRoomMembers(room.id).some((rm) => rm.name === m.name || rm.sourceMemberId === m.id);
        if (inGlobal || inLegacy) membershipScopes.push(scopeIdOf({ kind: "room", roomId: room.id }));
      }
      membershipScopes.unshift(scopeIdOf({ kind: "dm", memberId: m.id }));

      const workingScopes = getMemberActiveScopes(m.id);
      // ① B4: status is member-level — one runtime, one status, every chat.
      const status = getScopeLiveStatus(`dm:${m.id}`) === "working" ? "working" : "idle";

      return {
        memberId: m.id,
        name: m.name,
        /** database title — replaces template chip on Contacts. */
        title: m.title ?? null,
        agentTemplate: m.agentTemplate,
        status,
        activeScopes: membershipScopes,
        workingScopes,
        model: m.global.model ?? null,
        contextPct: null as number | null,
        tokensToday: 0,
        tokensTotal: 0,
      };
    });
    sendJson(res, 200, { contacts });
  } catch (err) {
    logger.error("members-api", "contacts failed", { error: String(err) });
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

// ── Members CRUD ──

addRoute("GET", "/api/members", async (_req, res) => {
  sendJson(res, 200, { members: listMembers().map(publicMember) });
});

addRoute("GET", "/api/members/identities", async (_req, res) => {
  sendJson(res, 200, { members: listMemberIdentities() });
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
    if ("agentTemplate" in body) {
      sendJson(res, 400, { error: "agent_templates_retired", message: "Agent templates are retired; configure the member directly." });
      return;
    }
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
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("GET", "/api/members/:id", async (_req, res, params) => {
  const m = resolveMemberRef(params.id);
  if (!m) {
    sendJson(res, 404, { error: "not_found", message: "Member not found" });
    return;
  }
  sendJson(res, 200, { member: publicMember(m) });
});

export interface MemberHttpActions {
  previewPrompt(memberId: string): { text: string; contractFingerprint: string };
  readStats(memberId: string): unknown;
  readTokenTotal(memberId: string, sourceRef?: string): number;
  readActivity(memberId: string, options: { sourceRef?: string; beforeSeq?: number; limit?: number; types?: string[] }): unknown;
  readStatus(memberId: string): unknown;
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

/** Member prompt preview is member-owned and identical across chat sources. */
addRoute("GET", "/api/members/:id/system-prompt", async (req, res, params) => {
  try {
    const member = resolveMemberRef(params.id);
    if (!member) return sendJson(res, 404, { error: "not_found", message: "Member not found" });
    const sourceRef = new URL(req.url || "", "http://localhost").searchParams.get("scope");
    if (sourceRef) assertMemberScopeAccess(member.id, sourceRef);
    if (!memberHttpActions) throw new Error("Member HTTP actions are not connected");
    const preview = memberHttpActions.previewPrompt(member.id);
    sendJson(res, 200, {
      text: preview.text,
      charCount: preview.text.length,
      scopeId: sourceRef,
      contractFingerprint: preview.contractFingerprint,
    });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("PATCH", "/api/members/:id", async (req, res, params) => {
  try {
    const body = (await parseBody(req)) as {
      name?: string;
      /** database card field (description retired batch-5 — ignored) */
      title?: string | null;
      model?: string | null;
      credentialId?: string | null;
      thinkingLevel?: string | null;
      skills?: string[];
      mcpServers?: string[];
    };
    if ("agentTemplate" in body) {
      sendJson(res, 400, { error: "agent_templates_retired", message: "Agent templates are retired; configure the member directly." });
      return;
    }
    // Single-path model switch (design-model-switch-single-path-v1 §6): the
    // field is either omitted (no change) or a real model ref — null/empty is
    // a parameter error, clearing is not a supported product action.
    if (body.model !== undefined && (body.model === null || !String(body.model).trim())) {
      sendJson(res, 400, { error: "invalid_model", message: "model must be a non-empty model reference; omit the field to leave it unchanged" });
      return;
    }
    let m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const beforeModel = getMemberConfiguration(m.id).model;

    // Model/credential: the one public switch method — validates, applies to
    // every live instance (room+DM) via the SDK, saves config once.
    let modelSwitch: Awaited<ReturnType<typeof switchMemberModel>> | undefined;
    if (body.model !== undefined || body.credentialId !== undefined) {
      const eff = getMemberConfiguration(m.id);
      const targetModel = body.model !== undefined ? String(body.model) : eff.model;
      const targetCred = body.credentialId !== undefined ? (body.credentialId as string | null) : eff.credentialId;
      if (!targetModel || !targetCred) {
        sendJson(res, 400, { error: "invalid_binding", message: "A complete model + credentialId pair is required (model cannot be paired with an empty credential)." });
        return;
      }
      try {
        modelSwitch = await switchMemberModel(m.id, { model: targetModel, credentialId: targetCred });
        // Return the committed record, not the pre-switch object held by this route.
        m = getMember(m.id)!;
      } catch (err: any) {
        if (err && err.name === "MemberModelSwitchConflictError") {
          sendJson(res, 409, { error: "switch_in_progress", message: err.message || String(err) });
        } else {
          sendJson(res, 400, { error: "model_switch_failed", message: err.message || String(err) });
        }
        return;
      }
    }

    let thinkingSwitch: Awaited<ReturnType<typeof switchMemberThinkingLevel>> | undefined;
    if (body.thinkingLevel !== undefined) {
      thinkingSwitch = await switchMemberThinkingLevel(m.id, body.thinkingLevel === null ? "off" : String(body.thinkingLevel));
    }

    if (body.name !== undefined || body.title !== undefined) {
      updateProfileForMember(m.id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.title !== undefined ? { title: body.title === null ? "" : body.title } : {}),
      });
    }
    m = getMember(m.id)!;
    // Non-model fields commit in ONE save, and only when there is something to
    // save — a pure model PATCH must not run a second record write after the
    // switch already committed (an unrelated write failure would wrongly fail
    // the whole request after the switch succeeded).
    const globalPatch: { thinkingLevel?: string; skills?: string[]; mcpServers?: string[] } = {};
    if (body.thinkingLevel !== undefined) globalPatch.thinkingLevel = body.thinkingLevel ?? "off";
    if (body.skills !== undefined) globalPatch.skills = body.skills;
    if (body.mcpServers !== undefined) globalPatch.mcpServers = body.mcpServers;
    if (Object.keys(globalPatch).length > 0) {
      m = updateMember(m.id, {
        global: globalPatch,
      });
    }
    sendJson(res, 200, { member: publicMember(m), ...(modelSwitch ? { modelSwitch } : {}), ...(thinkingSwitch ? { thinkingSwitch } : {}) });

    // Birth wake (identity batch-1): model none→some starts the DM instance so
    // the icebreaker can run. Migrated from the retired /config route.
    const afterModel = modelSwitch?.model || beforeModel;
    if (!beforeModel && afterModel) void activateDmMember(m.id).catch((err) => {
      logger.error("members", "post-config DM activate failed", {
        memberId: m.id,
        error: String((err as Error)?.message || err),
      });
    });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("DELETE", "/api/members/:id", async (req, res, params) => {
  try {
    const body = (await parseBody(req)) as { confirm?: boolean };
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const result = await archiveMember(m.id, { confirm: !!body.confirm });
    sendJson(res, 200, result);
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

addRoute("GET", "/api/members/:id/scopes", async (_req, res, params) => {
  const m = resolveMemberRef(params.id);
  if (!m) {
    sendJson(res, 404, { error: "not_found", message: "Member not found" });
    return;
  }
  const scopes: Array<{ scopeId: string; kind: string; label: string; status: string; lastActiveAt: number | null }> = [
    { scopeId: scopeIdOf({ kind: "dm", memberId: m.id }), kind: "dm", label: "Direct message", status: "idle", lastActiveAt: null },
  ];
  for (const room of roomStore.listRooms()) {
    const inGlobal = room.globalMemberIds?.includes(m.id);
    const inLegacy = roomStore.getRoomMembers(room.id).some((rm) => rm.name === m.name);
    if (inGlobal || inLegacy) {
      scopes.push({
        scopeId: scopeIdOf({ kind: "room", roomId: room.id }),
        kind: "room",
        label: room.name,
        status: "idle",
        lastActiveAt: null,
      });
    }
  }
  sendJson(res, 200, { scopes });
});

/** persona.md read-only panel surface (identity batch-2 / designer contract). */
addRoute("GET", "/api/members/:id/profile", async (_req, res, params) => {
  try {
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    const profile = readMemberProfile(m.id);
    sendJson(res, 200, {
      path: memberProfilePath(m.id),
      body: profile.body,
      charCount: profile.raw.length,
      overBudget: profile.overBudget,
      exists: profile.exists,
    });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

/** Batch 6 §4 read outlet: member-owned asset inventory (designer's Assets tab).
 * mcpServers come from the member's own mcp.json (toolCount only when the
 * availability cache has one — counting tools requires a live connection);
 * extensions use the runtime discovery rules; skills come from the member folder. */
addRoute("GET", "/api/members/:id/assets", async (_req, res, params) => {
  const m = resolveMemberRef(params.id);
  if (!m) {
    sendJson(res, 404, { error: "not_found", message: "Member not found" });
    return;
  }
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
    const m = resolveMemberRef(params.id);
    if (!m) {
      sendJson(res, 404, { error: "not_found", message: "Member not found" });
      return;
    }
    sendJson(res, 200, { skills: listMemberSkills(m.id) });
  } catch (err) {
    const e = errCode(err);
    sendJson(res, e.status, { error: e.error, message: e.message });
  }
});

// ── Member runtime reads and controls (member-owned; source is an optional filter) ──

function sourceQuery(request: { url?: string }): string | undefined {
  const url = new URL(request.url || "", "http://localhost");
  const scope = url.searchParams.get("scope");
  const roomId = url.searchParams.get("roomId");
  return scope || (roomId ? `room:${roomId}` : undefined);
}
function authorizedMember(memberRef: string, sourceRef?: string): MemberRecord | null {
  const member = resolveMemberRef(memberRef);
  if (member && sourceRef) assertMemberScopeAccess(member.id, sourceRef);
  return member;
}

addRoute("GET", "/api/members/:id/token-usage", async (request, response, params) => {
  try {
    const sourceRef = sourceQuery(request);
    const member = authorizedMember(params.id, sourceRef);
    if (!member) return sendJson(response, 404, { error: "Member not found" });
    sendJson(response, 200, { totalTokens: connectedMemberActions().readTokenTotal(member.id, sourceRef) });
  } catch (error) { sendJson(response, 400, { error: "invalid_scope", message: String(error) }); }
});
addRoute("GET", "/api/members/:id/stats", async (request, response, params) => {
  try {
    const sourceRef = sourceQuery(request);
    const member = authorizedMember(params.id, sourceRef);
    if (!member) return sendJson(response, 404, { error: "Member not found" });
    sendJson(response, 200, connectedMemberActions().readStats(member.id));
  } catch (error) { sendJson(response, 400, { error: "invalid_scope", message: String(error) }); }
});
addRoute("GET", "/api/members/:id/events", async (request, response, params) => {
  try {
    const sourceRef = sourceQuery(request);
    const member = authorizedMember(params.id, sourceRef);
    if (!member) return sendJson(response, 404, { error: "Member not found" });
    const url = new URL(request.url || "", "http://localhost");
    const beforeSeq = url.searchParams.has("beforeSeq") ? Number(url.searchParams.get("beforeSeq")) : undefined;
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") || 50), 500));
    const types = url.searchParams.get("types")?.split(",").map((value) => value.trim()).filter(Boolean);
    sendJson(response, 200, connectedMemberActions().readActivity(member.id, { sourceRef, beforeSeq, limit, types }));
  } catch (error) { sendJson(response, 400, { error: "invalid_scope", message: String(error) }); }
});
addRoute("GET", "/api/members/:id/status", async (_request, response, params) => {
  const member = resolveMemberRef(params.id);
  if (!member) return sendJson(response, 404, { error: "Member not found" });
  sendJson(response, 200, connectedMemberActions().readStatus(member.id));
});
for (const action of ["stop", "compact", "reset", "restart"] as const) {
  addRoute("POST", `/api/members/:id/${action}`, async (_request, response, params) => {
    const member = resolveMemberRef(params.id);
    if (!member) return sendJson(response, 404, { error: "Member not found" });
    try { sendJson(response, 200, await connectedMemberActions()[action](member.id)); }
    catch (error) { sendJson(response, 400, { error: `${action}_failed`, message: error instanceof Error ? error.message : String(error) }); }
  });
}

// Shared skill catalog is a member asset capability; member-local enablement
// remains in the member configuration routes above.
addRoute("GET", "/api/skills", async (_request, response) => {
  try {
    sendJson(response, 200, loadSkillDefinitionsStrict().map(({ name, description, tags }) => ({ name, description, tags })));
  } catch (error) {
    logger.error("api", "failed to load skill list", { error: String(error) });
    sendJson(response, 500, { error: "Couldn’t load Skills" });
  }
});
addRoute("GET", "/api/skills/templates", async (_request, response) => {
  sendJson(response, 200, loadSkillTemplates().map(({ name, description, tags }) => ({ name, description, tags })));
});
addRoute("GET", "/api/skills/:name", async (_request, response, params) => {
  const skill = loadSkillDefinition(params.name);
  if (!skill) return sendJson(response, 404, { error: "Skill not found" });
  sendJson(response, 200, skill);
});
addRoute("POST", "/api/skills", async (request, response) => {
  const body = await parseBody(request) as { name?: string; content?: string };
  if (!body.name || !body.content) return sendJson(response, 400, { error: "name and content are required" });
  if (loadSkillDefinition(body.name)) return sendJson(response, 409, { error: `Skill "${body.name}" already exists` });
  sendJson(response, 200, saveSkillDefinition(body.name, body.content));
});
addRoute("PUT", "/api/skills/:name", async (request, response, params) => {
  const body = await parseBody(request) as { content?: string };
  if (!body.content) return sendJson(response, 400, { error: "content is required" });
  sendJson(response, 200, saveSkillDefinition(params.name, body.content));
});
addRoute("DELETE", "/api/skills/:name", async (_request, response, params) => {
  if (!deleteSkillDefinition(params.name)) return sendJson(response, 404, { error: "Skill not found" });
  sendJson(response, 200, { ok: true });
});
