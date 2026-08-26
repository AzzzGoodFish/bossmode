/**
 * 0.20 unified conversation session ops — contract §2.2
 * POST /api/conversations/:scope/{reset-session,reload,abort,steer}
 * GET  /api/conversations/:scope/{events,context-usage,tools}
 *
 * Room scopes require ?memberId= (or ?member= name/id). DM scopes embed memberId.
 */
import { addRoute, sendJson, parseBody } from "./index.js";
import { parseScopeId, scopeIdOf, type ScopeId } from "../shared/conversation-ref.js";
import * as roomStore from "../workspace/room-store.js";
import { resolveTopicRoomId } from "../workspace/topic-store.js";
import { findMemberByName, getMember } from "../workspace/member-registry.js";
import { toolSurfaceForScope } from "../engine/scope-tool-surface.js";
import {
  abortAgent,
  getAgentContextUsage,
  getAgentStatus,
  getMemberActiveTools,
  reloadMemberResources,
  resetAgentSession,
  steerAgent,
  getMemberBusyState,
} from "../engine/agent-manager.js";
import { loadEventsPaginated } from "../engine/event-handler.js";
import { logger } from "../foundation/logger.js";

function decodeScope(raw: string): ScopeId | null {
  try {
    const s = decodeURIComponent(raw);
    return parseScopeId(s) ? s : null;
  } catch {
    return null;
  }
}

/** Resolve which member the conversation op targets. */
function resolveTarget(
  scopeParam: string,
  query: URLSearchParams,
): { scopeId: ScopeId; kind: "dm" | "room" | "topic"; roomId: string; memberId: string; memberName: string; isLeader: boolean } | { error: string; status: number } {
  const scopeId = decodeScope(scopeParam);
  if (!scopeId) return { error: "scope_not_found", status: 400 };
  const ref = parseScopeId(scopeId)!;

  if (ref.kind === "dm") {
    const global = getMember(ref.memberId);
    if (!global) return { error: "not_found", status: 404 };
    return {
      scopeId,
      kind: "dm",
      roomId: scopeId, // synthetic dm room id used by runtime
      memberId: global.id,
      memberName: global.name,
      isLeader: false,
    };
  }

  if (ref.kind === "topic") {
    const parent = resolveTopicRoomId(ref.topicId);
    if (!parent) return { error: "not_found", status: 404 };
    const room = roomStore.getRoom(parent);
    if (!room) return { error: "not_found", status: 404 };
    const memberRef = query.get("memberId") || query.get("member") || "";
    if (!memberRef) return { error: "member_required", status: 400 };
    const local = roomStore.resolveRoomMemberRef(parent, memberRef);
    if (!local) return { error: "not_found", status: 404 };
    const isLeader = !!room.promptLeaderMemberId && (room.promptLeaderMemberId === local.id || room.promptLeaderGlobalMemberId === local.id);
    return {
      scopeId,
      kind: "topic",
      roomId: scopeId, // topic:<id> — runtime instance + event dir key
      memberId: local.id,
      memberName: local.name,
      isLeader,
    };
  }

  const room = roomStore.getRoom(ref.roomId);
  if (!room) return { error: "not_found", status: 404 };

  const memberRef = query.get("memberId") || query.get("member") || "";
  if (!memberRef) return { error: "member_required", status: 400 };

  const local = roomStore.resolveRoomMemberRef(ref.roomId, memberRef);
  if (!local) return { error: "not_found", status: 404 };

  const isLeader = !!room.promptLeaderMemberId && room.promptLeaderMemberId === local.id;
  return {
    scopeId,
    kind: "room",
    roomId: ref.roomId,
    memberId: local.id,
    memberName: local.name,
    isLeader,
  };
}

function parseUrl(req: { url?: string }): URL {
  return new URL(req.url || "", "http://localhost");
}

// ── Session ops ──

addRoute("POST", "/api/conversations/:scope/reset-session", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  if (target.kind === "dm") {
    // DM reset: drop instance + clear session files via resetAgentSession with synthetic room id
    const result = resetAgentSession(target.roomId, target.memberId);
    sendJson(res, 200, { ...result, scopeId: target.scopeId });
    return;
  }
  const result = resetAgentSession(target.roomId, target.memberId);
  logger.info("api", "POST /api/conversations/:scope/reset-session", { scopeId: target.scopeId, member: target.memberName });
  sendJson(res, 200, { ...result, scopeId: target.scopeId });
});

addRoute("POST", "/api/conversations/:scope/reload", async (_req, res) => {
  sendJson(res, 410, { error: "gone", message: "Reload retired — activation recompiles the latest prompt" });
});

