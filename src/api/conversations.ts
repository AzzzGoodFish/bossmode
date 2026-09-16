/**
 * 0.20 unified conversation session ops — contract §2.2
 * POST /api/conversations/:scope/{reset-session,reload,abort,compact}
 * GET  /api/conversations/:scope/{events,context-usage,tools}
 *
 * Room scopes require ?memberId= (or ?member= name/id). DM scopes embed memberId.
 */
import { addRoute, sendJson, parseBody } from "./index.js";
import { parseScopeId, scopeIdOf, type ScopeId } from "../shared/conversation-ref.js";
import * as roomStore from "../chat/room-store.js";
import { findMemberByName, getMember } from "../member/member-registry.js";
import { toolSurfaceForScope } from "../agent/tools/scope-tool-surface.js";
import {
  abortAgent,
  getAgentContextUsage,
  getAgentStatus,
  getMemberActiveTools,
  reloadMemberResources,
  resetAgentSession,
  compactMember,
  getMemberBusyState,
} from "../agent/orchestrator/agent-manager.js";
import { loadEventsPaginated } from "../agent/events/event-handler.js";
import { logger } from "../kernel/logger.js";

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
): { scopeId: ScopeId; kind: "dm" | "room"; roomId: string; memberId: string; memberName: string; isLeader: boolean } | { error: string; status: number } {
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

addRoute("POST", "/api/conversations/:scope/compact", async (req, res, params) => {
  const url = parseUrl(req);
  const target = resolveTarget(params.scope, url.searchParams);
  if ("error" in target) {
    sendJson(res, target.status, { error: target.error });
    return;
  }
  // Manual compaction is one explicit conversation action (steer-removal §2):
  // the real scopeId keys the live instance — room and DM alike.
  try {
    const result = await compactMember(target.scopeId, target.memberId);
    sendJson(res, 200, { ...result, scopeId: target.scopeId });
  } catch (err: any) {
    const message = err?.message || String(err);
    logger.error("api", "manual compact failed", { scopeId: target.scopeId, member: target.memberName, error: message });
    sendJson(res, 400, { error: "compact_failed", message });
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
  // DM: roomId is the scope key; events file is keyed by member id.
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

