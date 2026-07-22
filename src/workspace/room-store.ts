import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import type { CreateRoomMemberInput, Room, CursorMap, RoomLinearIntegration, RoomMemberOverride, RoomMemberRecord, RoomMemberConfig } from "../shared/types.js";
import { getMemberByName } from "../workforce/member-store.js";
import { loadAgentDefinition } from "../workforce/agent-store.js";
import { copyTeamTemplateTo, writeTeamPackage } from "./team-store.js";
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";
import { join as fsJoin } from "node:path";

function roomsDir(): string {
  return join(getBossmodeDir(), "rooms");
}

export function getRoomsDir(): string {
  return roomsDir();
}

function ensureRoomsDir(): void {
  const dir = roomsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function roomDir(roomId: string): string {
  return join(roomsDir(), roomId);
}

function roomJsonPath(roomId: string): string {
  return join(roomDir(roomId), "room.json");
}

function cursorsPath(roomId: string): string {
  return join(roomDir(roomId), "cursors.json");
}

function messagesPath(roomId: string): string {
  return join(roomDir(roomId), "messages.jsonl");
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err) {
    logger.error("room-store", "failed to read directory", { dir, error: String(err) });
    return [];
  }
}

function writeRoom(room: Room): void {
  room.members = getRoomMembersFromRoom(room).map((member) => member.name);
  writeFileSync(roomJsonPath(room.id), JSON.stringify(room, null, 2), "utf-8");
}

export function createRoomMemberId(): string {
  return `rm_${randomUUID()}`;
}

function cleanMemberConfig(config: RoomMemberConfig): RoomMemberConfig {
  const next: RoomMemberConfig = {};
  if (config.model) next.model = config.model;
  if (config.credentialId) next.credentialId = config.credentialId;
  if (config.thinkingLevel) next.thinkingLevel = config.thinkingLevel;
  if (typeof config.contextLimit === "number" && Number.isFinite(config.contextLimit)) next.contextLimit = config.contextLimit;
  if (Array.isArray(config.skills) && config.skills.length > 0) next.skills = Array.from(new Set(config.skills.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())));
  if (Array.isArray(config.mcpServers) && config.mcpServers.length > 0) next.mcpServers = Array.from(new Set(config.mcpServers.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())));
  return next;
}

function buildRoomMemberRecord(roomId: string, memberName: string, override?: RoomMemberOverride, existingId?: string): RoomMemberRecord {
  const legacyMember = getMemberByName(memberName);
  const now = Date.now();
  const sourceAgent = legacyMember?.agent || memberName;
  const config = cleanMemberConfig({
    model: legacyMember?.model,
    credentialId: legacyMember?.credentialId,
    thinkingLevel: legacyMember?.thinkingLevel,
    contextLimit: legacyMember?.contextLimit,
    skills: legacyMember?.skills,
    ...(override || {}),
  });
  return {
    id: existingId || createRoomMemberId(),
    roomId,
    name: memberName,
    sourceAgent,
    sourceMemberId: legacyMember?.id,
    avatar: legacyMember?.avatar,
    ...(Object.keys(config).length > 0 ? { config } : {}),
    createdAt: now,
    updatedAt: now,
    migratedFrom: { memberName, memberId: legacyMember?.id },
  };
}

