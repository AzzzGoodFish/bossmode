import type { Database } from "../database.js";
import { validateArchivePath } from "./member-archives.js";
import type { MemberGlobalConfig, MemberRecord } from "../../workspace/member-registry.js";

interface MemberRow {
  id: string; name: string; title: string | null; agent_template: string;
  global_json: string; created_at: number; updated_at: number;
}
function decode(row: MemberRow): MemberRecord {
  const global = JSON.parse(row.global_json);
  if (!global || typeof global !== "object" || Array.isArray(global)) throw new Error(`Invalid member configuration: ${row.id}`);
  return { id: row.id, name: row.name, ...(row.title ? { title: row.title } : {}),
    agentTemplate: row.agent_template, global, unifiedModel: true, unifiedExtensions: true,
    scopeOverrides: {}, createdAt: row.created_at, updatedAt: row.updated_at };
}
function encode(config: MemberGlobalConfig): string {
  const { extensions: _retired, ...retained } = config as MemberGlobalConfig & {extensions?: unknown};
  return JSON.stringify(retained);
}

/** Identity SQL only. Name policy, asset preparation and notifications belong to services. */
export class MembersRepository {
  constructor(private readonly db: Database) {}
  get(id: string): MemberRecord | null {
    const row = this.db.get<MemberRow>("SELECT * FROM members WHERE id=? AND archived_at IS NULL", id);
    return row ? decode(row) : null;
  }
  getRetained(id: string): MemberRecord | null {
    const row = this.db.get<MemberRow>("SELECT * FROM members WHERE id=?", id);
    return row ? decode(row) : null;
  }
  findByNameKey(key: string): MemberRecord | null {
    const row = this.db.get<MemberRow>("SELECT * FROM members WHERE name_key=? AND archived_at IS NULL", key);
    return row ? decode(row) : null;
  }
  list(): MemberRecord[] { return this.db.all<MemberRow>("SELECT * FROM members WHERE archived_at IS NULL").map(decode); }
  insert(record: MemberRecord): void {
    this.db.run("INSERT INTO members(id,name,name_key,title,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      record.id, record.name, record.name.toLowerCase(), record.title || null,
      record.agentTemplate, encode(record.global), record.createdAt, record.updatedAt);
  }
  /** Strict startup tombstone import. Historical labels may already be reused by a live identity. */
  importArchived(record: MemberRecord, path: string, timestamp: number): void {
    validateArchivePath(path);
    if (!Number.isSafeInteger(timestamp)) throw new Error("invalid_archive_timestamp");
    this.db.run(`INSERT INTO members(id,name,name_key,title,agent_template,global_json,created_at,updated_at,archived_at,archive_path)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, record.id, record.name, record.name.toLowerCase(), record.title || null,
      record.agentTemplate, encode(record.global), record.createdAt, record.updatedAt, timestamp, path);
  }
  update(record: MemberRecord): void {
    this.db.run("UPDATE members SET name=?,name_key=?,title=?,agent_template=?,global_json=?,created_at=?,updated_at=? WHERE id=? AND archived_at IS NULL",
      record.name, record.name.toLowerCase(), record.title || null, record.agentTemplate,
      encode(record.global), record.createdAt, record.updatedAt, record.id);
  }
  archivedPath(id: string): string | null {
    return this.db.get<{archive_path: string|null}>("SELECT archive_path FROM members WHERE id=?", id)?.archive_path ?? null;
  }
  archive(id: string, path: string, timestamp: number): void {
    validateArchivePath(path);
    if (!Number.isSafeInteger(timestamp)) throw new Error("invalid_archive_timestamp");
    this.db.run("UPDATE members SET archived_at=?,archive_path=? WHERE id=? AND archived_at IS NULL", timestamp, path, id);
  }
  delete(id: string): void { this.db.run("DELETE FROM members WHERE id=?", id); }
}
