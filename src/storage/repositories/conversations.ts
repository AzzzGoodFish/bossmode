import { getDatabase, type Database } from "../database.js";
import type { Room, RoomMemberRecord, CursorMap } from "../../shared/types.js";
import type { TopicRecord, TopicStatus } from "../../workspace/topic-store.js";

interface ScopeRow { id: string; kind: "room" | "topic" | "dm"; room_id: string | null; member_id: string | null }
interface RoomRow {
  id: string; name: string; created_at: number; legacy_cwd: string | null;
  docs_path: string | null; leader_member_id: string | null; leader_global_member_id: string | null;
  roster_kind: "global" | "local" | "names"; has_local_records: number; has_rule_docs: number; has_overrides: number;
}
interface SnapshotRow {
  id: string; name: string; source_agent: string; source_member_id: string | null; avatar: string | null;
  created_at: number; updated_at: number; migrated_name: string | null; migrated_id: string | null; config_json: string | null;
}
interface TopicRow {
  id: string; room_id: string; title: string; anchor_message_id: string; anchor_seq: number | null;
  created_by: string; status: TopicStatus; created_at: number; closed_at: number | null;
  seed_mode: TopicRecord["seedMode"]; summary: string | null; brief: string | null; guide_text: string | null; anchor_excerpt: string | null;
}

/** Historical references deliberately have no FK to live members. Never resolve names here. */
export class ConversationsRepository {
  constructor(readonly db: Database = getDatabase()) {}

  private ensureScope(id: string, kind: ScopeRow["kind"], roomId: string | null, memberId: string | null): void {
    const previous = this.db.get<ScopeRow>("SELECT * FROM scopes WHERE id=?", id);
    if (previous) {
      if (previous.kind !== kind || previous.room_id !== roomId || previous.member_id !== memberId) {
        throw new Error(`Scope ownership cannot change: ${id}`);
      }
      return;
    }
    this.db.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES (?,?,?,?)", id, kind, roomId, memberId);
  }

  /** Explicit integration point for member creation/import, in the caller's transaction. */
  ensureDmScope(memberId: string): string {
    if (!memberId) throw new Error("DM scope requires a stable member ID");
    const id = `dm:${memberId}`;
    this.ensureScope(id, "dm", null, memberId);
    return id;
  }

