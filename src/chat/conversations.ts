import { documentsRoot, memberDir, roomDir } from "../files/layout.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
export interface RoomMember { id: string; name: string }
export interface Room {
  id: string;
  name: string;
  memberIds: string[];
  promptLeaderMemberId?: string;
  docsPath?: string;
  description?: string;
  createdAt: number;
  ruleDocs?: string[];
}
import { newRoomId } from "../kernel/ids.js";
import { getDatabase, type Database } from "../data/database.js";
import type { AttachmentLocation } from "../files/attachments.js";

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
  return memberAssetRoots(room.memberIds);
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
  for (let attempts = 0; attempts < 10 && (getRoom(id, repository) || existsSync(roomDir(id))); attempts++) id = newRoomId();
  const room: Room = {
    id, name, memberIds: ids,
    ...(leader ? { promptLeaderMemberId: leader } : {}),
    docsPath: normalizeRoomDocsPath(opts?.docsPath) || slugifyRoomDocsPath(name),
    ...(roomDescription ? { description: roomDescription } : {}),
    createdAt: Date.now(),
  };
  // Working directories belong to member workspaces; cwd is not persisted.
  mkdirSync(roomDir(room.id), { recursive: true });
  if (room.docsPath) mkdirSync(join(documentsRoot(), room.docsPath), { recursive: true });
  repository.transaction(() => {
    storeRoom(room);
    for (const id of ids) storeMemberCursor(room.id, id, null, undefined, repository);
  });
  return room;
}

export function deleteRoom(roomId: string): boolean {
  const removed = getDatabase().transaction(db => {
    if (!getRoom(roomId, db)) return false;
    db.run("DELETE FROM scopes WHERE kind='room' AND id=?", roomId);
    return true;
  });
  if (removed) rmSync(roomDir(roomId), { recursive: true, force: true });
  return removed;
}

export function updateRoom(roomId: string, patch: {
  name?: string; description?: string | null; promptLeaderMemberId?: string | null; docsPath?: string | null;
}): Room | null {
  if (!Object.keys(patch).length) throw new Error("Nothing to update");
  return changeRoom(roomId, room => {
    if (Object.hasOwn(patch, "name")) {
      const name = patch.name?.trim();
      if (!name) throw new Error("Room name is required");
      room.name = name;
    }
    if (Object.hasOwn(patch, "description")) {
      const description = String(patch.description ?? "").trim();
      if (description.length > ROOM_DESCRIPTION_MAX_CHARS) throw new Error(`description must be ${ROOM_DESCRIPTION_MAX_CHARS} characters or fewer`);
      if (description) room.description = description; else delete room.description;
    }
    if (Object.hasOwn(patch, "promptLeaderMemberId")) {
      const leader = patch.promptLeaderMemberId;
      if (leader && !room.memberIds.includes(leader)) throw new Error("promptLeaderMemberId must be a current room member");
      if (leader) room.promptLeaderMemberId = leader; else delete room.promptLeaderMemberId;
    }
    if (Object.hasOwn(patch, "docsPath")) {
      const path = normalizeRoomDocsPath(patch.docsPath);
      if (path) room.docsPath = path; else delete room.docsPath;
    }
  });
}

export function getRoomMembers(roomId: string): RoomMember[] {
  const room = getRoom(roomId);
  return room ? room.memberIds.flatMap(id => {
    const member = conversationMember(id);
    return member ? [{ id: member.id, name: member.name }] : [];
  }) : [];
}

