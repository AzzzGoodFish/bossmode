// Workforce API routes — Agent, Skill, Member CRUD
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addRoute, sendJson, parseBody } from "./index.js";
import { logger } from "../foundation/logger.js";
import {
  loadAgentDefinitions, loadAgentDefinitionsStrict, loadAgentDefinition, saveAgentDefinition,
  deleteAgentDefinition, loadAgentTemplates, getAgentsDir,
} from "../workforce/agent-store.js";
import {
  loadSkillDefinitions, loadSkillDefinitionsStrict, loadSkillDefinition, saveSkillDefinition,
  deleteSkillDefinition, loadSkillTemplates,
} from "../workforce/skill-store.js";
import { loadMembers, getMember, saveMember, deleteMember } from "../workforce/member-store.js";
import { getMemberInstances, destroyInstance, switchMemberModelInActiveRooms } from "../engine/agent-manager.js";
import { parseFrontmatter } from "../shared/frontmatter.js";
import { getModelCredentialProfile, resolveCredentialProfileForModel } from "../engine/model-credentials.js";
import { getLatestMessageId } from "../communication/message-bus.js";
import * as roomStore from "../workspace/room-store.js";
import { getMemberTokenUsage, getRoomMemberTokenUsage } from "../workspace/token-usage-store.js";
import { readMemberStats } from "../workspace/member-stats-store.js";

const ONLY_SUPPORTED_RUNTIME = "pi-cli";

function validateCredentialMatchesModel(credentialId: unknown, model: string | undefined): string | undefined {
  if (credentialId === undefined || credentialId === null || credentialId === "") return undefined;
  if (typeof credentialId !== "string") throw new Error("credentialId must be a string");
  if (!model) throw new Error("credentialId requires an explicit model override");
  const credential = getModelCredentialProfile(credentialId);
  if (!credential) throw new Error("Model credential profile not found");
  if (!credential.enabled) throw new Error("Model credential profile is disabled");
  resolveCredentialProfileForModel({ modelRef: model, credentialId });
  return credentialId;
}

function optionalModel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ── Agent CRUD ──

addRoute("GET", "/api/agents", async (_req, res) => {
  try {
    const agents = loadAgentDefinitionsStrict();
    const result = agents.map(({ name, model, description, skills, tags, avatar }) => ({
      name, model, description, skills, tags, avatar,
    }));
    sendJson(res, 200, result);
  } catch (err) {
    logger.error("workforce-api", "failed to load Agent list", { error: String(err) });
    sendJson(res, 500, { error: "Couldn’t load Agent templates" });
  }
});

addRoute("GET", "/api/agents/templates", async (_req, res) => {
  const templates = loadAgentTemplates();
  const result = templates.map(({ name, model, description, skills, tags, avatar }) => ({
    name, model, description, skills, tags, avatar,
  }));
  sendJson(res, 200, result);
});

addRoute("GET", "/api/agents/:name", async (_req, res, params) => {
  const agent = loadAgentDefinition(params.name);
  if (!agent) {
    sendJson(res, 404, { error: "Agent not found" });
    return;
  }
  sendJson(res, 200, agent);
});

addRoute("POST", "/api/agents", async (req, res) => {
  const body = (await parseBody(req)) as { name?: string; content?: string };
  if (!body.name || !body.content) {
    sendJson(res, 400, { error: "name and content are required" });
    return;
  }
  if (loadAgentDefinition(body.name)) {
    sendJson(res, 409, { error: `Agent "${body.name}" already exists` });
    return;
  }
  const agent = saveAgentDefinition(body.name, body.content);
  sendJson(res, 200, agent);
});

addRoute("PUT", "/api/agents/:name", async (req, res, params) => {
  const { isImmutableTemplate } = await import("../workforce/template-lifecycle.js");
  // Guard: general + builtin immutable
  if (isImmutableTemplate(params.name)) {
    sendJson(res, 403, { error: "immutable", message: "Built-in / general templates cannot be edited" });
    return;
  }
  const existing = loadAgentDefinition(params.name);
  if (!existing) {
    sendJson(res, 404, { error: "Agent not found" });
    return;
  }
  const body = (await parseBody(req)) as { content?: string };
  if (!body.content) {
    sendJson(res, 400, { error: "content is required" });
    return;
  }
  const agent = saveAgentDefinition(params.name, body.content);
  sendJson(res, 200, agent);
});