  /** Pure import/upsert: preserves source IDs, timestamps, labels and absent vs empty rosters. */
  upsertRoom(room: Room): void {
    if (!room.id || room.id.startsWith("room:") || room.id.startsWith("topic:") || room.id.startsWith("dm:")) {
      throw new Error("Room scope must use the bare room ID");
    }
    this.db.transaction(() => {
      this.ensureScope(room.id, "room", room.id, null);
      this.db.run(`INSERT INTO rooms(id,name,created_at,legacy_cwd,docs_path,leader_member_id,leader_global_member_id,
        roster_kind,has_local_records,has_rule_docs,has_overrides) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,created_at=excluded.created_at,legacy_cwd=excluded.legacy_cwd,
        docs_path=excluded.docs_path,leader_member_id=excluded.leader_member_id,leader_global_member_id=excluded.leader_global_member_id,
        roster_kind=excluded.roster_kind,has_local_records=excluded.has_local_records,has_rule_docs=excluded.has_rule_docs,has_overrides=excluded.has_overrides`,
        room.id, room.name, room.createdAt, room.cwd ?? null, room.docsPath ?? null, room.promptLeaderMemberId ?? null,
        room.promptLeaderGlobalMemberId ?? null, Array.isArray(room.globalMemberIds) ? "global" : Array.isArray(room.roomMembers) ? "local" : "names",
        Number(Array.isArray(room.roomMembers)), Number(Array.isArray(room.ruleDocs)), Number(room.memberOverrides !== undefined));
      for (const table of ["room_members", "room_member_labels", "room_member_snapshots", "room_member_overrides", "room_rule_docs"]) {
        this.db.run(`DELETE FROM ${table} WHERE room_id=?`, room.id);
      }
      [...new Set(room.globalMemberIds ?? [])].forEach((id, i) => this.db.run("INSERT INTO room_members VALUES (?,?,?)", room.id, id, i));
      (room.members ?? []).forEach((label, i) => this.db.run("INSERT INTO room_member_labels VALUES (?,?,?)", room.id, i, label));
      (room.roomMembers ?? []).forEach((m, i) => this.db.run(`INSERT INTO room_member_snapshots
        (room_id,position,id,name,source_agent,source_member_id,avatar,created_at,updated_at,migrated_name,migrated_id,config_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, room.id, i, m.id, m.name, m.sourceAgent, m.sourceMemberId ?? null,
        m.avatar ?? null, m.createdAt, m.updatedAt, m.migratedFrom?.memberName ?? null, m.migratedFrom?.memberId ?? null,
        m.config === undefined ? null : JSON.stringify(m.config)));
      Object.entries(room.memberOverrides ?? {}).forEach(([label, config]) => this.db.run(
        "INSERT INTO room_member_overrides(room_id,member_label,config_json) VALUES (?,?,?)", room.id, label, JSON.stringify(config)));
      (room.ruleDocs ?? []).forEach((path, i) => this.db.run("INSERT INTO room_rule_docs VALUES (?,?,?)", room.id, i, path));
    });
  }

  getRoom(id: string): Room | null {
    const row = this.db.get<RoomRow>("SELECT * FROM rooms WHERE id=?", id);
    if (!row) return null;
    const room: Room = {
      id, name: row.name, createdAt: row.created_at,
      members: this.db.all<{ label: string }>("SELECT label FROM room_member_labels WHERE room_id=? ORDER BY position", id).map(r => r.label),
      ...(row.legacy_cwd !== null ? { cwd: row.legacy_cwd } : {}),
      ...(row.docs_path !== null ? { docsPath: row.docs_path } : {}),
      ...(row.leader_member_id !== null ? { promptLeaderMemberId: row.leader_member_id } : {}),
      ...(row.leader_global_member_id !== null ? { promptLeaderGlobalMemberId: row.leader_global_member_id } : {}),
    };
    if (row.roster_kind === "global") room.globalMemberIds = this.db.all<{ member_id: string }>(
      "SELECT member_id FROM room_members WHERE room_id=? ORDER BY position", id).map(r => r.member_id);
    if (row.has_local_records) room.roomMembers = this.db.all<SnapshotRow>(
      "SELECT * FROM room_member_snapshots WHERE room_id=? ORDER BY position", id).map((m): RoomMemberRecord => ({
        id: m.id, roomId: id, name: m.name, sourceAgent: m.source_agent, createdAt: m.created_at, updatedAt: m.updated_at,
        ...(m.source_member_id !== null ? { sourceMemberId: m.source_member_id } : {}),
        ...(m.avatar !== null ? { avatar: m.avatar } : {}),
        ...(m.config_json !== null ? { config: JSON.parse(m.config_json) } : {}),
        ...(m.migrated_name !== null ? { migratedFrom: { memberName: m.migrated_name, ...(m.migrated_id !== null ? { memberId: m.migrated_id } : {}) } } : {}),
      }));
    if (row.has_rule_docs) room.ruleDocs = this.db.all<{ path: string }>(
      "SELECT path FROM room_rule_docs WHERE room_id=? ORDER BY position", id).map(r => r.path);
    if (row.has_overrides) room.memberOverrides = Object.fromEntries(this.db.all<{ member_label: string; config_json: string }>(
      "SELECT member_label,config_json FROM room_member_overrides WHERE room_id=?", id).map(r => [r.member_label, JSON.parse(r.config_json)]));
    return room;
  }

  listRooms(): Room[] {
    return this.db.all<{ id: string }>("SELECT id FROM rooms ORDER BY created_at DESC,id").map(r => this.getRoom(r.id)!);
  }

  deleteRoom(id: string): boolean {
    return this.db.transaction(() => {
      if (!this.getRoom(id)) return false;
      // Topic scopes do not FK to rooms in the common schema. Delete them explicitly.
      this.db.run("DELETE FROM scopes WHERE kind='topic' AND room_id=?", id);
      this.db.run("DELETE FROM scopes WHERE kind='room' AND id=?", id);
      return true;
    });
  }

  upsertTopic(t: TopicRecord): void {
    this.db.transaction(() => {
      this.ensureScope(`topic:${t.id}`, "topic", t.roomId, null);
      this.db.run(`INSERT INTO topics(id,scope_id,room_id,title,anchor_message_id,anchor_seq,created_by,status,
        created_at,closed_at,seed_mode,summary,brief,guide_text,anchor_excerpt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,anchor_message_id=excluded.anchor_message_id,anchor_seq=excluded.anchor_seq,
        created_by=excluded.created_by,status=excluded.status,created_at=excluded.created_at,closed_at=excluded.closed_at,
        seed_mode=excluded.seed_mode,summary=excluded.summary,brief=excluded.brief,guide_text=excluded.guide_text,anchor_excerpt=excluded.anchor_excerpt`,
        t.id, `topic:${t.id}`, t.roomId, t.title, t.anchorMessageId, t.anchorSeq ?? null, t.createdBy, t.status,
        t.createdAt, t.closedAt ?? null, t.seedMode, t.summary ?? null, t.brief ?? null, t.guideText ?? null, t.anchorExcerpt ?? null);
      this.db.run("DELETE FROM topic_participants WHERE topic_id=?", t.id);
      t.participants.forEach((ref, i) => this.db.run("INSERT INTO topic_participants VALUES (?,?,?)", t.id, i, ref));
    });
  }

  resolveTopicRoomId(id: string): string | null {
    return this.db.get<{ room_id: string }>("SELECT room_id FROM topics WHERE id=?", id)?.room_id ?? null;
  }

  getTopic(roomId: string, id: string): TopicRecord | null {
    const t = this.db.get<TopicRow>("SELECT * FROM topics WHERE id=? AND room_id=?", id, roomId);
    if (!t) return null;
    return {
      id, roomId, title: t.title, anchorMessageId: t.anchor_message_id, createdBy: t.created_by,
      status: t.status, createdAt: t.created_at, seedMode: t.seed_mode,
      participants: this.db.all<{ member_ref: string }>("SELECT member_ref FROM topic_participants WHERE topic_id=? ORDER BY position", id).map(r => r.member_ref),
      ...(t.anchor_seq !== null ? { anchorSeq: t.anchor_seq } : {}), ...(t.closed_at !== null ? { closedAt: t.closed_at } : {}),
      ...(t.summary !== null ? { summary: t.summary } : {}), ...(t.brief !== null ? { brief: t.brief } : {}),
      ...(t.guide_text !== null ? { guideText: t.guide_text } : {}), ...(t.anchor_excerpt !== null ? { anchorExcerpt: t.anchor_excerpt } : {}),
    };
  }

  listTopics(roomId: string, status?: TopicStatus): TopicRecord[] {
    return this.db.all<{ id: string }>(`SELECT id FROM topics WHERE room_id=? ${status ? "AND status=?" : ""} ORDER BY created_at DESC,id`,
      roomId, ...(status ? [status] : [])).map(r => this.getTopic(roomId, r.id)!);
  }

  getCursors(scopeId: string): CursorMap {
    return Object.fromEntries(this.db.all<{ actor_key: string; value: string | null }>(
      "SELECT actor_key,value FROM read_cursors WHERE scope_id=? AND kind='member'", scopeId).map(r => [r.actor_key, r.value]));
  }

  setCursor(scopeId: string, actorKey: string, value: string | null, updatedAt = Date.now()): void {
    this.db.run(`INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES (?,'member',?,?,?)
      ON CONFLICT(scope_id,kind,actor_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, scopeId, actorKey, value, updatedAt);
  }

  deleteCursor(scopeId: string, actorKey: string): void {
    this.db.run("DELETE FROM read_cursors WHERE scope_id=? AND kind='member' AND actor_key=?", scopeId, actorKey);
  }
}

/** Narrow current-identity projection over the parent's authoritative member contract. */
export function getConversationMember(id: string): { id: string; name: string; agentTemplate: string; createdAt: number; updatedAt: number } | null {
  const row = getDatabase().get<{ id: string; name: string; agent_template: string; created_at: number; updated_at: number }>(
    "SELECT id,name,agent_template,created_at,updated_at FROM members WHERE id=?", id);
  return row ? { id: row.id, name: row.name, agentTemplate: row.agent_template, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

export function ensureDmScope(memberId: string): string {
  return new ConversationsRepository().ensureDmScope(memberId);
}
