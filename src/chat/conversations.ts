import { documentsRoot, memberDir, roomDir } from "../files/layout.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
export interface RoomMemberRecord {
  id: string;
  roomId?: string;
  name: string;
  sourceAgent: string;
  sourceMemberId?: string;
  avatar?: string;
  createdAt: number;
  updatedAt: number;
  migratedFrom?: { memberName: string; memberId?: string };
}
export interface Room {
  id: string;
  name: string;
  cwd?: string;
  members: string[];
  promptLeaderMemberId?: string;
  docsPath?: string;
  description?: string;
  roomMembers?: RoomMemberRecord[];
  globalMemberIds?: string[];
  promptLeaderGlobalMemberId?: string;
  createdAt: number;
  ruleDocs?: string[];
}
import { newRoomId } from "../kernel/ids.js";
import { getDatabase, type Database } from "../data/database.js";

/** Batch 7 P3: cwd is peeled on write — it exists on disk only until the
 * attachment migration has consumed it. */
function serializeRoom(room: Room): Room {
  const { cwd: _legacyCwd, ...rest } = room;
  return rest as Room;
}

function writeRoom(room: Room): void {
  room.members = getRoomMembersFromRoom(room).map((member) => member.name);
  storeRoom(serializeRoom(room), getDatabase());
}