function buildDirectRoomMemberFromAgent(roomId: string, input: { agentName: string; memberName: string; config?: Partial<RoomMemberConfig> }): RoomMemberRecord {
  const agent = loadAgentDefinition(input.agentName);
  const now = Date.now();
  const config = cleanMemberConfig(input.config || {});
  return {
    id: createRoomMemberId(),
    roomId,
    name: input.memberName,
    sourceAgent: input.agentName,
    avatar: agent?.avatar,
    ...(Object.keys(config).length > 0 ? { config } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

function getRoomMembersFromRoom(room: Room): RoomMemberRecord[] {
  if (Array.isArray(room.roomMembers) && room.roomMembers.length > 0) {
    return room.roomMembers.map((member) => ({ ...member, roomId: member.roomId || room.id }));
  }
  return (room.members || []).map((name) => buildRoomMemberRecord(room.id, name, room.memberOverrides?.[name], name));
}

export function deriveRoomMembers(room: Room): RoomMemberRecord[] {
  return getRoomMembersFromRoom(room);
}

export function normalizeMemberName(name: string): string {
  return name.trim();
}

export function validateRoomMemberName(name: string): string | null {
  const trimmed = normalizeMemberName(name);
  if (!trimmed) return "member name is required";
  if (trimmed.length > 64) return "member name must be 64 characters or fewer";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return "member name may contain letters, numbers, dot, underscore, or hyphen and must start with a letter or number";
  if (trimmed === "all") return "member name cannot be all";
  return null;
}

export function roomMemberNames(room: Room): string[] {
  return getRoomMembersFromRoom(room).map((member) => member.name);
}

export function validateRoomMemberNameList(names: string[]): string | null {
  const seen = new Set<string>();
  for (const raw of names) {
    const name = normalizeMemberName(String(raw || ""));
    const validation = validateRoomMemberName(name);
    if (validation) return validation;
    if (seen.has(name)) return `Duplicate member name in room: ${name}`;
    seen.add(name);
  }
  return null;
}

export function slugifyRoomDocsPath(input: string): string {
  const slug = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "-")
    .replace(/[^\w\-.\u4e00-\u9fff]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || `room-${Date.now()}`;
  return `${slug}/`;
}

export function normalizeRoomDocsPath(input: string | null | undefined): string | undefined {
  const raw = String(input || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!raw) return undefined;
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("docsPath must stay inside the knowledge docs root");
  const safe = parts.join("/");
  if (!/^[\w\-.\u4e00-\u9fff/]+$/u.test(safe)) throw new Error("docsPath contains unsupported characters");
  return `${safe}/`;
}

// -- Room CRUD --

export function createRoom(name: string, cwd: string, members: CreateRoomMemberInput[], ruleDocs?: string[], opts?: {
  promptLeaderMemberName?: string;
  promptLeaderMemberId?: string;
  docsPath?: string | null;
  /** Instantiate from a team template (copies teams/<slug>/ → rooms/<id>/team/). */
  templateName?: string;
}): Room {
  const drafts = members.map((member) => {
    if (!member || typeof member.agent !== "string" || typeof member.name !== "string") {
      throw new Error("members must contain { agent, name } objects");
    }
    const agent = member.agent.trim();
    const memberName = normalizeMemberName(member.name);
    if (!agent || !memberName) throw new Error("agent and member name are required");
    return { agent, name: memberName };
  });
  const validation = validateRoomMemberNameList(drafts.map((draft) => draft.name));
  if (validation) throw new Error(validation);

  // Agents must exist either in the chosen template or the global gallery.
  let templateMeta: { name: string; version: string } | undefined;
  if (opts?.templateName) {
    // Defer full validation until after copy — agent files come from the template package.
  } else {
    for (const draft of drafts) {
      if (!loadAgentDefinition(draft.agent)) throw new Error(`Agent not found: ${draft.agent}`);
    }
  }

  const leaderName = opts?.promptLeaderMemberName ? normalizeMemberName(opts.promptLeaderMemberName) : undefined;
  if (leaderName && !drafts.some((draft) => draft.name === leaderName)) throw new Error("promptLeaderMemberName must be one of the room members");

  const roomId = randomUUID();
  const roomMembers = drafts.map((draft) => buildDirectRoomMemberFromAgent(roomId, { agentName: draft.agent, memberName: draft.name }));
  const promptLeaderMemberId = opts?.promptLeaderMemberId || (leaderName ? roomMembers.find((member) => member.name === leaderName)?.id : undefined);
  if (opts?.promptLeaderMemberId && !roomMembers.some((member) => member.id === opts.promptLeaderMemberId)) throw new Error("promptLeaderMemberId must be one of the room members");
  const room: Room = {
    id: roomId,
    name,
    cwd,
    members: roomMembers.map((member) => member.name),
    roomMembers,
    ...(promptLeaderMemberId ? { promptLeaderMemberId } : {}),
    docsPath: normalizeRoomDocsPath(opts?.docsPath) || slugifyRoomDocsPath(name),
    createdAt: Date.now(),
    ...(ruleDocs?.length ? { ruleDocs } : {}),
  };

  ensureRoomsDir();
  const dir = roomDir(room.id);
  try {
    mkdirSync(dir, { recursive: true });
    if (room.docsPath) mkdirSync(join(getBossmodeDir(), "knowledge", "docs", room.docsPath), { recursive: true });

    // Instantiate team package into rooms/<id>/team/ (room-local agents — no global fallback at compile).
    const teamDest = join(dir, "team");
    if (opts?.templateName) {
      const team = copyTeamTemplateTo(opts.templateName, teamDest);
      templateMeta = { name: team.meta.name, version: team.meta.version };
      // Validate drafts against template agents
      const agentNames = new Set(team.agents.map((a) => a.name));
      for (const draft of drafts) {
        if (!agentNames.has(draft.agent)) throw new Error(`Agent "${draft.agent}" is not in team template "${team.meta.name}"`);
      }
    } else {
      // Blank / add-agent path: copy each selected agent from the global gallery into the room team package.
      const agents = drafts.map((draft) => {
        const def = loadAgentDefinition(draft.agent);
        if (!def) throw new Error(`Agent not found: ${draft.agent}`);
        const globalPath = fsJoin(getBossmodeDir(), "agents", `${draft.agent}.md`);
        const markdown = fsExistsSync(globalPath)
          ? fsReadFileSync(globalPath, "utf-8")
          : `---\nname: ${def.name}\ndescription: ${JSON.stringify(def.description || "")}\n---\n\n${def.systemPrompt || ""}\n`;
        return { fileName: `${draft.agent}.md`, markdown };
      });
      writeTeamPackage(teamDest, {
        name,
        description: "Room team",
        version: "1.0.0",
        leader: leaderName,
        agents,
      });
    }
    if (templateMeta) room.template = templateMeta;

    writeRoom(room);

    const cursors: CursorMap = {};
    for (const member of roomMembers) cursors[member.id] = null;
    writeFileSync(cursorsPath(room.id), JSON.stringify(cursors, null, 2), "utf-8");
    writeFileSync(messagesPath(room.id), "", "utf-8");
    return room;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function getRoom(roomId: string): Room | null {
  const path = roomJsonPath(roomId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Room;
}

export function deleteRoom(roomId: string): boolean {
  const dir = roomDir(roomId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function updateRoomName(roomId: string, name: string): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  room.name = name;
  writeRoom(room);
  return room;
}

export function updateRoomCwd(roomId: string, cwd: string): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  room.cwd = cwd;
  writeRoom(room);
  return room;
}

export function updateRoomPromptLeader(roomId: string, promptLeaderMemberId: string | null): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  if (promptLeaderMemberId === null || promptLeaderMemberId === "") {
    delete room.promptLeaderMemberId;
    writeRoom(room);
    return room;
  }
  const member = findRoomMemberByIdInRoom(room, promptLeaderMemberId);
  if (!member) throw new Error("promptLeaderMemberId must be a current room member");
  room.promptLeaderMemberId = member.id;
  writeRoom(room);
  return room;
}

export function updateRoomDocsPath(roomId: string, docsPath: string | null): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  const normalized = normalizeRoomDocsPath(docsPath);
  if (normalized) room.docsPath = normalized;
  else delete room.docsPath;
  writeRoom(room);
  return room;
}

/** Update the room's rule document paths (replaces any prior value). */
export function updateRoomLinearIntegration(roomId: string, config: RoomLinearIntegration | null): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  if (config) {
    room.integrations = { ...(room.integrations || {}), linear: config };
  } else if (room.integrations?.linear) {
    delete room.integrations.linear;
    if (Object.keys(room.integrations).length === 0) delete room.integrations;
  }
  writeRoom(room);
  return room;
}

export function getRoomMemberOverride(roomId: string, memberName: string): RoomMemberOverride | undefined {
  const room = getRoom(roomId);
  if (!room) return undefined;
  const member = findRoomMemberByNameInRoom(room, memberName);
  if (member?.config) return member.config;
  return room.memberOverrides?.[memberName];
}

function findRoomMemberByNameInRoom(room: Room, name: string): RoomMemberRecord | null {
  const normalized = normalizeMemberName(name);
  return getRoomMembersFromRoom(room).find((member) => member.name === normalized) || null;
}

function findRoomMemberByIdInRoom(room: Room, id: string): RoomMemberRecord | null {
  return getRoomMembersFromRoom(room).find((member) => member.id === id) || null;
}

function findRoomMemberByRefInRoom(room: Room, ref: string): RoomMemberRecord | null {
  return findRoomMemberByIdInRoom(room, ref) || findRoomMemberByNameInRoom(room, ref);
}

export function getRoomMembers(roomId: string): RoomMemberRecord[] {
  const room = getRoom(roomId);
  return room ? getRoomMembersFromRoom(room) : [];
}

export function findRoomMemberById(roomId: string, memberId: string): RoomMemberRecord | null {
  const room = getRoom(roomId);
  return room ? findRoomMemberByIdInRoom(room, memberId) : null;
}

export function findRoomMemberByName(roomId: string, name: string): RoomMemberRecord | null {
  const room = getRoom(roomId);
  return room ? findRoomMemberByNameInRoom(room, name) : null;
}

export function resolveRoomMemberRef(roomId: string, ref: string): RoomMemberRecord | null {
  const room = getRoom(roomId);
  return room ? findRoomMemberByRefInRoom(room, ref) : null;
}

function cleanOverride(override: RoomMemberOverride): RoomMemberOverride {
  return cleanMemberConfig(override);
}

function applyConfigPatch(current: RoomMemberConfig, patch: { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null }): RoomMemberConfig {
  const next: RoomMemberConfig = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, "model")) {
    if (patch.model) next.model = patch.model;
    else {
      delete next.model;
      delete next.credentialId;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "credentialId")) {
    if (patch.credentialId) next.credentialId = patch.credentialId;
    else delete next.credentialId;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "thinkingLevel")) {
    if (patch.thinkingLevel) next.thinkingLevel = patch.thinkingLevel;
    else delete next.thinkingLevel;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "mcpServers")) {
    if (Array.isArray(patch.mcpServers) && patch.mcpServers.length > 0) next.mcpServers = Array.from(new Set(patch.mcpServers.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())));
    else delete next.mcpServers;
  }
  return cleanMemberConfig(next);
}

