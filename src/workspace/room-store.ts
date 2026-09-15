import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "../shared/config.js";
import { latestMessage } from "../storage/message-repository.js";
import type { Room, CursorMap, RoomMemberOverride, RoomMemberRecord, RoomMemberConfig } from "../shared/types.js";
import { ConversationsRepository, getConversationMember as getMember } from "../storage/repositories/conversations.js";
export { ensureDmScope, ensureMmScope } from "../storage/repositories/conversations.js";
import { memberDir } from "./member-profile.js";
import { readWorkspaces } from "./workspace-registry.js";

function roomsDir(): string {
  return join(getBossmodeDir(), "rooms");
}

export function getRoomsDir(): string {
  return roomsDir();
}

export function roomDir(roomId: string): string {
  return join(roomsDir(), roomId);
}

/** Batch 7 P3: cwd is peeled on write — it exists on disk only until the
 * attachment migration has consumed it. */
function serializeRoom(room: Room): Room {
  const { cwd: _legacyCwd, ...rest } = room;
  return rest as Room;
}

function writeRoom(room: Room): void {
  room.members = getRoomMembersFromRoom(room).map((member) => member.name);
  new ConversationsRepository().upsertRoom(serializeRoom(room));
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
  if (Array.isArray(config.extensions) && config.extensions.length > 0) next.extensions = Array.from(new Set(config.extensions.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())));
  return next;
}

function buildRoomMemberRecord(roomId: string, memberName: string, override?: RoomMemberOverride, existingId?: string): RoomMemberRecord {
  const now = Date.now();
  // Legacy member config must already be materialized by the explicit migration.
  const config = cleanMemberConfig(override || {});
  return {
    id: existingId || createRoomMemberId(),
    roomId,
    name: memberName,
    sourceAgent: memberName,
    ...(Object.keys(config).length > 0 ? { config } : {}),
    createdAt: now,
    updatedAt: now,
    migratedFrom: { memberName },
  };
}