addRoute("DELETE", "/api/agents/:name", async (req, res, params) => {
  const { isImmutableTemplate, membersReferencingTemplate, fallbackMembersToGeneral } =
    await import("../workforce/template-lifecycle.js");
  if (isImmutableTemplate(params.name)) {
    sendJson(res, 403, { error: "immutable", message: "Built-in / general templates cannot be deleted" });
    return;
  }
  const agent = loadAgentDefinition(params.name);
  if (!agent) {
    sendJson(res, 404, { error: "Agent not found" });
    return;
  }

  const url = new URL(req.url || "", "http://localhost");
  const force = url.searchParams.get("force") === "true" || url.searchParams.get("force") === "1";
  const refs = membersReferencingTemplate(params.name);
  if (refs.length > 0 && !force) {
    // Spec: forbid delete while referenced unless force — then fallback to general + warn
    sendJson(res, 409, {
      error: "referenced",
      message: `Template is referenced by ${refs.length} member(s). Pass force=true to delete and rebind them to general.`,
      referencedBy: refs.map((m) => m.id),
    });
    return;
  }

  // Force path or unreferenced: delete file then rebind any stragglers
  const deleted = deleteAgentDefinition(params.name);
  if (!deleted) {
    sendJson(res, 404, { error: "Agent not found" });
    return;
  }
  const fallback = refs.length > 0 ? fallbackMembersToGeneral(params.name) : { updatedMemberIds: [], warningsPosted: 0 };
  sendJson(res, 200, {
    ok: true,
    reboundToGeneral: fallback.updatedMemberIds,
    warningsPosted: fallback.warningsPosted,
  });
});

// ── 0.20 /api/templates aliases (contract §2.4) ──

addRoute("GET", "/api/templates", async (_req, res) => {
  try {
    const { listMembers } = await import("../workspace/member-registry.js");
    const agents = loadAgentDefinitions();
    const members = listMembers();
    const { listFactoryTemplateNames } = await import("../workforce/agent-store.js");
    const factory = new Set(listFactoryTemplateNames());
    const templates = agents.map((a) => ({
      name: a.name,
      description: a.description || "",
      builtin: a.name === "general" || factory.has(a.name) || (a.tags || []).includes("builtin"),
      referencedBy: members.filter((m) => m.agentTemplate === a.name).map((m) => m.id),
    }));
    sendJson(res, 200, { templates });
  } catch (err) {
    sendJson(res, 500, { error: "internal", message: String(err) });
  }
});

addRoute("DELETE", "/api/templates/:name", async (req, res, params) => {
  // Delegate to agents delete handler logic via internal fetch pattern — call same code path
  // by rewriting URL and reusing DELETE /api/agents/:name
  const url = new URL(req.url || "", "http://localhost");
  const force = url.searchParams.get("force");
  // Re-run through shared lifecycle (duplicate thin wrapper)
  const { isImmutableTemplate, membersReferencingTemplate, fallbackMembersToGeneral } =
    await import("../workforce/template-lifecycle.js");
  if (isImmutableTemplate(params.name)) {
    sendJson(res, 403, { error: "immutable", message: "Built-in / general templates cannot be deleted" });
    return;
  }
  if (!loadAgentDefinition(params.name)) {
    sendJson(res, 404, { error: "not_found", message: "Template not found" });
    return;
  }
  const refs = membersReferencingTemplate(params.name);
  if (refs.length > 0 && force !== "true" && force !== "1") {
    sendJson(res, 409, {
      error: "referenced",
      message: `Template is referenced by ${refs.length} member(s). Pass force=true to delete and rebind them to general.`,
      referencedBy: refs.map((m) => m.id),
    });
    return;
  }
  deleteAgentDefinition(params.name);
  const fallback = refs.length > 0 ? fallbackMembersToGeneral(params.name) : { updatedMemberIds: [], warningsPosted: 0 };
  sendJson(res, 200, { ok: true, reboundToGeneral: fallback.updatedMemberIds, warningsPosted: fallback.warningsPosted });
});

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

  // Auto-unbind: remove this skill from all agents that reference it
  try {
    const agents = loadAgentDefinitions();
    for (const agent of agents) {
      if (agent.skills?.includes(params.name)) {
        const agentPath = join(getAgentsDir(), `${agent.name}.md`);
        const raw = readFileSync(agentPath, "utf-8");
        const { meta, body } = parseFrontmatter(raw);
        const skills = Array.isArray(meta.skills) ? (meta.skills as string[]).filter((s) => s !== params.name) : [];
        meta.skills = skills;
        const { stringify } = await import("yaml");
        const newContent = `---\n${stringify(meta).trim()}\n---\n\n${body}`;
        saveAgentDefinition(agent.name, newContent);
      }
    }
  } catch (err) {
    logger.error("api", "failed to auto-unbind skill", { error: String(err) });
  }

  sendJson(res, 200, { ok: true });
});

// ── Member CRUD ──

addRoute("GET", "/api/members", async (_req, res) => {
  sendJson(res, 200, loadMembers());
});

addRoute("GET", "/api/members/:id", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  sendJson(res, 200, member);
});