export function updateRoomMemberOverride(roomId: string, memberRef: string, patch: { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null }): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;

  if (Array.isArray(room.roomMembers) && room.roomMembers.length > 0) {
    const member = findRoomMemberByRefInRoom(room, memberRef);
    if (!member) return null;
    const cleaned = applyConfigPatch(member.config || {}, patch);
    room.roomMembers = room.roomMembers.map((entry) => entry.id === member.id
      ? { ...entry, config: Object.keys(cleaned).length > 0 ? cleaned : undefined, updatedAt: Date.now() }
      : entry);
    room.members = room.roomMembers.map((entry) => entry.name);
    writeRoom(room);
    return room;
  }

  const current = room.memberOverrides?.[memberRef] || {};
  const cleaned = applyConfigPatch(current, patch);
  if (Object.keys(cleaned).length > 0) {
    room.memberOverrides = { ...(room.memberOverrides || {}), [memberRef]: cleaned };
  } else if (room.memberOverrides?.[memberRef]) {
    delete room.memberOverrides[memberRef];
    if (Object.keys(room.memberOverrides).length === 0) delete room.memberOverrides;
  }
  writeRoom(room);
  return room;
}

export function hasRoomMemberModelOverride(roomId: string, memberName: string): boolean {
  const override = getRoomMemberOverride(roomId, memberName);
  return typeof override?.model === "string" && override.model.length > 0;
}