export function getRoomMembersFromRoom(room: Room): RoomMemberRecord[] {
  // 0.20 G3 cutover: globalMemberIds is membership authority. Synthesize records with id=mem_*.
  if (Array.isArray(room.globalMemberIds)) {
    const out: RoomMemberRecord[] = [];
    for (const gid of room.globalMemberIds) {
      const g = getMember(gid);
      if (!g) continue;
      const shadow = Array.isArray(room.roomMembers)
        ? room.roomMembers.find((m) => m.sourceMemberId === gid || m.id === gid)
        : undefined;
      out.push({
        id: gid,
        roomId: room.id,
        name: g.name,
        sourceAgent: g.agentTemplate || "general",
        sourceMemberId: gid,
        // Config lives on global registry (effective-config); do not rehydrate shadow config.
        createdAt: shadow?.createdAt ?? g.createdAt,
        updatedAt: g.updatedAt,
      });
    }
    return out;
  }
  // Legacy: roomMembers array, then members: string[].
  if (Array.isArray(room.roomMembers)) {
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

/** Batch 7 P3: rooms no longer bind a cwd — attachment/artifact path policy
 * covers each room member's home directory and all their workspace roots. */
export function roomMemberAssetRoots(roomId: string): string[] {
  const room = getRoom(roomId);
  if (!room) return [];
  const ids = new Set<string>();
  for (const m of getRoomMembersFromRoom(room)) ids.add(m.id);
  for (const gid of room.globalMemberIds ?? []) ids.add(gid);
  const roots: string[] = [];
  for (const id of ids) {
    roots.push(memberDir(id));
    try {
      const reg = readWorkspaces(id);
      for (const w of reg.workspaces) roots.push(w.root);
    } catch { /* synthesized on read — ignore */ }
  }
  return roots;
}

/** Create membership and leadership together from existing stable contact IDs. */
export function createRoom(name: string, cwd: string | undefined, memberIds: string[], ruleDocs?: string[], opts?: {
  promptLeaderMemberId?: string;
  docsPath?: string | null;
  description?: string | null;
}): Room {
  const repository = new ConversationsRepository();
  repository.db.assertOutsideTransaction();
  if (!Array.isArray(memberIds) || memberIds.some(id => typeof id !== "string" || !id || id.trim() !== id)) {
    throw new Error("memberIds must contain stable member IDs");
  }
  const ids = [...new Set(memberIds)];
  for (const id of ids) if (!getMember(id)) throw new Error(`Member not found: ${id}`);
  const leader = opts?.promptLeaderMemberId ?? ids[0];
  if (leader && !ids.includes(leader)) throw new Error("leaderMemberId must be one of memberIds");
  const roomDescription = typeof opts?.description === "string" ? opts.description.trim() : "";
  if (roomDescription.length > ROOM_DESCRIPTION_MAX_CHARS) {
    throw new Error(`description must be ${ROOM_DESCRIPTION_MAX_CHARS} characters or fewer`);
  }
  const room: Room = {
    id: randomUUID(), name,
    members: [], globalMemberIds: ids,
    ...(leader ? { promptLeaderMemberId: leader, promptLeaderGlobalMemberId: leader } : {}),
    docsPath: normalizeRoomDocsPath(opts?.docsPath) || slugifyRoomDocsPath(name),
    ...(roomDescription ? { description: roomDescription } : {}),
    createdAt: Date.now(),
    ...(ruleDocs?.length ? { ruleDocs } : {}),
  };
  // Working directories belong to member workspaces; cwd is not persisted.
  mkdirSync(roomDir(room.id), { recursive: true });
  if (room.docsPath) mkdirSync(join(getBossmodeDir(), "memory", "projects", room.docsPath), { recursive: true });
  repository.db.transaction(() => {
    writeRoom(room);
    for (const id of ids) repository.setCursor(room.id, id, null);
  });
  return room;
}

export function getRoom(roomId: string): Room | null {
  const room = new ConversationsRepository().getRoom(roomId);
  if (room && Array.isArray(room.globalMemberIds)) room.members = getRoomMembersFromRoom(room).map(member => member.name);
  return room;
}

/**
 * Replace authoritative global membership. Historical shadows never determine the roster.
 * Safe to call repeatedly (overwrite); cursor moves require explicit source IDs.
 */
export function stampGlobalMemberIds(
  roomId: string,
  globalMemberIds: string[],
  promptLeaderGlobalMemberId?: string | null,
): Room | null {
  return new ConversationsRepository().db.transaction(() => {
    const room = getRoom(roomId);
    if (!room) return null;
    room.globalMemberIds = Array.from(new Set(globalMemberIds.filter(Boolean)));
    if (promptLeaderGlobalMemberId) {
      room.promptLeaderGlobalMemberId = promptLeaderGlobalMemberId;
      room.promptLeaderMemberId = promptLeaderGlobalMemberId; // leader id is mem_* after cutover
    } else if (promptLeaderGlobalMemberId === null) {
      delete room.promptLeaderGlobalMemberId;
      delete room.promptLeaderMemberId;
    }
    // Preserve historical shadows as source metadata, not active membership.
    migrateCursorsToGlobalIds(room);
    if (room.globalMemberIds.length > 0) {
      room.members = room.globalMemberIds
        .map((id) => getMember(id)?.name)
        .filter((n): n is string => Boolean(n));
    }
    writeRoom(room);
    return room;
  });
}

/** Rekey only proven historical IDs; unresolved actor keys remain historical. */
function migrateCursorsToGlobalIds(room: Room): void {
  const repository = new ConversationsRepository();
  const cursors = repository.getCursors(room.id);
  repository.db.transaction(() => {
    for (const local of room.roomMembers ?? []) {
      const gid = local.sourceMemberId;
      if (!gid || local.id === gid || !(local.id in cursors)) continue;
      if (!(gid in cursors)) repository.setCursor(room.id, gid, cursors[local.id]);
      repository.deleteCursor(room.id, local.id);
    }
  });
}

/**
 * Resolve the global mem_* id for a local room member.
 * Only explicit stable links are accepted. Historical labels are never identity evidence.
 */
export function resolveGlobalMemberId(
  room: Room,
  local: Pick<RoomMemberRecord, "id" | "name" | "sourceMemberId">,
): string | null {
  if (local.sourceMemberId && /^mem_/.test(local.sourceMemberId)) {
    // Prefer explicit link even if globalMemberIds not yet stamped (invite race).
    return local.sourceMemberId;
  }
  return local.id.startsWith("mem_") && room.globalMemberIds?.includes(local.id) ? local.id : null;
}

export function deleteRoom(roomId: string): boolean {
  if (!new ConversationsRepository().deleteRoom(roomId)) return false;
  rmSync(roomDir(roomId), { recursive: true, force: true });
  return true;
}

export function updateRoomName(roomId: string, name: string): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  room.name = name;
  writeRoom(room);
  return room;
}


export function updateRoomPromptLeader(roomId: string, promptLeaderMemberId: string | null): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  if (promptLeaderMemberId === null || promptLeaderMemberId === "") {
    delete room.promptLeaderMemberId;
    delete room.promptLeaderGlobalMemberId;
    writeRoom(room);
    return room;
  }
  const member = findRoomMemberByIdInRoom(room, promptLeaderMemberId);
  if (!member) throw new Error("promptLeaderMemberId must be a current room member");
  room.promptLeaderMemberId = member.id;
  if (Array.isArray(room.globalMemberIds)) room.promptLeaderGlobalMemberId = member.id;
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

export function getRoomMemberOverride(roomId: string, memberName: string): RoomMemberOverride | undefined {
  const room = getRoom(roomId);
  if (!room) return undefined;
  const member = findRoomMemberByNameInRoom(room, memberName);
  // Current members have global DB settings, not room-local overrides.
  if (member?.id.startsWith("mem_") || member?.sourceMemberId?.startsWith("mem_")) return undefined;
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

function applyConfigPatch(current: RoomMemberConfig, patch: { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null; extensions?: string[] | null }): RoomMemberConfig {
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
  if (Object.prototype.hasOwnProperty.call(patch, "extensions")) {
    if (Array.isArray(patch.extensions) && patch.extensions.length > 0) next.extensions = Array.from(new Set(patch.extensions.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim())));
    else delete next.extensions;
  }
  return cleanMemberConfig(next);
}

export function updateRoomMemberOverride(roomId: string, memberRef: string, patch: { model?: string | null; credentialId?: string | null; thinkingLevel?: string | null; mcpServers?: string[] | null; extensions?: string[] | null }): Room | null {
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
  writeRoom(room);
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

    new ConversationsRepository().upsertRoom(serializeRoom(room));
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
    new ConversationsRepository().upsertRoom(serializeRoom(room));
    affected += 1;
  }

  return affected;
}