export function resolveRoomMember(roomId: string, memberId: string): RoomMember | null {
  return getRoomMembers(roomId).find(member => member.id === memberId) ?? null;
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
export function updateRuleDocPathsByPrefix(oldPrefix: string, newPrefix?: string): number {
  if (!oldPrefix) return 0;
  return changeRuleDocPaths(path => path === oldPrefix || path.startsWith(oldPrefix + "/"),
    path => newPrefix ? newPrefix + path.slice(oldPrefix.length) : undefined);
}

/** ⑤ A: room description (name + description) — product cap on every write. */
export const ROOM_DESCRIPTION_MAX_CHARS = 2000;

/** Member↔member chat scopes involving `memberId` (⑤ B). */
export function listMmScopesForMember(memberId: string): string[] {
  return getDatabase().all<{ id: string }>(
    "SELECT id FROM scopes WHERE kind='mm' AND (member_id LIKE ? OR member_id LIKE ?) ORDER BY id",
    `${memberId}|%`, `%|${memberId}`,
  ).map(row => row.id);
}

// -- Member management --

function initializeMemberCursor(roomId: string, memberId: string): void {
  // Initialize cursor at the latest durable fact under the stable member ID.
  const latestId = getDatabase().get<{ id: string }>(
    "SELECT id FROM messages WHERE scope_id=? ORDER BY seq DESC LIMIT 1", roomId,
  )?.id ?? null;
  storeMemberCursor(roomId, memberId, latestId);
}

/**
 * 0.20 invite: attach an existing global member to a room (by mem_ id).
 * Uses stable identity from the member registry and replaces relational membership.
 */
export function inviteRoomMember(
  roomId: string,
  memberId: string,
): { ok: true; member: RoomMember } | { ok: false; error: string; code: "not_found" | "duplicate" } {
  return getDatabase().transaction((): ReturnType<typeof inviteRoomMember> => {
    const room = getRoom(roomId);
    if (!room) return { ok: false, code: "not_found", error: "Room not found" };
    if (room.memberIds.includes(memberId)) return { ok: false, code: "duplicate", error: "Member already in this room" };
    const identity = conversationMember(memberId);
    if (!identity) return { ok: false, code: "not_found", error: "Member not found" };
    room.memberIds.push(memberId);
    storeRoom(room);
    initializeMemberCursor(roomId, memberId);
    return { ok: true, member: { id: memberId, name: identity.name } };
  });
}

export function removeRoomMember(
  roomId: string,
  memberId: string,
): { ok: true; removed: RoomMember } | { ok: false; error: string } {
  return getDatabase().transaction((): ReturnType<typeof removeRoomMember> => {
    const room = getRoom(roomId);
    if (!room) return { ok: false, error: "Room not found" };
    const member = resolveRoomMember(roomId, memberId);
    if (!member) return { ok: false, error: "Member is not in this room" };
    room.memberIds = room.memberIds.filter(id => id !== memberId);
    if (room.promptLeaderMemberId === memberId) delete room.promptLeaderMemberId;
    storeRoom(room);
    deleteMemberCursor(roomId, memberId);
    return { ok: true, removed: member };
  });
}

/** Remove active membership while retaining imported historical snapshots. */
export function detachMemberFromConversations(memberId: string, db: Database): void {
  for (const room of listRooms(db)) {
    if (!room.memberIds.includes(memberId) && room.promptLeaderMemberId !== memberId) continue;
    room.memberIds = room.memberIds.filter(id => id !== memberId);
    if (room.promptLeaderMemberId === memberId) delete room.promptLeaderMemberId;
    storeRoom(room, db);
    deleteMemberCursor(room.id, memberId, db);
  }
}

export interface ConversationMemberIdentity { id: string; name: string }

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
/** Canonical conversation identity used by all new chat capabilities. Bare room
 * ids remain the storage key; public/source refs always use `room:<id>`. */
export type ConversationIdentity =
  | { kind: "room"; scopeId: string; roomId: string }
  | { kind: "dm"; scopeId: string; memberId: string }
  | { kind: "mm"; scopeId: string; memberIds: [string, string] };

/**
 * Member↔member private chat scope (⑤ B, 2026-09-15): `mm:` + the two member ids
 * sorted and joined by a single dash. `mem_` appears exactly once per id in both
 * generations (legacy `mem_<uuid>` ids keep their dashes; current ids are
 * `mem_<nanoid10>`), so the pair splits at the second `mem_` occurrence; canonical
 * order is enforced on parse.
 */
export function mmScopeIdOf(memberA: string, memberB: string): string {
  if (!memberA || !memberB || memberA === memberB) throw new Error("mm scope requires two distinct member ids");
  const [a, b] = memberA < memberB ? [memberA, memberB] : [memberB, memberA];
  return `mm:${a}-${b}`;
}

/** Parse a `mm:` scope id into its canonical [memberA, memberB] pair, or null. */
export function parseMmScopeId(scope: string): [string, string] | null {
  if (typeof scope !== "string" || !scope.startsWith("mm:")) return null;
  const body = scope.slice(3);
  const second = body.indexOf("mem_", 1);
  if (second <= 0 || body[second - 1] !== "-") return null;
  const a = body.slice(0, second - 1);
  const b = body.slice(second);
  if (!isMemberId(a) || !isMemberId(b) || a === b) return null;
  const [x, y] = a < b ? [a, b] : [b, a];
  return x === a && y === b ? [x, y] : null;
}

export function isMmScopeId(scope: string): boolean {
  return typeof scope === "string" && scope.startsWith("mm:");
}

function validRoomId(value: string): boolean {
  return Boolean(value && !value.includes(":") && !/[/\\\0]/.test(value) && ![".", ".."].includes(value));
}

/** Parse only canonical public/source refs. */
export function parseConversation(value: string): ConversationIdentity | null {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  if (value.startsWith("dm:")) {
    const memberId = value.slice(3);
    return isMemberId(memberId) ? { kind: "dm", scopeId: value, memberId } : null;
  }
  if (value.startsWith("mm:")) {
    const memberIds = parseMmScopeId(value);
    return memberIds ? { kind: "mm", scopeId: value, memberIds } : null;
  }
  if (!value.startsWith("room:")) return null;
  const roomId = value.slice(5);
  return validRoomId(roomId) ? { kind: "room", scopeId: value, roomId } : null;
}

export function resolveConversation(value: string): ConversationIdentity | null {
  const ref = parseConversation(value);
  if (!ref) return null;
  if (ref.kind === "room") return getRoom(ref.roomId) ? ref : null;
  if (ref.kind === "dm") return conversationMember(ref.memberId) ? ref : null;
  return ref.memberIds.every(id => conversationMember(id)) ? ref : null;
}
export function attachmentLocation(ref: ConversationIdentity): AttachmentLocation {
  if (ref.kind === "room") return { kind: "room", roomId: ref.roomId };
  if (ref.kind === "dm") return { kind: "dm", memberId: ref.memberId };
  return { kind: "mm", memberIds: ref.memberIds };
}

/** Convert a canonical source or an internal bare room key to the database key. */
export function storageScopeId(value: string): string {
  if (validRoomId(value)) return value;
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
  name: string; created_at: number; docs_path: string | null; description: string | null;
  leader_member_id: string | null; leader_global_member_id: string | null; has_rule_docs: number;
}

export interface LegacyRoomImport {
  id: string; name: string; createdAt: number; cwd?: string; members?: string[];
  globalMemberIds?: string[]; promptLeaderMemberId?: string; promptLeaderGlobalMemberId?: string;
  docsPath?: string; description?: string; ruleDocs?: string[];
  roomMembers?: Array<{
    id: string; name: string; sourceAgent: string; sourceMemberId?: string; avatar?: string;
    createdAt: number; updatedAt: number; migratedFrom?: { memberName: string; memberId?: string }; config?: unknown;
  }>;
  memberOverrides?: Record<string, unknown>;
}

/** Historical references deliberately have no FK to live members. Never resolve names here. */
function ensureConversationScope(id: string, kind: ScopeRow["kind"], roomId: string | null, memberId: string | null, db: Database = getDatabase()): void {
  const previous = db.get<ScopeRow>("SELECT * FROM scopes WHERE id=?", id);
  if (previous) {
    if (previous.kind !== kind || previous.room_id !== roomId || previous.member_id !== memberId) throw new Error(`Scope ownership cannot change: ${id}`);
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

/** Persist current room state without rewriting imported historical snapshots. */
export function storeRoom(room: Room, db: Database = getDatabase()): void {
  if (!room.id || room.id.startsWith("room:") || room.id.startsWith("dm:")) throw new Error("Room scope must use the bare room ID");
  db.transaction(() => {
    ensureConversationScope(room.id, "room", room.id, null, db);
    db.run(`INSERT INTO rooms(id,name,created_at,legacy_cwd,docs_path,description,leader_member_id,leader_global_member_id,
        roster_kind,has_local_records,has_rule_docs,has_overrides) VALUES (?,?,?,NULL,?,?,?,NULL,'global',0,?,0)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,docs_path=excluded.docs_path,description=excluded.description,
        leader_member_id=excluded.leader_member_id,roster_kind='global',has_rule_docs=excluded.has_rule_docs`,
        room.id, room.name, room.createdAt, room.docsPath ?? null, room.description ?? null, room.promptLeaderMemberId ?? null,
        Number(Boolean(room.ruleDocs?.length)));
      db.run("DELETE FROM room_members WHERE room_id=?", room.id);
      [...new Set(room.memberIds)].forEach((id, i) => db.run("INSERT INTO room_members VALUES (?,?,?)", room.id, id, i));
      db.run("DELETE FROM room_rule_docs WHERE room_id=?", room.id);
    (room.ruleDocs ?? []).forEach((path, i) => db.run("INSERT INTO room_rule_docs VALUES (?,?,?)", room.id, i, path));
  });
}

/** Import legacy labels and snapshots without making them active members. */
export function importLegacyRoom(room: LegacyRoomImport, db: Database = getDatabase()): void {
  if (!room.id || room.id.startsWith("room:") || room.id.startsWith("dm:")) throw new Error("Room scope must use the bare room ID");
  db.transaction(() => {
    ensureConversationScope(room.id, "room", room.id, null, db);
    db.run(`INSERT INTO rooms(id,name,created_at,legacy_cwd,docs_path,description,leader_member_id,leader_global_member_id,
      roster_kind,has_local_records,has_rule_docs,has_overrides) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,created_at=excluded.created_at,legacy_cwd=excluded.legacy_cwd,
      docs_path=excluded.docs_path,description=excluded.description,leader_member_id=excluded.leader_member_id,
      leader_global_member_id=excluded.leader_global_member_id,roster_kind=excluded.roster_kind,
      has_local_records=excluded.has_local_records,has_rule_docs=excluded.has_rule_docs`,
      room.id, room.name, room.createdAt, room.cwd ?? null, room.docsPath ?? null, room.description ?? null,
      room.promptLeaderMemberId ?? null, room.promptLeaderGlobalMemberId ?? null,
      Array.isArray(room.globalMemberIds) ? "global" : Array.isArray(room.roomMembers) ? "local" : "names",
      Number(Array.isArray(room.roomMembers)), Number(Boolean(room.ruleDocs?.length)), Number(room.memberOverrides !== undefined));
    for (const table of ["room_members", "room_member_labels", "room_member_snapshots", "room_rule_docs"]) db.run(`DELETE FROM ${table} WHERE room_id=?`, room.id);
    [...new Set(room.globalMemberIds ?? [])].forEach((id, i) => db.run("INSERT INTO room_members VALUES (?,?,?)", room.id, id, i));
    (room.members ?? []).forEach((label, i) => db.run("INSERT INTO room_member_labels VALUES (?,?,?)", room.id, i, label));
    (room.roomMembers ?? []).forEach((member, i) => db.run(`INSERT INTO room_member_snapshots
      (room_id,position,id,name,source_agent,source_member_id,avatar,created_at,updated_at,migrated_name,migrated_id,config_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, room.id, i, member.id, member.name, member.sourceAgent, member.sourceMemberId ?? null,
      member.avatar ?? null, member.createdAt, member.updatedAt, member.migratedFrom?.memberName ?? null,
      member.migratedFrom?.memberId ?? null, member.config === undefined ? null : JSON.stringify(member.config)));
    if (room.memberOverrides !== undefined) {
      db.run("UPDATE rooms SET has_overrides=? WHERE id=?", Number(Object.keys(room.memberOverrides).length > 0), room.id);
      db.run("DELETE FROM room_member_overrides WHERE room_id=?", room.id);
      Object.entries(room.memberOverrides).forEach(([label, config]) => db.run(
        "INSERT INTO room_member_overrides(room_id,member_label,config_json) VALUES (?,?,?)", room.id, label, JSON.stringify(config)));
    }
    (room.ruleDocs ?? []).forEach((path, i) => db.run("INSERT INTO room_rule_docs VALUES (?,?,?)", room.id, i, path));
  });
}

export function getRoom(id: string, db: Database = getDatabase()): Room | null {
  const row = db.get<RoomRow>("SELECT * FROM rooms WHERE id=?", id);
  if (!row) return null;
  const room: Room = {
    id, name: row.name, createdAt: row.created_at,
    memberIds: db.all<{ member_id: string }>("SELECT member_id FROM room_members WHERE room_id=? ORDER BY position", id).map(item => item.member_id),
    ...(row.docs_path !== null ? { docsPath: row.docs_path } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    ...((row.leader_member_id ?? row.leader_global_member_id) !== null
      ? { promptLeaderMemberId: row.leader_member_id ?? row.leader_global_member_id! } : {}),
  };
  if (row.has_rule_docs) room.ruleDocs = db.all<{ path: string }>(
    "SELECT path FROM room_rule_docs WHERE room_id=? ORDER BY position", id).map(item => item.path);
  return room;
}

export function listRooms(db: Database = getDatabase()): Room[] {
  return db.all<{ id: string }>("SELECT id FROM rooms ORDER BY created_at DESC,id").map(row => getRoom(row.id, db)!);
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
  return listRooms().filter(room => room.memberIds.includes(memberId));
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
export function assertMemberScopeAccess(memberId: string, scopeId: string): ScopeAccess {
  if (!conversationMember(memberId)) throw new Error(`Unknown member: ${memberId}`);
  const ref = parseConversation(scopeId);
  if (!ref) throw new Error(`Invalid conversation source: ${scopeId}`);
  if (ref.kind === "dm") {
    if (ref.memberId !== memberId) throw new Error("Access denied: a member can only read its own DM scope");
    return ref;
  }
  if (ref.kind === "mm") {
    if (!ref.memberIds.includes(memberId)) throw new Error("Access denied: a member can only read its own member chats");
    return ref;
  }
  const room = getRoom(ref.roomId);
  if (!room?.memberIds.includes(memberId)) {
    throw new Error(`Access denied: member is not in room ${ref.roomId}`);
  }
  return { kind: "room", roomId: ref.roomId, room };
}

/** Read/modify/write one room under the caller's transaction or a new synchronous one. */
function changeRoom(id: string, change: (room: Room) => void): Room | null {
  return getDatabase().transaction(() => {
    const room = getRoom(id);
    if (!room) return null;
    change(room);
    storeRoom(room);
    return room;
  });
}
function changeRuleDocPaths(matches: (path: string) => boolean, replace: (path: string) => string | undefined, unique = true): number {
  return getDatabase().transaction(() => {
    let affected = 0;
    for (const room of listRooms()) {
      if (!room.ruleDocs?.some(matches)) continue;
      const next = room.ruleDocs.map(path => matches(path) ? replace(path) : path);
      const filtered = next.filter((path): path is string => path !== undefined);
      const retained = unique ? [...new Set(filtered)] : filtered;
      if (retained.length) room.ruleDocs = retained;
      else delete room.ruleDocs;
      storeRoom(room);
      affected++;
    }
    return affected;
  });
}