addRoute("POST", "/api/conversations/:scope/abort", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  const result = abortAgent(target.roomId, target.memberId);
  sendJson(res, 200, { ...result, scopeId: target.scopeId });
});

addRoute("POST", "/api/conversations/:scope/steer", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }
  try {
    void steerAgent(target.roomId, target.memberId, body.content).catch((err) => {
      logger.error("api", "steer error", { scopeId: target.scopeId, member: target.memberName, error: String(err) });
    });
    sendJson(res, 200, { ok: true, scopeId: target.scopeId });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message });
  }
});

// ── Reads ──

addRoute("GET", "/api/conversations/:scope/context-usage", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  const usage = getAgentContextUsage(target.roomId, target.memberId);
  if (usage === null) {
    sendJson(res, 200, { supported: true, unavailable: true, scopeId: target.scopeId });
  } else {
    sendJson(res, 200, { supported: true, scopeId: target.scopeId, ...usage });
  }
});

addRoute("GET", "/api/conversations/:scope/events", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
  const before = url.searchParams.get("before");
  const beforeN = before ? parseInt(before, 10) : undefined;
  // Topic/DM: roomId is the scope key; events file is keyed by member id.
  const eventRef = target.kind === "room" ? target.memberName : target.memberId;
  const page = loadEventsPaginated(target.roomId, eventRef, limit, Number.isFinite(beforeN as number) ? beforeN : undefined);
  sendJson(res, 200, { ...page, scopeId: target.scopeId, memberId: target.memberId });
});

addRoute("GET", "/api/conversations/:scope/tools", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  const surface = toolSurfaceForScope(target.scopeId, { isRoomLeader: target.isLeader });
  let live: ReturnType<typeof getMemberActiveTools> | null = null;
  try {
    live = getMemberActiveTools(target.roomId, target.memberId);
  } catch {
    live = null;
  }
  sendJson(res, 200, {
    scopeId: target.scopeId,
    memberId: target.memberId,
    surface,
    live,
    status: getAgentStatus(target.roomId, target.memberId),
    busy: getMemberBusyState(target.roomId, target.memberId),
  });
});

addRoute("GET", "/api/conversations/:scope/session", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  const status = getAgentStatus(target.roomId, target.memberId);
  const usage = getAgentContextUsage(target.roomId, target.memberId);
  sendJson(res, 200, {
    scopeId: target.scopeId,
    memberId: target.memberId,
    memberName: target.memberName,
    status,
    busy: getMemberBusyState(target.roomId, target.memberId),
    contextPct: usage && typeof (usage as any).percentage === "number" ? (usage as any).percentage : null,
    contextUsage: usage,
  });
});

// ── core-prompt preview (also on members/:id/core-prompt) ──

addRoute("GET", "/api/members/:id/core-prompt", async (req, res, params) => {
  try {
    const url = parseUrl(req);
    const scopeParam = url.searchParams.get("scope") || scopeIdOf({ kind: "dm", memberId: params.id });
    const scopeId = parseScopeId(scopeParam) ? scopeParam : null;
    if (!scopeId) {
      sendJson(res, 400, { error: "scope_not_found" });
      return;
    }
    const global = getMember(params.id) || findMemberByName(params.id);
    if (!global) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const { compileMemberPromptForScope } = await import("../engine/prompt-compiler.js");
    const { loadAgentDefinition } = await import("../workforce/agent-store.js");
    const ref = parseScopeId(scopeId)!;
    const agentDef = loadAgentDefinition(global.agentTemplate) || {
      name: global.agentTemplate,
      description: "",
      systemPrompt: `You are ${global.name}.`,
      tags: [],
      skills: [],
    };
    let room = null;
    if (ref.kind === "room") {
      room = roomStore.getRoom(ref.roomId);
      if (!room) {
        sendJson(res, 404, { error: "not_found", message: "room not found" });
        return;
      }
    }
    const { getBossmodeDir } = await import("../shared/config.js");
    const { join } = await import("node:path");
    const compiled = compileMemberPromptForScope({
      scopeId,
      memberId: global.id,
      memberName: global.name,
      agentDef,
      room,
      docsRoot: join(getBossmodeDir(), "memory", "projects"),
      activeScopes: [scopeId],
    });
    sendJson(res, 200, {
      scopeId,
      memberId: global.id,
      sections: compiled.sections,
      fullPrompt: compiled.fullPrompt,
      manifestHash: compiled.manifestHash,
    });
  } catch (err: any) {
    sendJson(res, 500, { error: "internal", message: err?.message || String(err) });
  }
});