addRoute("POST", "/api/members", async (req, res) => {
  const body = (await parseBody(req)) as any;
  if (!body.name) {
    sendJson(res, 400, { error: "name is required" });
    return;
  }
  const model = optionalModel(body.model);
  let credentialId: string | undefined;
  try {
    credentialId = validateCredentialMatchesModel(body.credentialId, model);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
    return;
  }
  const member = saveMember({
    name: body.name,
    agent: body.agent || "",
    model,
    runtime: ONLY_SUPPORTED_RUNTIME,
    thinkingLevel: body.thinkingLevel || "off",
    avatar: body.avatar,
    contextLimit: body.contextLimit,
    credentialId,
  });
  sendJson(res, 200, member);
});

addRoute("PUT", "/api/members/:id", async (req, res, params) => {
  const existing = getMember(params.id);
  if (!existing) { sendJson(res, 404, { error: "Member not found" }); return; }
  const body = (await parseBody(req)) as any;
  const model = Object.prototype.hasOwnProperty.call(body, "model") ? optionalModel(body.model) : existing.model;
  const credentialInput = Object.prototype.hasOwnProperty.call(body, "credentialId")
    ? body.credentialId
    : existing.credentialId;
  let credentialId: string | undefined;
  try {
    credentialId = validateCredentialMatchesModel(credentialInput, model);
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
    return;
  }
  const member = saveMember({
    id: params.id,
    name: body.name ?? existing.name,
    agent: body.agent ?? existing.agent,
    model,
    runtime: ONLY_SUPPORTED_RUNTIME,
    thinkingLevel: body.thinkingLevel ?? existing.thinkingLevel,
    avatar: body.avatar ?? existing.avatar,
    contextLimit: body.contextLimit ?? existing.contextLimit,
    credentialId,
  });

  const modelChanged = model !== existing.model || credentialId !== existing.credentialId;
  if (modelChanged && model) {
    try {
      await switchMemberModelInActiveRooms(existing.name, model, credentialId);
    } catch (err: any) {
      sendJson(res, 400, { error: err.message || String(err) });
      return;
    }
  }

  sendJson(res, 200, member);
});

addRoute("DELETE", "/api/members/:id", async (_req, res, params) => {
  if (!deleteMember(params.id)) { sendJson(res, 404, { error: "Member not found" }); return; }
  sendJson(res, 200, { ok: true });
});

addRoute("GET", "/api/members/:id/token-usage", async (req, res, params) => {
  const url = new URL(req.url || "", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  if (roomId) {
    const resolveRoomMemberRef = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef as (roomId: string, ref: string) => { id: string } | null : undefined;
    const roomMember = resolveRoomMemberRef?.(roomId, params.id);
    if (roomMember) {
      sendJson(res, 200, getRoomMemberTokenUsage(roomId, roomMember.id));
      return;
    }
  }
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  sendJson(res, 200, getMemberTokenUsage(member.name));
});

/** Persistent per-member stats for this room: turns, tool calls, active work
 * time (ms), cumulative tokens, and cost. Sourced from the incremental
 * accumulator (member-stats-store), not a live JSONL rescan. A member with no
 * recorded activity yet returns real zeros, never fabricated numbers. */
addRoute("GET", "/api/members/:id/stats", async (req, res, params) => {
  const url = new URL(req.url || "", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  if (!roomId) { sendJson(res, 400, { error: "roomId is required" }); return; }
  const resolveRoomMemberRef = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef as (roomId: string, ref: string) => { id: string; name: string } | null : undefined;
  const roomMember = resolveRoomMemberRef?.(roomId, params.id);
  if (!roomMember) { sendJson(res, 404, { error: "Member not found in this room" }); return; }
  sendJson(res, 200, readMemberStats(roomId, roomMember.id));
});

addRoute("GET", "/api/members/:id/status", async (_req, res, params) => {
  const member = getMember(params.id);
  if (!member) { sendJson(res, 404, { error: "Member not found" }); return; }
  const instances = getMemberInstances(member.name);
  sendJson(res, 200, { instances });
});

addRoute("POST", "/api/members/:id/restart", async (req, res, params) => {
  const url = new URL(req.url || "", "http://localhost");
  const roomId = url.searchParams.get("roomId");
  if (!roomId) { sendJson(res, 400, { error: "member and roomId required" }); return; }
  const resolveRoomMemberRef = "resolveRoomMemberRef" in roomStore ? (roomStore as any).resolveRoomMemberRef as (roomId: string, ref: string) => { id: string } | null : undefined;
  const roomMember = resolveRoomMemberRef?.(roomId, params.id);
  const legacyMember = roomMember ? null : getMember(params.id);
  const memberRef = roomMember?.id || legacyMember?.name;
  if (!memberRef) { sendJson(res, 400, { error: "member and roomId required" }); return; }
  destroyInstance(roomId, memberRef);

  const latestId = getLatestMessageId(roomId);
  roomStore.setCursor(roomId, memberRef, latestId);

  sendJson(res, 200, {
    ok: true,
    message: "Instance restarted. Next activation will wait for new messages.",
  });
});