export function clearLinearIntegrationsForAllRooms(): number {
  let count = 0;
  for (const room of listRooms()) {
    if (!room.integrations?.linear) continue;
    delete room.integrations.linear;
    if (Object.keys(room.integrations).length === 0) delete room.integrations;
    writeFileSync(roomJsonPath(room.id), JSON.stringify(room, null, 2), "utf-8");
    count += 1;
  }
  return count;
}

export function updateRoomRuleDocs(roomId: string, ruleDocs: string[]): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  if (ruleDocs.length > 0) {
    room.ruleDocs = ruleDocs;
  } else {
    delete room.ruleDocs;
  }
  // Legacy field clean-up (0.7.0/0.8.0 migration leftovers)
  delete (room as any).ruleIds;
  delete (room as any).knowledgeBaseId;
  writeFileSync(roomJsonPath(roomId), JSON.stringify(room, null, 2), "utf-8");
  return room;
}

/**
 * Cascade update room.ruleDocs references when a knowledge doc path changes.
 * - Move: oldPath -> newPath
 * - Delete: remove oldPath when newPath is undefined
 *
 * Returns number of affected rooms.
 */
export function updateRuleDocPaths(oldPath: string, newPath?: string): number {
  if (!oldPath) return 0;
  const rooms = listRooms();
  let affected = 0;

  for (const room of rooms) {
    const current = room.ruleDocs;
    if (!current || current.length === 0 || !current.includes(oldPath)) continue;

    let next: string[];
    if (newPath) {
      next = current.map((p) => (p === oldPath ? newPath : p));
      // Deduplicate in case both oldPath and newPath existed.
      next = Array.from(new Set(next));
    } else {
      next = current.filter((p) => p !== oldPath);
    }

    if (next.length > 0) {
      room.ruleDocs = next;
    } else {
      delete room.ruleDocs;
    }

    writeFileSync(roomJsonPath(room.id), JSON.stringify(room, null, 2), "utf-8");
    affected += 1;
  }

  return affected;
}

