// Skills and member operational API routes. Member CRUD lives in members.ts.
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../kernel/logger.js";
import {
  loadSkillDefinitions, loadSkillDefinitionsStrict, loadSkillDefinition, saveSkillDefinition,
  deleteSkillDefinition, loadSkillTemplates,
} from "../workforce/skill-store.js";
import { getMemberInstances, abortMember, compactMemberById, resetMemberSession, restartMember } from "../engine/agent-manager.js";
import { getLatestMessageId } from "../communication/message-bus.js";
import * as roomStore from "../workspace/room-store.js";
import { getMemberTokenUsage, getRoomMemberTokenUsage } from "../workspace/token-usage-store.js";
import { readMemberStats } from "../workspace/member-stats-store.js";
import { getMember, resolveMemberRef } from "../workspace/member-registry.js";
import { parseScopeId } from "../shared/conversation-ref.js";
import { pageActivity as queryActivityPage } from "../storage/event-repository.js";
import { loadEventsPaginated } from "../engine/event-handler.js";

// ── Skill CRUD ──

addRoute("GET", "/api/skills", async (_req, res) => {
  try {
    const skills = loadSkillDefinitionsStrict();
    const result = skills.map(({ name, description, tags }) => ({ name, description, tags }));
    sendJson(res, 200, result);
  } catch (err) {
    logger.error("workforce-api", "failed to load Skill list", { error: String(err) });
    sendJson(res, 500, { error: "Couldn’t load Skills" });
  }
});

addRoute("GET", "/api/skills/templates", async (_req, res) => {
  const templates = loadSkillTemplates();
  const result = templates.map(({ name, description, tags }) => ({ name, description, tags }));
  sendJson(res, 200, result);
});

addRoute("GET", "/api/skills/:name", async (_req, res, params) => {
  const skill = loadSkillDefinition(params.name);
  if (!skill) {
    sendJson(res, 404, { error: "Skill not found" });
    return;
  }
  sendJson(res, 200, skill);
});

addRoute("POST", "/api/skills", async (req, res) => {
  const body = (await parseBody(req)) as { name?: string; content?: string };
  if (!body.name || !body.content) {
    sendJson(res, 400, { error: "name and content are required" });
    return;
  }
  if (loadSkillDefinition(body.name)) {
    sendJson(res, 409, { error: `Skill "${body.name}" already exists` });
    return;
  }
  const skill = saveSkillDefinition(body.name, body.content);
  sendJson(res, 200, skill);
});

addRoute("PUT", "/api/skills/:name", async (req, res, params) => {
  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }
  const skill = saveSkillDefinition(params.name, body.content);
  sendJson(res, 200, skill);
});

addRoute("DELETE", "/api/skills/:name", async (_req, res, params) => {
  const deleted = deleteSkillDefinition(params.name);
  if (!deleted) {
    sendJson(res, 404, { error: "Skill not found" });
    return;
  }

  sendJson(res, 200, { ok: true });
});

