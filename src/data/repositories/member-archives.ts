import { posix } from "node:path";
import type { Database } from "../database.js";
import type { MemberGlobalConfig } from "../types.js";
export interface ArchiveCatalogSource {
  archivePath: string;
  name: string;
  /** Only explicit, verified retained SQL identity. Name-only sources must omit this. */
  memberId?: string;
  kind: "legacy" | "fired";
  template: string;
  title?: string;
  global: MemberGlobalConfig;
  /** Relative to data root, inside archivePath; no filename search at runtime. */
  personaPath?: string;
  personaFormat: "plain" | "frontmatter";
  hasPersona: boolean;
  roomScopes: Array<{ room: string; hasPrinciples: boolean; hasMainline: boolean }>;
  conflicts?: string[];
}
export interface MemberArchiveIntent {
  memberId: string; sourcePath: string; archivePath: string;
  sourceDevice: string; sourceInode: string;
  state: "pending" | "completed"; createdAt: number; completedAt: number | null;
}
export function validateArchivePath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("backups/") || path === "backups/" ||
    path.includes("\\") || path.includes("\0") || posix.normalize(path) !== path || path.split("/").includes("..")) {
    throw new Error("invalid_archive_path");
  }
}
export class MemberArchivesRepository {
  constructor(private readonly db: Database) {}
  intent(memberId: string): MemberArchiveIntent | null {
    return this.db.get<MemberArchiveIntent>(`SELECT member_id AS memberId,source_path AS sourcePath,archive_path AS archivePath,
      source_device AS sourceDevice,source_inode AS sourceInode,state,created_at AS createdAt,completed_at AS completedAt
      FROM member_archive_intents WHERE member_id=?`, memberId) ?? null;
  }
  pending(): MemberArchiveIntent[] {
    return this.db.all<{member_id:string}>("SELECT member_id FROM member_archive_intents WHERE state='pending' ORDER BY created_at,member_id")
      .map(r => this.intent(r.member_id)!);
  }
  begin(intent: Omit<MemberArchiveIntent, "state" | "completedAt">): void {
    validateArchivePath(intent.archivePath);
    if (!/^mem_[a-zA-Z0-9_-]+$/.test(intent.memberId) || intent.sourcePath !== `members/${intent.memberId}` ||
      !/^\d+$/.test(intent.sourceDevice) || !/^\d+$/.test(intent.sourceInode)) throw new Error("invalid_archive_intent");
    this.db.run(`INSERT INTO member_archive_intents VALUES(?,?,?,?,?,'pending',?,NULL)`,
      intent.memberId, intent.sourcePath, intent.archivePath, intent.sourceDevice, intent.sourceInode, intent.createdAt);
  }
  complete(memberId: string, timestamp: number): void {
    this.db.run("UPDATE member_archive_intents SET state='completed',completed_at=? WHERE member_id=? AND state='pending'", timestamp, memberId);
  }
  /** Strict SQL-only startup import. Conflicts fail; never opens files or maps labels to IDs. */
  importCatalog(source: ArchiveCatalogSource): void {
    validateArchivePath(source.archivePath);
    if (!source.name || !source.template || !source.global || typeof source.global !== "object" || Array.isArray(source.global)) throw new Error("invalid_archive_catalog");
    if (source.personaPath) {
      validateArchivePath(source.personaPath);
      if (!source.personaPath.startsWith(`${source.archivePath}/`)) throw new Error("archive_persona_outside_root");
    }
    this.db.transaction(tx => {
      if (source.memberId && !tx.get("SELECT id FROM members WHERE id=? AND archived_at IS NOT NULL AND archive_path=?", source.memberId, source.archivePath)) {
        throw new Error("archive_identity_not_retained");
      }
      tx.run("INSERT INTO member_archives VALUES(?,?,?,?,?,?,?,?,?,?)", source.archivePath, source.name, source.memberId ?? null,
        source.kind, source.template, source.title ?? null, JSON.stringify(source.global), source.personaPath ?? null,
        source.personaFormat, Number(source.hasPersona));
      source.roomScopes.forEach((r,i) => tx.run("INSERT INTO member_archive_rooms VALUES(?,?,?,?,?,?)", source.archivePath, source.name, i, r.room, Number(r.hasPrinciples), Number(r.hasMainline)));
      source.conflicts?.forEach((c,i) => tx.run("INSERT INTO member_archive_conflicts VALUES(?,?,?,?)", source.archivePath, source.name, i, c));
    });
  }
  get(archivePath: string, name: string): ArchiveCatalogSource | null {
    const r = this.db.get<any>("SELECT * FROM member_archives WHERE archive_path=? AND source_name=?", archivePath, name);
    if (!r) return null;
    const conflicts = this.db.all<{conflict:string}>("SELECT conflict FROM member_archive_conflicts WHERE archive_path=? AND source_name=? ORDER BY position", archivePath, name).map(r => r.conflict);
    return {archivePath, name, ...(r.member_id ? {memberId:r.member_id} : {}), kind:r.kind, template:r.template,
      ...(r.title !== null ? {title:r.title} : {}), global:JSON.parse(r.global_json),
      ...(r.persona_path !== null ? {personaPath:r.persona_path} : {}), personaFormat:r.persona_format, hasPersona:!!r.has_persona,
      roomScopes:this.db.all<any>("SELECT * FROM member_archive_rooms WHERE archive_path=? AND source_name=? ORDER BY position", archivePath, name)
        .map(r => ({room:r.room, hasPrinciples:!!r.has_principles, hasMainline:!!r.has_mainline})),
      ...(conflicts.length ? {conflicts} : {})};
  }
  list(): ArchiveCatalogSource[] {
    return this.db.all<{archive_path:string;source_name:string}>("SELECT archive_path,source_name FROM member_archives ORDER BY source_name,archive_path")
      .map(r => this.get(r.archive_path, r.source_name)!);
  }
}