/**
 * Cascade update for folder move: replace ruleDocs path prefix.
 * Example: oldPrefix="rules/dev", newPrefix="rules/protocols"
 *   rules/dev/a.md -> rules/protocols/a.md
 */
export function updateRuleDocPathsByPrefix(oldPrefix: string, newPrefix: string): number {
  if (!oldPrefix || !newPrefix) return 0;
  const needle = `${oldPrefix}/`;
  const rooms = listRooms();
  let affected = 0;

  for (const room of rooms) {
    const current = room.ruleDocs;
    if (!current || current.length === 0) continue;

    let touched = false;
    const next = current.map((p) => {
      if (p === oldPrefix || p.startsWith(needle)) {
        touched = true;
        return `${newPrefix}${p.slice(oldPrefix.length)}`;
      }
      return p;
    });

    if (!touched) continue;
    room.ruleDocs = Array.from(new Set(next));
    writeFileSync(roomJsonPath(room.id), JSON.stringify(room, null, 2), "utf-8");
    affected += 1;
  }

  return affected;
}

export function listRooms(): Room[] {
  ensureRoomsDir();

  const dir = roomsDir();
  if (!existsSync(dir)) return [];

  const entries = readDirSafe(dir);
  const rooms: Room[] = [];

  for (const entry of entries) {
    const path = roomJsonPath(entry);
    if (existsSync(path)) {
      try {
        rooms.push(JSON.parse(readFileSync(path, "utf-8")) as Room);
      } catch (err) {
        logger.error("room-store", "failed to parse room json", { roomId: entry, error: String(err) });
      }
    }
  }

  rooms.sort((a, b) => b.createdAt - a.createdAt);
  return rooms;
}

/** Authority read for user-facing lists: directory and room JSON errors are fatal. */
export function listRoomsStrict(): Room[] {
  ensureRoomsDir();
  const rooms = readdirSync(roomsDir())
    .map((entry) => roomJsonPath(entry))
    .filter(existsSync)
    .map((path) => JSON.parse(readFileSync(path, "utf-8")) as Room);
  rooms.sort((a, b) => b.createdAt - a.createdAt);
  return rooms;
}

// -- Cursors --

export function getCursors(roomId: string): CursorMap {
  const path = cursorsPath(roomId);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as CursorMap;
}

export function setCursor(roomId: string, agentName: string, cursor: string | null): void {
  const cursors = getCursors(roomId);
  cursors[agentName] = cursor;
  writeFileSync(cursorsPath(roomId), JSON.stringify(cursors, null, 2), "utf-8");
}

export function deleteCursor(roomId: string, agentName: string): void {
  const cursors = getCursors(roomId);
  if (cursors[agentName] === undefined) return;
  delete cursors[agentName];
  writeFileSync(cursorsPath(roomId), JSON.stringify(cursors, null, 2), "utf-8");
}

// -- Member management --

export function updateRoomMember(roomId: string, memberRef: string, patch: { config?: Partial<RoomMemberConfig> }): RoomMemberRecord | null {
  const room = getRoom(roomId);
  if (!room) return null;
  const member = findRoomMemberByRefInRoom(room, memberRef);
  if (!member) return null;
  const nextConfig = cleanMemberConfig({ ...(member.config || {}), ...(patch.config || {}) });
  const nextMember: RoomMemberRecord = {
    ...member,
    config: Object.keys(nextConfig).length > 0 ? nextConfig : undefined,
    updatedAt: Date.now(),
  };
  room.roomMembers = getRoomMembersFromRoom(room).map((entry) => entry.id === member.id ? nextMember : entry);
  writeRoom(room);
  return nextMember;
}

export function renameRoomMember(roomId: string, memberRef: string, nextNameRaw: string): { ok: true; member: RoomMemberRecord } | { ok: false; error: string; code: "not_found" | "invalid" | "duplicate" } {
  const room = getRoom(roomId);
  if (!room) return { ok: false, code: "not_found", error: "Room not found" };
  const member = findRoomMemberByRefInRoom(room, memberRef);
  if (!member) return { ok: false, code: "not_found", error: "Member is not in this room" };
  const nextName = normalizeMemberName(nextNameRaw);
  const validation = validateRoomMemberName(nextName);
  if (validation) return { ok: false, code: "invalid", error: validation };
  const duplicate = getRoomMembersFromRoom(room).find((entry) => entry.id !== member.id && entry.name === nextName);
  if (duplicate) return { ok: false, code: "duplicate", error: "Member name already exists in this room" };
  const nextMember = { ...member, name: nextName, updatedAt: Date.now() };
  room.roomMembers = getRoomMembersFromRoom(room).map((entry) => entry.id === member.id ? nextMember : entry);
  writeRoom(room);
  return { ok: true, member: nextMember };
}