/** ⑤ A: room description (name + description) — product cap on every write. */
export const ROOM_DESCRIPTION_MAX_CHARS = 2000;

/** Set or clear the room description. Empty string clears the field. */
export function updateRoomDescription(roomId: string, description: string): Room | null {
  const room = getRoom(roomId);
  if (!room) return null;
  const next = String(description ?? "").trim();
  if (next.length > ROOM_DESCRIPTION_MAX_CHARS) {
    throw new Error(`description must be ${ROOM_DESCRIPTION_MAX_CHARS} characters or fewer`);
  }
  if (next) room.description = next;
  else delete room.description;
  writeRoom(room);
  return room;
}

export function listRooms(): Room[] {
  return new ConversationsRepository().listRooms().map(room => {
    if (Array.isArray(room.globalMemberIds)) room.members = getRoomMembersFromRoom(room).map(member => member.name);
    return room;
  });
}

export function listRoomsStrict(): Room[] { return listRooms(); }

/** Member↔member chat scopes involving `memberId` (⑤ B). */
export function listMmScopesForMember(memberId: string): string[] {
  return new ConversationsRepository().listMmScopesForMember(memberId);
}

// -- Cursors --
export function getCursors(roomId: string): CursorMap {
  return new ConversationsRepository().getCursors(roomId);
}

export function setCursor(roomId: string, agentName: string, cursor: string | null): void {
  new ConversationsRepository().setCursor(roomId, agentName, cursor);
}