addRoute("GET", "/api/members/:id/token-usage", async (req, res, params) => {
  const url = new URL(req.url || "", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  if (roomId) {
    const resolveRoomMemberRef = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef as (roomId: string, ref: string) => { id: string } | null : undefined;
    const roomMember = resolveRoomMemberRef?.(roomId, params.id);
    if (!roomMember) { sendJson(res, 404, { error: "Member not found in this room" }); return; }
    sendJson(res, 200, getRoomMemberTokenUsage(roomId, roomMember.id));
    return;
  }
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  sendJson(res, 200, getMemberTokenUsage(member.id));
});

/** Persistent per-member stats for this scope: turns, tool calls, active work
 * time (ms), cumulative tokens, and cost. Sourced from the incremental
 * accumulator (member-stats-store), not a live JSONL rescan. A member with no
 * recorded activity yet returns real zeros, never fabricated numbers.
 * Canonical form: ?scope=room:<id>|dm:<memberId> (0.20 scope addressing);
 * legacy ?roomId= keeps working for room-scope consumers. */
addRoute("GET", "/api/members/:id/stats", async (req, res, params) => {
  const url = new URL(req.url || "", "http://localhost");
  const scopeParam = url.searchParams.get("scope");
  const roomId = url.searchParams.get("roomId");
  if (!scopeParam && !roomId) { sendJson(res, 400, { error: "scope is required" }); return; }
  if (scopeParam) {
    const ref = parseScopeId(scopeParam);
    if (!ref) { sendJson(res, 400, { error: "scope_not_found", message: "invalid scope" }); return; }
    const member = resolveMemberRef(params.id);
    if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
    // Scope artifact key: room scope → room uuid; dm scope → "dm:<memberId>"
    // (the instance registry key DM events/stats are recorded under today).
    const artifactKey = ref.kind === "room" ? ref.roomId : `dm:${ref.memberId}`;
    sendJson(res, 200, readMemberStats(artifactKey, member.id));
    return;
  }
  const resolveRoomMemberRef = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef as (roomId: string, ref: string) => { id: string; name: string } | null : undefined;
  const roomMember = resolveRoomMemberRef?.(roomId!, params.id);
  if (!roomMember) { sendJson(res, 404, { error: "Member not found in this room" }); return; }
  sendJson(res, 200, readMemberStats(roomId!, roomMember.id));
});

/** Index-backed Activity pagination by scope (same engine as the room members
 * events route): query the SQLite activity index for a seq window, then O(1)
 * fetch the matching jsonl lines by byte offset. Falls back to the file
 * tail-scan when the projection is unavailable so the endpoint always answers. */
addRoute("GET", "/api/members/:id/events", async (req, res, params) => {
  const url = new URL(req.url || "", "http://localhost");
  const scopeParam = url.searchParams.get("scope");
  const ref = scopeParam ? parseScopeId(scopeParam) : null;
  if (!ref) { sendJson(res, 400, { error: "scope_not_found", message: "valid scope is required" }); return; }
  const member = resolveMemberRef(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  const artifactKey = ref.kind === "room" ? ref.roomId : `dm:${ref.memberId}`;
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 500));
  const beforeSeq = url.searchParams.get("beforeSeq") ? parseInt(url.searchParams.get("beforeSeq")!, 10) : undefined;
  const typesParam = url.searchParams.get("types");
  const types = typesParam ? typesParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

  const page = queryActivityPage(artifactKey, member.id, { beforeSeq, limit, types });
  if (page) {
    sendJson(res, 200, { events: page.events, hasMore: page.hasMore, nextBeforeSeq: page.nextBeforeSeq });
    return;
  }
  const result = loadEventsPaginated(artifactKey, member.id, limit, beforeSeq);
  sendJson(res, 200, { events: result.events, hasMore: result.hasMore, nextBeforeSeq: result.hasMore ? Math.max(0, (result.total - result.events.length)) : null });
});

addRoute("GET", "/api/members/:id/status", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  const instances = getMemberInstances(member.id);
  sendJson(res, 200, { instances });
});

addRoute("POST", "/api/members/:id/stop", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  const result = abortMember(member.id);
  logger.info("api", "POST /api/members/:id/stop", { memberId: member.id, ...result });
  sendJson(res, 200, result);
});

addRoute("POST", "/api/members/:id/compact", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  try {
    const result = await compactMemberById(member.id);
    sendJson(res, 200, result);
  } catch (err: any) {
    const message = err?.message || String(err);
    logger.error("api", "member compact failed", { memberId: member.id, error: message });
    sendJson(res, 400, { error: "compact_failed", message });
  }
});

addRoute("POST", "/api/members/:id/reset", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  const result = resetMemberSession(member.id);
  logger.info("api", "POST /api/members/:id/reset", { memberId: member.id });
  sendJson(res, 200, result);
});

// ① B5: member-level operations — the interface targets the member directly.
addRoute("POST", "/api/members/:id/restart", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  const result = restartMember(member.id);
  logger.info("api", "POST /api/members/:id/restart", { memberId: member.id });
  sendJson(res, 200, result);
});