function initializeMemberCursor(roomId: string, memberId: string): void {
  // Initialize cursor at latest message under stable memberId.
  const latestId = getLatestMessageIdInline(roomId);
  const cursors = getCursors(roomId);
  cursors[memberId] = latestId;
  writeFileSync(cursorsPath(roomId), JSON.stringify(cursors, null, 2), "utf-8");
}

export function addRoomMemberFromAgent(
  roomId: string,
  input: { agentName: string; memberName: string; config?: Partial<RoomMemberConfig> },
): { ok: true; member: RoomMemberRecord } | { ok: false; error: string; code: "not_found" | "invalid" | "duplicate" } {
  const room = getRoom(roomId);
  if (!room) return { ok: false, code: "not_found", error: "Room not found" };

  const agentName = normalizeMemberName(String(input.agentName || ""));
  if (!agentName) return { ok: false, code: "invalid", error: "agent name is required" };
  const agent = loadAgentDefinition(agentName);
  if (!agent) return { ok: false, code: "not_found", error: `Agent not found: ${agentName}` };

  const memberName = normalizeMemberName(String(input.memberName || ""));
  const validation = validateRoomMemberName(memberName);
  if (validation) return { ok: false, code: "invalid", error: validation };
  if (getRoomMembersFromRoom(room).some((member) => member.name === memberName)) {
    return { ok: false, code: "duplicate", error: "Member name already exists in this room" };
  }

  const member = buildDirectRoomMemberFromAgent(roomId, { agentName, memberName, config: input.config });
  // Ensure room-local agent copy exists (compile path is room-local only).
  const teamAgentsDir = join(roomDir(roomId), "team", "agents");
  mkdirSync(teamAgentsDir, { recursive: true });
  const destAgent = join(teamAgentsDir, `${agentName}.md`);
  if (!existsSync(destAgent)) {
    const globalPath = join(getBossmodeDir(), "agents", `${agentName}.md`);
    if (existsSync(globalPath)) {
      writeFileSync(destAgent, readFileSync(globalPath, "utf-8"), "utf-8");
    } else if (agent) {
      writeFileSync(
        destAgent,
        `---\nname: ${agent.name}\ndescription: ${JSON.stringify(agent.description || "")}\n---\n\n${agent.systemPrompt || ""}\n`,
        "utf-8",
      );
    }
  }
  if (!existsSync(join(roomDir(roomId), "team", "team.md"))) {
    writeTeamPackage(join(roomDir(roomId), "team"), {
      name: room.name,
      description: "Room team",
      version: "1.0.0",
      agents: readdirSync(teamAgentsDir).filter((f) => f.endsWith(".md")).map((f) => ({
        fileName: f,
        markdown: readFileSync(join(teamAgentsDir, f), "utf-8"),
      })),
    });
  }
  room.roomMembers = [...getRoomMembersFromRoom(room), member];
  writeRoom(room);
  initializeMemberCursor(roomId, member.id);
  return { ok: true, member };
}

export function addMember(roomId: string, agentName: string): boolean {
  const room = getRoom(roomId);
  if (!room) return false;
  const nextName = normalizeMemberName(agentName);
  if (validateRoomMemberName(nextName)) return false;
  if (getRoomMembersFromRoom(room).some((member) => member.name === nextName)) return false;

  const member = buildRoomMemberRecord(roomId, nextName);
  room.roomMembers = [...getRoomMembersFromRoom(room), member];
  writeRoom(room);
  initializeMemberCursor(roomId, member.id);

  return true;
}

// Inline helper to avoid circular dependency with message-store
function getLatestMessageIdInline(roomId: string): string | null {
  const path = messagesPath(roomId);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return null;
  const lines = content.split("\n");
  try {
    const msg = JSON.parse(lines[lines.length - 1]);
    return msg.id;
  } catch (err) {
    logger.error("room-store", "failed to parse last message", { roomId, error: String(err) });
    return null;
  }
}