export function deleteCursor(roomId: string, agentName: string): void {
  new ConversationsRepository().deleteCursor(roomId, agentName);
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

function initializeMemberCursor(roomId: string, memberId: string): void {
  // Initialize cursor at latest message under stable memberId.
  const latestId = latestMessage(roomId)?.id ?? null;
  setCursor(roomId, memberId, latestId);
}

/** Append global member id onto room.globalMemberIds if missing. */
export function addGlobalMemberId(roomId: string, globalMemberId: string): Room | null {
  const room = getRoom(roomId);
  if (!room || !globalMemberId) return null;
  const ids = new Set(room.globalMemberIds || []);
  ids.add(globalMemberId);
  room.globalMemberIds = [...ids];
  writeRoom(room);
  return room;
}

export function removeGlobalMemberId(roomId: string, globalMemberId: string): Room | null {
  const room = getRoom(roomId);
  if (!room || !globalMemberId) return null;
  room.globalMemberIds = (room.globalMemberIds || []).filter((id) => id !== globalMemberId);
  if (room.promptLeaderMemberId === globalMemberId) delete room.promptLeaderMemberId;
  if (room.promptLeaderGlobalMemberId === globalMemberId) {
    delete room.promptLeaderGlobalMemberId;
  }
  writeRoom(room);
  return room;
}

/**
 * 0.20 invite: attach an existing global member to a room (by mem_ id).
 * Uses stable identity from the member registry and replaces relational membership.
 */
export function inviteGlobalMember(
  roomId: string,
  global: { id: string; name: string; agentTemplate: string; config?: Partial<RoomMemberConfig> },
): { ok: true; member: RoomMemberRecord } | { ok: false; error: string; code: "not_found" | "invalid" | "duplicate" } {
  return new ConversationsRepository().db.transaction((): ReturnType<typeof inviteGlobalMember> => {
    const room = getRoom(roomId);
    if (!room) return { ok: false, code: "not_found", error: "Room not found" };
    if ((room.globalMemberIds || []).includes(global.id)) {
      return { ok: false, code: "duplicate", error: "Member already in this room" };
    }
    const identity = getMember(global.id);
    if (!identity) return { ok: false, code: "not_found", error: "Member not found" };
    const memberName = identity.name;
    if (getRoomMembersFromRoom(room).some((m) => m.name === memberName)) {
      return { ok: false, code: "duplicate", error: "Member name already exists in this room" };
    }
    const agentName = identity.agentTemplate;
    // Existing DB members join by ID. No room-local copies or second name rule.
    stampGlobalMemberIds(roomId, [...(room.globalMemberIds || []), global.id]);
    initializeMemberCursor(roomId, global.id);
    const synthesized = getRoomMembers(roomId).find((m) => m.id === global.id || m.sourceMemberId === global.id);
    if (!synthesized) {
      return {
        ok: true,
        member: {
          id: global.id,
          roomId,
          name: memberName,
          sourceAgent: agentName,
          sourceMemberId: global.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }
    return { ok: true, member: synthesized };
  });
}

export function removeRoomMemberByRef(
  roomId: string,
  memberRef: string,
  opts?: { globalMemberId?: string },
): { ok: true; removed: RoomMemberRecord } | { ok: false; error: string } {
  return new ConversationsRepository().db.transaction((): ReturnType<typeof removeRoomMemberByRef> => {
    const room = getRoom(roomId);
    if (!room) return { ok: false, error: "Room not found" };
    const member = findRoomMemberByRefInRoom(room, memberRef);
    if (!member) return { ok: false, error: "Member is not in this room" };

    const gid = opts?.globalMemberId
      || resolveGlobalMemberId(room, member)
      || (member.id.startsWith("mem_") ? member.id : undefined)
      || (memberRef.startsWith("mem_") ? memberRef : undefined);

    // G3: membership authority is globalMemberIds
    if (gid) {
      room.globalMemberIds = (room.globalMemberIds || []).filter((id) => id !== gid);
      if (room.promptLeaderGlobalMemberId === gid) delete room.promptLeaderGlobalMemberId;
      if (room.promptLeaderMemberId === gid || room.promptLeaderMemberId === member.id) {
        delete room.promptLeaderMemberId;
      }
    }
    if (Array.isArray(room.roomMembers)) {
      // An absent global link is not a match for every unlinked local snapshot.
      // Keep unrelated source records even when global membership is authoritative.
      room.roomMembers = room.roomMembers.filter((m) => m.id !== member.id && (!gid || m.sourceMemberId !== gid));
    }
    room.members = (room.globalMemberIds?.length
      ? room.globalMemberIds.map((id) => getMember(id)?.name).filter((n): n is string => Boolean(n))
      : (room.members || []).filter((n) => n !== member.name));
    writeRoom(room);
    // Drop cursor for this member (mem_* or legacy key)
    deleteCursor(roomId, member.id);
    if (gid && gid !== member.id) deleteCursor(roomId, gid);
    return { ok: true, removed: member };
  });
}