export function getRoomMembersFromRoom(room: Room): RoomMemberRecord[] {
  // 0.20 G3 cutover: globalMemberIds is membership authority. Synthesize records with id=mem_*.
  if (Array.isArray(room.globalMemberIds)) {
    const out: RoomMemberRecord[] = [];
    for (const gid of room.globalMemberIds) {
      const g = conversationMember(gid);
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
  const now = Date.now();
  return (room.members || []).map((name) => ({ id: name, roomId: room.id, name, sourceAgent: name,
    createdAt: now, updatedAt: now, migratedFrom: { memberName: name } }));
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
/** Member-owned local roots; workspace roots are authorized by the app host. */
export function memberAssetRoots(memberIds: Iterable<string>): string[] {
  return [...new Set(memberIds)].map(memberDir);
}

export function roomMemberAssetRoots(roomId: string): string[] {
  const room = getRoom(roomId);
  if (!room) return [];
  const ids = new Set<string>();
  for (const m of getRoomMembersFromRoom(room)) ids.add(m.id);
  for (const gid of room.globalMemberIds ?? []) ids.add(gid);
  return memberAssetRoots(ids);
}

/** Asset roots for any chat scope: rooms use their roster; dm/mm use the participant members. */
export function chatScopeAssetRoots(scope: string): string[] {
  const ref = parseConversation(scope);
  if (!ref) return [];
  if (ref.kind === "mm") return memberAssetRoots(ref.memberIds);
  if (ref.kind === "dm") return memberAssetRoots([ref.memberId]);
  return roomMemberAssetRoots(ref.roomId);
}

/** Create membership and leadership together from existing stable contact IDs. */
export function createRoom(name: string, memberIds: string[], opts?: {
  promptLeaderMemberId?: string;
  docsPath?: string | null;
  description?: string | null;
}): Room {
  const repository = getDatabase();
  repository.assertOutsideTransaction();
  if (!Array.isArray(memberIds) || memberIds.some(id => typeof id !== "string" || !id || id.trim() !== id)) {
    throw new Error("memberIds must contain stable member IDs");
  }
  const ids = [...new Set(memberIds)];
  for (const id of ids) if (!conversationMember(id)) throw new Error(`Member not found: ${id}`);
  const leader = opts?.promptLeaderMemberId ?? ids[0];
  if (leader && !ids.includes(leader)) throw new Error("leaderMemberId must be one of memberIds");
  const roomDescription = typeof opts?.description === "string" ? opts.description.trim() : "";
  if (roomDescription.length > ROOM_DESCRIPTION_MAX_CHARS) {
    throw new Error(`description must be ${ROOM_DESCRIPTION_MAX_CHARS} characters or fewer`);
  }
  // Batch 5: fresh room ids are `rm_<nanoid10>`. Legacy room-member records keep
  // their `rm_<uuid>` form (distinguishable by shape). Bounded retry on an occupied
  // identity; the mkdir below still fails loudly on any residual collision.
  let id = newRoomId();
  for (let attempts = 0; attempts < 10 && (readStoredRoom(id, repository) || existsSync(roomDir(id))); attempts++) id = newRoomId();
  const room: Room = {
    id, name,
    members: [], globalMemberIds: ids,
    ...(leader ? { promptLeaderMemberId: leader, promptLeaderGlobalMemberId: leader } : {}),
    docsPath: normalizeRoomDocsPath(opts?.docsPath) || slugifyRoomDocsPath(name),
    ...(roomDescription ? { description: roomDescription } : {}),
    createdAt: Date.now(),
  };
  // Working directories belong to member workspaces; cwd is not persisted.
  mkdirSync(roomDir(room.id), { recursive: true });
  if (room.docsPath) mkdirSync(join(documentsRoot(), room.docsPath), { recursive: true });
  repository.transaction(() => {
    writeRoom(room);
    for (const id of ids) storeMemberCursor(room.id, id, null, undefined, repository);
  });
  return room;
}

export function getRoom(roomId: string): Room | null {
  const room = readStoredRoom(roomId, getDatabase());
  if (room && Array.isArray(room.globalMemberIds)) room.members = getRoomMembersFromRoom(room).map(member => member.name);
  return room;
}

export function deleteRoom(roomId: string): boolean {
  if (!deleteStoredRoom(roomId, getDatabase())) return false;
  rmSync(roomDir(roomId), { recursive: true, force: true });
  return true;
}

export function updateRoomName(roomId: string, name: string): Room | null {
  return changeRoom(roomId, room => { room.name = name; });
}

export function updateRoomPromptLeader(roomId: string, memberId: string | null): Room | null {
  return changeRoom(roomId, room => {
    if (!memberId) { delete room.promptLeaderMemberId; delete room.promptLeaderGlobalMemberId; return; }
    const member = findRoomMemberByIdInRoom(room, memberId);
    if (!member) throw new Error("promptLeaderMemberId must be a current room member");
    room.promptLeaderMemberId = member.id;
    if (Array.isArray(room.globalMemberIds)) room.promptLeaderGlobalMemberId = member.id;
  });
}

export function updateRoomDocsPath(roomId: string, docsPath: string | null): Room | null {
  return changeRoom(roomId, room => {
    const normalized = normalizeRoomDocsPath(docsPath);
    if (normalized) room.docsPath = normalized;
    else delete room.docsPath;
  });
}

function findRoomMemberByIdInRoom(room: Room, memberId: string): RoomMemberRecord | null {
  return getRoomMembersFromRoom(room).find(member => member.id === memberId || member.sourceMemberId === memberId) || null;
}

export function getRoomMembers(roomId: string): RoomMemberRecord[] {
  const room = readStoredRoom(roomId);
  return room ? getRoomMembersFromRoom(room) : [];
}

export function resolveRoomMember(roomId: string, memberId: string): RoomMemberRecord | null {
  const room = readStoredRoom(roomId);
  return room ? findRoomMemberByIdInRoom(room, memberId) : null;
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
  return changeRuleDocPaths(path => path === oldPath, () => newPath || undefined, Boolean(newPath));
}

/**
 * Cascade update for folder move: replace ruleDocs path prefix.
 * Example: oldPrefix="rules/dev", newPrefix="rules/protocols"
 *   rules/dev/a.md -> rules/protocols/a.md
 */
export function updateRuleDocPathsByPrefix(oldPrefix: string, newPrefix: string): number {
  if (!oldPrefix || !newPrefix) return 0;
  return changeRuleDocPaths(path => path === oldPrefix || path.startsWith(oldPrefix + "/"), path => newPrefix + path.slice(oldPrefix.length));
}

/** ⑤ A: room description (name + description) — product cap on every write. */
export const ROOM_DESCRIPTION_MAX_CHARS = 2000;

/** Set or clear the room description. Empty string clears the field. */
export function updateRoomDescription(roomId: string, description: string): Room | null {
  return changeRoom(roomId, room => {
    const next = String(description ?? "").trim();
    if (next.length > ROOM_DESCRIPTION_MAX_CHARS) throw new Error(`description must be ${ROOM_DESCRIPTION_MAX_CHARS} characters or fewer`);
    if (next) room.description = next;
    else delete room.description;
  });
}

export function listRooms(): Room[] {
  return listStoredRooms(getDatabase()).map(room => {
    if (Array.isArray(room.globalMemberIds)) room.members = getRoomMembersFromRoom(room).map(member => member.name);
    return room;
  });
}



/** Member↔member chat scopes involving `memberId` (⑤ B). */
export function listMmScopesForMember(memberId: string): string[] {
  return readMemberChatScopes(memberId, getDatabase());
}

// -- Cursors --
export function setCursor(roomId: string, agentName: string, cursor: string | null): void {
  storeMemberCursor(roomId, agentName, cursor, undefined, getDatabase());
}

export function deleteCursor(roomId: string, agentName: string): void {
  deleteMemberCursor(roomId, agentName, getDatabase());
}

// -- Member management --



function initializeMemberCursor(roomId: string, memberId: string): void {
  // Initialize cursor at the latest durable fact under the stable member ID.
  const latestId = getDatabase().get<{ id: string }>(
    "SELECT id FROM messages WHERE scope_id=? ORDER BY seq DESC LIMIT 1", roomId,
  )?.id ?? null;
  setCursor(roomId, memberId, latestId);
}

/**
 * 0.20 invite: attach an existing global member to a room (by mem_ id).
 * Uses stable identity from the member registry and replaces relational membership.
 */
export function inviteRoomMember(
  roomId: string,
  memberId: string,
): { ok: true; member: RoomMemberRecord } | { ok: false; error: string; code: "not_found" | "duplicate" } {
  return getDatabase().transaction((): ReturnType<typeof inviteRoomMember> => {
    const room = getRoom(roomId);
    if (!room) return { ok: false, code: "not_found", error: "Room not found" };
    if ((room.globalMemberIds || []).includes(memberId)) return { ok: false, code: "duplicate", error: "Member already in this room" };
    const identity = conversationMember(memberId);
    if (!identity) return { ok: false, code: "not_found", error: "Member not found" };
    room.globalMemberIds = [...(room.globalMemberIds || []), memberId];
    room.members = room.globalMemberIds.map(id => conversationMember(id)?.name).filter((name): name is string => Boolean(name));
    writeRoom(room);
    initializeMemberCursor(roomId, memberId);
    return { ok: true, member: { id: memberId, roomId, name: identity.name, sourceAgent: identity.agentTemplate,
      sourceMemberId: memberId, createdAt: identity.createdAt, updatedAt: identity.updatedAt } };
  });
}

export function removeRoomMember(
  roomId: string,
  memberId: string,
): { ok: true; removed: RoomMemberRecord } | { ok: false; error: string } {
  return getDatabase().transaction((): ReturnType<typeof removeRoomMember> => {
    const room = getRoom(roomId);
    if (!room) return { ok: false, error: "Room not found" };
    const member = findRoomMemberByIdInRoom(room, memberId);
    if (!member) return { ok: false, error: "Member is not in this room" };
    const gid = member.sourceMemberId?.startsWith("mem_") ? member.sourceMemberId
      : member.id.startsWith("mem_") ? member.id : undefined;

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
      ? room.globalMemberIds.map((id) => conversationMember(id)?.name).filter((n): n is string => Boolean(n))
      : (room.members || []).filter((n) => n !== member.name));
    writeRoom(room);
    // Drop cursor for this member (mem_* or legacy key)
    deleteCursor(roomId, member.id);
    if (gid && gid !== member.id) deleteCursor(roomId, gid);
    return { ok: true, removed: member };
  });
}

/** Detach only explicit member identities; retain unrelated room and historical fields. */
export function detachMemberFromConversations(memberId: string, db: import("../data/database.js").Database): void {
  // B owns room persistence. Preserve all labels/local historical records and unrelated room fields.
  const conversations = db;
  for (const room of listStoredRooms(conversations)) {
    // Global rosters treat local records as historical shadows. In a still-local roster,
    // detach only records explicitly linked by ID, never a matching display label.
    const localIds = new Set(room.globalMemberIds === undefined
      ? (room.roomMembers ?? []).filter(m => m.id === memberId || m.sourceMemberId === memberId).map(m => m.id)
      : []);
    const isLeader = room.promptLeaderMemberId === memberId || (room.promptLeaderMemberId !== undefined && localIds.has(room.promptLeaderMemberId));
    if (!room.globalMemberIds?.includes(memberId) && !localIds.size && !isLeader && room.promptLeaderGlobalMemberId !== memberId) continue;
    if (room.globalMemberIds) room.globalMemberIds = room.globalMemberIds.filter(id => id !== memberId);
    else if (localIds.size) room.roomMembers = room.roomMembers!.filter(m => !localIds.has(m.id));
    if (isLeader) delete room.promptLeaderMemberId;
    if (room.promptLeaderGlobalMemberId === memberId) delete room.promptLeaderGlobalMemberId;
    storeRoom(room, conversations);
  }
}

export interface ConversationMemberIdentity {
  id: string; name: string; agentTemplate: string; createdAt: number; updatedAt: number;
}

let memberDirectory: { read(id: string, retained?: boolean): ConversationMemberIdentity | null } | undefined;

/** The application supplies current identity; conversations never query member tables. */
export function connectConversationMembers(read: (id: string, retained?: boolean) => ConversationMemberIdentity | null): () => void {
  const connection = { read };
  memberDirectory = connection;
  return () => { if (memberDirectory === connection) memberDirectory = undefined; };
}

export function conversationMember(id: string, retained = false): ConversationMemberIdentity | null {
  if (!memberDirectory) throw new Error("Conversation member directory is not connected");
  return memberDirectory.read(id, retained);
}

/** Canonical serialized conversation source. */
export type ScopeId = string;

const DM_PREFIX = "dm:";

const ROOM_PREFIX = "room:";

const MM_PREFIX = "mm:";

/** Canonical conversation identity used by all new chat capabilities. Bare room
 * ids remain the storage key; public/source refs always use `room:<id>`. */
export type ConversationIdentity =
  | { kind: "room"; scopeId: ScopeId; roomId: string }
  | { kind: "dm"; scopeId: ScopeId; memberId: string }
  | { kind: "mm"; scopeId: ScopeId; memberIds: [string, string] };

/**
 * Member↔member private chat scope (⑤ B, 2026-09-15): `mm:` + the two member ids
 * sorted and joined by a single dash. `mem_` appears exactly once per id in both
 * generations (legacy `mem_<uuid>` ids keep their dashes; current ids are
 * `mem_<nanoid10>`), so the pair splits at the second `mem_` occurrence; canonical
 * order is enforced on parse.
 */
export function mmScopeIdOf(memberA: string, memberB: string): ScopeId {
  if (!memberA || !memberB || memberA === memberB) throw new Error("mm scope requires two distinct member ids");
  const [a, b] = memberA < memberB ? [memberA, memberB] : [memberB, memberA];
  return `${MM_PREFIX}${a}-${b}`;
}

/** Parse a `mm:` scope id into its canonical [memberA, memberB] pair, or null. */
export function parseMmScopeId(scope: string): [string, string] | null {
  if (typeof scope !== "string" || !scope.startsWith(MM_PREFIX)) return null;
  const body = scope.slice(MM_PREFIX.length);
  const second = body.indexOf("mem_", 1);
  if (second <= 0 || body[second - 1] !== "-") return null;
  const a = body.slice(0, second - 1);
  const b = body.slice(second);
  if (!isMemberId(a) || !isMemberId(b) || a === b) return null;
  const [x, y] = a < b ? [a, b] : [b, a];
  return x === a && y === b ? [x, y] : null;
}

export function isMmScopeId(scope: string): boolean {
  return typeof scope === "string" && scope.startsWith(MM_PREFIX);
}

/** One parser for the target chat model. Accepts a canonical public/source ref
 * or a bare room storage id and rejects malformed/non-canonical pair ids. */
export function parseConversation(value: string): ConversationIdentity | null {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  if (value.startsWith(DM_PREFIX)) {
    const memberId = value.slice(DM_PREFIX.length);
    return isMemberId(memberId) ? { kind: "dm", scopeId: `${DM_PREFIX}${memberId}`, memberId } : null;
  }
  if (value.startsWith(MM_PREFIX)) {
    const memberIds = parseMmScopeId(value);
    return memberIds ? { kind: "mm", scopeId: mmScopeIdOf(memberIds[0], memberIds[1]), memberIds } : null;
  }
  const roomId = value.startsWith(ROOM_PREFIX) ? value.slice(ROOM_PREFIX.length) : value;
  if (!roomId || roomId.includes(":") || /[/\\]/.test(roomId) || [".", ".."].includes(roomId)) return null;
  return { kind: "room", scopeId: `${ROOM_PREFIX}${roomId}`, roomId };
}

/** Database key used by scopes/messages/cursors. */
export function storageScopeId(value: string): string {
  const ref = parseConversation(value);
  if (!ref) throw new Error(`Invalid conversation: ${value}`);
  return ref.kind === "room" ? ref.roomId : ref.scopeId;
}

/** Wide member-id check: recognizes legacy `mem_<uuid>` and current `mem_<nanoid10>` ids. */
export function isMemberId(id: string): boolean {
  return typeof id === "string" && /^mem_[A-Za-z0-9-]+$/.test(id);
}

interface ScopeRow { id: string; kind: "room" | "dm" | "mm"; room_id: string | null; member_id: string | null }

interface RoomRow {
  id: string; name: string; created_at: number; legacy_cwd: string | null;
  docs_path: string | null; description: string | null; leader_member_id: string | null; leader_global_member_id: string | null;
  roster_kind: "global" | "local" | "names"; has_local_records: number; has_rule_docs: number; has_overrides: number;
}

interface SnapshotRow {
  id: string; name: string; source_agent: string; source_member_id: string | null; avatar: string | null;
  created_at: number; updated_at: number; migrated_name: string | null; migrated_id: string | null;
}

/** Historical references deliberately have no FK to live members. Never resolve names here. */
function ensureConversationScope(id: string, kind: ScopeRow["kind"], roomId: string | null, memberId: string | null, db: Database = getDatabase()): void {
    const previous = db.get<ScopeRow>("SELECT * FROM scopes WHERE id=?", id);
    if (previous) {
      if (previous.kind !== kind || previous.room_id !== roomId || previous.member_id !== memberId) {
        throw new Error(`Scope ownership cannot change: ${id}`);
      }
      return;
    }
    db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES (?,?,?,?)", id, kind, roomId, memberId);
  }

export function ensureDmScope(memberId: string, db: Database = getDatabase()): string {
    if (!memberId) throw new Error("DM scope requires a stable member ID");
    const id = `dm:${memberId}`;
    ensureConversationScope(id, "dm", null, memberId, db);
    return id;
  }

export function ensureMmScope(memberA: string, memberB: string, db: Database = getDatabase()): string {
    const id = mmScopeIdOf(memberA, memberB);
    const [a, b] = memberA < memberB ? [memberA, memberB] : [memberB, memberA];
    ensureConversationScope(id, "mm", null, `${a}|${b}`, db);
    return id;
  }

type LegacyRoomInput = Room & {
  roomMembers?: Array<RoomMemberRecord & { config?: unknown }>;
  memberOverrides?: Record<string, unknown>;
};

export function storeRoom(room: Room, db: Database = getDatabase()): void {
    if (!room.id || room.id.startsWith("room:") || room.id.startsWith("dm:")) throw new Error("Room scope must use the bare room ID");
    const legacy = room as LegacyRoomInput;
    db.transaction(() => {
      ensureConversationScope(room.id, "room", room.id, null, db);
      const configs = new Map(db.all<{id: string; config_json: string | null}>(
        "SELECT id,config_json FROM room_member_snapshots WHERE room_id=?", room.id).map(row => [row.id, row.config_json]));
      db.run(`INSERT INTO rooms(id,name,created_at,legacy_cwd,docs_path,description,leader_member_id,leader_global_member_id,
        roster_kind,has_local_records,has_rule_docs,has_overrides) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,created_at=excluded.created_at,legacy_cwd=excluded.legacy_cwd,
        docs_path=excluded.docs_path,description=excluded.description,leader_member_id=excluded.leader_member_id,leader_global_member_id=excluded.leader_global_member_id,
        roster_kind=excluded.roster_kind,has_local_records=excluded.has_local_records,has_rule_docs=excluded.has_rule_docs`,
        room.id, room.name, room.createdAt, room.cwd ?? null, room.docsPath ?? null, room.description ?? null, room.promptLeaderMemberId ?? null,
        room.promptLeaderGlobalMemberId ?? null, Array.isArray(room.globalMemberIds) ? "global" : Array.isArray(room.roomMembers) ? "local" : "names",
        Number(Array.isArray(room.roomMembers)), Number(Array.isArray(room.ruleDocs)), Number(legacy.memberOverrides !== undefined));
      for (const table of ["room_members", "room_member_labels", "room_member_snapshots", "room_rule_docs"]) db.run(`DELETE FROM ${table} WHERE room_id=?`, room.id);
      [...new Set(room.globalMemberIds ?? [])].forEach((id, i) => db.run("INSERT INTO room_members VALUES (?,?,?)", room.id, id, i));
      (room.members ?? []).forEach((label, i) => db.run("INSERT INTO room_member_labels VALUES (?,?,?)", room.id, i, label));
      (legacy.roomMembers ?? []).forEach((m, i) => {
        const config = (m as RoomMemberRecord & { config?: unknown }).config;
        db.run(`INSERT INTO room_member_snapshots
          (room_id,position,id,name,source_agent,source_member_id,avatar,created_at,updated_at,migrated_name,migrated_id,config_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, room.id, i, m.id, m.name, m.sourceAgent, m.sourceMemberId ?? null,
          m.avatar ?? null, m.createdAt, m.updatedAt, m.migratedFrom?.memberName ?? null, m.migratedFrom?.memberId ?? null,
          config === undefined ? configs.get(m.id) ?? null : JSON.stringify(config));
      });
      if (legacy.memberOverrides !== undefined) {
        db.run("UPDATE rooms SET has_overrides=? WHERE id=?", Number(Object.keys(legacy.memberOverrides).length > 0), room.id);
        db.run("DELETE FROM room_member_overrides WHERE room_id=?", room.id);
        Object.entries(legacy.memberOverrides).forEach(([label, config]) => db.run(
          "INSERT INTO room_member_overrides(room_id,member_label,config_json) VALUES (?,?,?)", room.id, label, JSON.stringify(config)));
      }
      (room.ruleDocs ?? []).forEach((path, i) => db.run("INSERT INTO room_rule_docs VALUES (?,?,?)", room.id, i, path));
    });
  }

export function readStoredRoom(id: string, db: Database = getDatabase()): Room | null {
    const row = db.get<RoomRow>("SELECT * FROM rooms WHERE id=?", id);
    if (!row) return null;
    const room: Room = {
      id, name: row.name, createdAt: row.created_at,
      members: db.all<{ label: string }>("SELECT label FROM room_member_labels WHERE room_id=? ORDER BY position", id).map(r => r.label),
      ...(row.legacy_cwd !== null ? { cwd: row.legacy_cwd } : {}),
      ...(row.docs_path !== null ? { docsPath: row.docs_path } : {}),
      ...(row.description !== null ? { description: row.description } : {}),
      ...(row.leader_member_id !== null ? { promptLeaderMemberId: row.leader_member_id } : {}),
      ...(row.leader_global_member_id !== null ? { promptLeaderGlobalMemberId: row.leader_global_member_id } : {}),
    };
    if (row.roster_kind === "global") room.globalMemberIds = db.all<{ member_id: string }>(
      "SELECT member_id FROM room_members WHERE room_id=? ORDER BY position", id).map(r => r.member_id);
    if (row.has_local_records) room.roomMembers = db.all<SnapshotRow>(
      "SELECT * FROM room_member_snapshots WHERE room_id=? ORDER BY position", id).map((m): RoomMemberRecord => ({
        id: m.id, roomId: id, name: m.name, sourceAgent: m.source_agent, createdAt: m.created_at, updatedAt: m.updated_at,
        ...(m.source_member_id !== null ? { sourceMemberId: m.source_member_id } : {}),
        ...(m.avatar !== null ? { avatar: m.avatar } : {}),
        ...(m.migrated_name !== null ? { migratedFrom: { memberName: m.migrated_name, ...(m.migrated_id !== null ? { memberId: m.migrated_id } : {}) } } : {}),
      }));
    if (row.has_rule_docs) room.ruleDocs = db.all<{ path: string }>(
      "SELECT path FROM room_rule_docs WHERE room_id=? ORDER BY position", id).map(r => r.path);
    return room;
  }

export function listStoredRooms(db: Database = getDatabase()): Room[] {
    return db.all<{ id: string }>("SELECT id FROM rooms ORDER BY created_at DESC,id").map(r => readStoredRoom(r.id, db)!);
  }

export function deleteStoredRoom(id: string, db: Database = getDatabase()): boolean {
    return db.transaction(() => {
      if (!readStoredRoom(id, db)) return false;
      db.run("DELETE FROM scopes WHERE kind='room' AND id=?", id);
      return true;
    });
  }

export function readMemberChatScopes(memberId: string, db: Database = getDatabase()): string[] {
    return db.all<{ id: string }>(
      "SELECT id FROM scopes WHERE kind='mm' AND (member_id LIKE ? OR member_id LIKE ?) ORDER BY id",
      `${memberId}|%`, `%|${memberId}`,
    ).map(r => r.id);
  }

export function listMmScopes(db: Database = getDatabase()): string[] {
    return db.all<{ id: string }>("SELECT id FROM scopes WHERE kind='mm' ORDER BY id").map(r => r.id);
  }

export function storeMemberCursor(scopeId: string, actorKey: string, value: string | null, updatedAt = Date.now(), db: Database = getDatabase()): void {
    db.run(`INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES (?,'member',?,?,?)
      ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, scopeId, actorKey, value, updatedAt);
  }

export function deleteMemberCursor(scopeId: string, actorKey: string, db: Database = getDatabase()): void {
    db.run("DELETE FROM read_cursors WHERE scope_id=? AND kind='member' AND actor_key=?", scopeId, actorKey);
  }

/** Active membership is proven by IDs, never a historical display name. */
export function listRoomsForMember(memberId: string): Room[] {
  if (!conversationMember(memberId)) return [];
  return listRooms().filter(room => getRoomMembersFromRoom(room).some(member =>
    member.id === memberId || member.sourceMemberId === memberId));
}

export type ScopeAccess =
  | { kind: "room"; roomId: string; room: Room }
  | { kind: "dm"; memberId: string }
  | { kind: "mm"; memberIds: [string, string] };

/**
 * Assert `memberId` may read `scopeId`. Returns the parsed target on success.
 * Throws Error with an explicit reason otherwise (not a member / not own DM /
 * unknown scope). Current rosters and explicit historical ID links are authoritative.
 */
export function assertMemberScopeAccess(memberId: string, scopeId: ScopeId): ScopeAccess {
  const member = conversationMember(memberId);
  if (!member) throw new Error(`Unknown member: ${memberId}`);
  if (scopeId.startsWith("dm:")) {
    const target = scopeId.slice("dm:".length);
    if (target !== memberId) throw new Error("Access denied: a member can only read its own DM scope");
    return { kind: "dm", memberId: target };
  }
  if (isMmScopeId(scopeId)) {
    const pair = parseMmScopeId(scopeId);
    if (!pair) throw new Error(`Malformed member chat scope: ${scopeId}`);
    if (!pair.includes(memberId)) throw new Error("Access denied: a member can only read its own member chats");
    return { kind: "mm", memberIds: pair };
  }
  if (scopeId.startsWith("room:")) {
    const roomId = scopeId.slice("room:".length);
    const room = listRoomsForMember(memberId).find((r) => r.id === roomId);
    if (!room) throw new Error(`Access denied: ${member.name} is not a member of room ${roomId} (or the room does not exist)`);
    return { kind: "room", roomId, room };
  }
  throw new Error(`scope must be 'room:<id>', 'dm:<memberId>' or 'mm:<memberA>-<memberB>', got: ${scopeId}`);
}

/** Read/modify/write one room under the caller's transaction or a new synchronous one. */
function changeRoom(id: string, change: (room: Room) => void): Room | null {
  return getDatabase().transaction(() => {
    const room = getRoom(id);
    if (!room) return null;
    change(room);
    writeRoom(room);
    return room;
  });
}
function changeRuleDocPaths(matches: (path: string) => boolean, replace: (path: string) => string | undefined, unique = true): number {
  return getDatabase().transaction(() => {
    let affected = 0;
    for (const room of listStoredRooms()) {
      if (!room.ruleDocs?.some(matches)) continue;
      const next = room.ruleDocs.map(path => matches(path) ? replace(path) : path);
      const filtered = next.filter((path): path is string => path !== undefined);
      const retained = unique ? [...new Set(filtered)] : filtered;
      if (retained.length) room.ruleDocs = retained;
      else delete room.ruleDocs;
      storeRoom(serializeRoom(room));
      affected++;
    }
    return affected;
  });
}
